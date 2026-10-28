# Entorno dev en AWS (us-east-1, dos zonas). Lo aplica GitHub Actions (.github/workflows/deploy.yml);
# nadie lo aplica a mano. Reutiliza los módulos del entorno local y agrega lo que en local se emula.
#
# MVP desplegado: frontend en S3 + CloudFront, login con Cognito, REST API + Lambda, notas y
# comunidades en Aurora (Data API), colas SQS con DLQ, EventBridge, DynamoDB, S3 y monitoreo.
# Fase 2 (diseñado, no desplegado): IVS e IVS Chat, WebSocket API, Web Push, AWS Backup.

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { proyecto = "streamnote", entorno = var.stage }
  }
}

# ---------- Variables ----------
variable "stage" {
  type    = string
  default = "dev"
}

variable "enable_waf" {
  description = "WAF en CloudFront y en la REST API (RNF-06). Es lo único con costo mensual fijo: apagado en dev"
  type        = bool
  default     = false
}

variable "alert_email" {
  description = "Correo del equipo para las alarmas (RNF-12). Lo pasa el pipeline desde la variable ALERT_EMAIL"
  type        = string
  default     = ""
}

variable "google_client_id" {
  description = "Client ID de Google para iniciar sesión con Google. Vacío = solo correo y contraseña"
  type        = string
  default     = ""
}

variable "google_client_secret" {
  type      = string
  default   = ""
  sensitive = true # no aparece en los logs del pipeline (sí queda en el estado, por eso es privado)
}

variable "extra_web_origins" {
  description = "Orígenes adicionales que pueden iniciar sesión (por ejemplo, la web en local)"
  type        = list(string)
  default     = ["http://localhost:5173"]
}

variable "ffmpeg_layer_arn" {
  type    = string
  default = ""
}

data "aws_caller_identity" "me" {}

locals {
  prefix      = "streamnote-${var.stage}"
  account_id  = data.aws_caller_identity.me.account_id
  web_origin  = "https://${module.frontend.domain_name}"
  web_origins = concat([local.web_origin], var.extra_web_origins)
  use_google  = var.google_client_id != ""
}

# ---------- Red (solo para Aurora) ----------
module "network" {
  source = "../../modules/network"
  prefix = local.prefix
}

# ---------- Mensajería, archivos y datos ----------
module "messaging" {
  source = "../../modules/messaging"
  prefix = local.prefix
}

module "storage" {
  source        = "../../modules/storage"
  prefix        = local.prefix
  bucket_suffix = local.account_id
  force_destroy = true # dev: permite destruir el entorno completo
}

module "notifications" {
  source = "../../modules/notifications"
  prefix = local.prefix
}

module "database" {
  source              = "../../modules/database"
  prefix              = local.prefix
  vpc_id              = module.network.vpc_id
  subnet_ids          = module.network.private_subnet_ids
  deletion_protection = false # dev
  skip_final_snapshot = true  # dev
}

# Caché distribuida de notas y feeds: los ítems vencen solos con el TTL
resource "aws_dynamodb_table" "cache" {
  name         = "${local.prefix}-cache"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expira_en"
    enabled        = true
  }
}

# ---------- Entrada: frontend ----------
module "frontend" {
  source        = "../../modules/frontend"
  prefix        = local.prefix
  bucket_suffix = local.account_id
  enable_waf    = var.enable_waf
}

# ---------- Cognito (inicio de sesión) ----------
resource "aws_cognito_user_pool" "this" {
  name                     = "${local.prefix}-users"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

# Dominio de la página de inicio de sesión de Cognito (único en la región)
resource "aws_cognito_user_pool_domain" "this" {
  domain                = "${local.prefix}-${local.account_id}"
  user_pool_id          = aws_cognito_user_pool.this.id
  managed_login_version = 1 # página clásica: no necesita configurar un estilo
}

resource "aws_cognito_identity_provider" "google" {
  count         = local.use_google ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.this.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = var.google_client_id
    client_secret    = var.google_client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email    = "email"
    name     = "name"
    username = "sub"
  }
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${local.prefix}-web"
  user_pool_id                         = aws_cognito_user_pool.this.id
  generate_secret                      = false # cliente público (navegador) con PKCE
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = local.use_google ? ["COGNITO", "Google"] : ["COGNITO"]
  callback_urls                        = [for o in local.web_origins : "${o}/"]
  logout_urls                          = [for o in local.web_origins : "${o}/"]
  prevent_user_existence_errors        = "ENABLED"

  depends_on = [aws_cognito_identity_provider.google]
}

# ---------- EventBridge Scheduler: deja los recordatorios en la cola de eventos ----------
data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.prefix}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler" {
  role = aws_iam_role.scheduler.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sqs:SendMessage", Resource = module.messaging.queue_arns["domain-events"] }]
  })
}

# Protege las rutas /internal/* (en local las usa el worker); en AWS nadie conoce este valor
resource "random_password" "internal" {
  length  = 40
  special = false
}

# ---------- Cómputo: REST API + Lambdas ----------
module "api" {
  source                = "../../modules/api"
  prefix                = local.prefix
  stage_name            = var.stage
  bundle_dir            = "${path.root}/../../../../backend/dist/lambda"
  queue_arns            = module.messaging.queue_arns
  event_bus_arn         = module.messaging.event_bus_arn
  bucket_arn            = module.storage.bucket_arn
  table_arn             = module.notifications.table_arn
  db_cluster_arn        = module.database.cluster_arn
  db_secret_arn         = module.database.secret_arn
  scheduler_role_arn    = aws_iam_role.scheduler.arn
  web_origins           = local.web_origins
  cognito_user_pool_arn = aws_cognito_user_pool.this.arn
  enable_waf            = var.enable_waf
  ffmpeg_layer_arn      = var.ffmpeg_layer_arn

  environment = {
    STAGE                   = var.stage
    AUTH_MODE               = "cognito"
    COGNITO_ISSUER          = "https://cognito-idp.us-east-1.amazonaws.com/${aws_cognito_user_pool.this.id}"
    COGNITO_CLIENT_ID       = aws_cognito_user_pool_client.web.id
    DB_DRIVER               = "data-api"
    DB_CLUSTER_ARN          = module.database.cluster_arn
    DB_SECRET_ARN           = module.database.secret_arn
    NOTE_WRITES_QUEUE_URL   = module.messaging.queue_urls["note-writes"]
    DOMAIN_EVENTS_QUEUE_URL = module.messaging.queue_urls["domain-events"]
    MEDIA_JOBS_QUEUE_URL    = module.messaging.queue_urls["media-jobs"]
    EVENT_BUS_NAME          = module.messaging.event_bus_name
    RECORDINGS_BUCKET       = module.storage.bucket_name
    NOTIFICATIONS_TABLE     = module.notifications.table_name
    SCHEDULER_MODE          = "eventbridge"
    SCHEDULER_TARGET_ARN    = module.messaging.queue_arns["domain-events"]
    SCHEDULER_ROLE_ARN      = aws_iam_role.scheduler.arn
    MEDIA_PROVIDER          = "ivs"
    REALTIME_MODE           = "none"
    EMULATE_S3_LIFECYCLE    = "false"
    JWT_SECRET              = random_password.internal.result # no se usa con Cognito, pero no debe ser un valor conocido
    INTERNAL_SECRET         = random_password.internal.result
    WEB_ORIGIN              = join(",", local.web_origins)
  }
}

# ---------- Operación: CloudWatch + SNS ----------
module "monitoring" {
  source       = "../../modules/monitoring"
  prefix       = local.prefix
  alert_email  = var.alert_email
  api_name     = module.api.api_name
  api_stage    = module.api.stage_name
  dlq_names    = { for k in keys(module.messaging.queue_urls) : k => "${local.prefix}-${k}-dlq" }
  lambda_names = { http = module.api.function_names["http"] }
}

# ---------- Salidas que usa el pipeline ----------
output "web_url" {
  value = local.web_origin
}

output "web_bucket" {
  value = module.frontend.bucket_name
}

output "cloudfront_id" {
  value = module.frontend.distribution_id
}

output "api_url" {
  value = module.api.api_url
}

output "cognito_domain" {
  value = "https://${aws_cognito_user_pool_domain.this.domain}.auth.us-east-1.amazoncognito.com"
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

output "migrate_function" {
  value = module.api.function_names["migrate"]
}

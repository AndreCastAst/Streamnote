# Entorno AWS (us-east-1). Reutiliza los módulos del entorno local y agrega lo que en local
# se emula: Aurora (PostgreSQL), Lambda + API Gateway (API y worker), Cognito (login) y Scheduler.
#
# ESTADO: esqueleto revisado pero aún no aplicado. Antes de usarlo:
#   1. cd backend && npm run build:lambda
#   2. terraform init && terraform plan -var-file=prod.tfvars   (revisar el plan con calma)
#   3. Migraciones: ver README ("Desplegar en AWS")
# Pendiente: adaptador de Amazon IVS (MEDIA_PROVIDER=ivs), IVS Chat, Web Push, CloudFront para la web.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
  # Estado remoto recomendado para un equipo de 4 personas:
  # backend "s3" {
  #   bucket       = "streamnote-terraform-state"
  #   key          = "prod/terraform.tfstate"
  #   region       = "us-east-1"
  #   use_lockfile = true
  # }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { proyecto = "streamnote", entorno = var.stage }
  }
}

variable "stage" {
  type    = string
  default = "prod"
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type = list(string)
}

variable "web_origins" {
  type = list(string)
}

variable "ffmpeg_layer_arn" {
  type    = string
  default = ""
}

locals {
  prefix = "streamnote-${var.stage}"
}

module "messaging" {
  source = "../../modules/messaging"
  prefix = local.prefix
}

module "storage" {
  source = "../../modules/storage"
  prefix = local.prefix
}

module "notifications" {
  source = "../../modules/notifications"
  prefix = local.prefix
}

module "database" {
  source     = "../../modules/database"
  prefix     = local.prefix
  vpc_id     = var.vpc_id
  subnet_ids = var.private_subnet_ids
}

# ---------- Cognito (inicio de sesión; el proveedor de Google se agrega con sus credenciales) ----------
resource "aws_cognito_user_pool" "this" {
  name                     = "${local.prefix}-users"
  auto_verified_attributes = ["email"]
  username_attributes      = ["email"]
}

resource "aws_cognito_user_pool_client" "web" {
  name                                 = "${local.prefix}-web"
  user_pool_id                         = aws_cognito_user_pool.this.id
  generate_secret                      = false
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"] # agregar "Google" al configurar el IdP
  callback_urls                        = var.web_origins
  logout_urls                          = var.web_origins
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

module "api" {
  source             = "../../modules/api"
  prefix             = local.prefix
  bundle_dir         = "${path.root}/../../../../backend/dist/lambda"
  queue_arns         = module.messaging.queue_arns
  event_bus_arn      = module.messaging.event_bus_arn
  bucket_arn         = module.storage.bucket_arn
  table_arn          = module.notifications.table_arn
  db_cluster_arn     = module.database.cluster_arn
  db_secret_arn      = module.database.secret_arn
  scheduler_role_arn = aws_iam_role.scheduler.arn
  web_origins        = var.web_origins
  ffmpeg_layer_arn   = var.ffmpeg_layer_arn

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
    JWT_SECRET              = "no-se-usa-con-cognito"
    WEB_ORIGIN              = join(",", var.web_origins)
  }
}

output "api_url" {
  value = module.api.api_url
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.this.id
}

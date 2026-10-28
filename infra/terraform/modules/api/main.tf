# Cómputo: las mismas rutas y consumidores del backend, empaquetados como Lambda.
#   http          ← API Gateway REST API (capa 7: rutas, autorizador de Cognito, límites, WAF)
#   note-writes   ← SQS (concurrencia máxima 5 para no saturar Aurora, RNF-18)
#   domain-events ← SQS (destino de la regla de EventBridge y de Scheduler)
#   media-jobs    ← SQS (necesita una capa con ffmpeg; ver README)
#   migrate       ← la invoca el pipeline para aplicar las migraciones SQL por Data API

variable "prefix" {
  type = string
}

variable "bundle_dir" {
  description = "Carpeta con dist/lambda/index.mjs (npm run build:lambda en backend/)"
  type        = string
}

variable "environment" {
  description = "Variables de entorno comunes a todas las funciones"
  type        = map(string)
}

variable "queue_arns" {
  type = map(string)
}

variable "event_bus_arn" {
  type = string
}

variable "bucket_arn" {
  type = string
}

variable "table_arn" {
  type = string
}

variable "db_cluster_arn" {
  type = string
}

variable "db_secret_arn" {
  type = string
}

variable "scheduler_role_arn" {
  type = string
}

variable "web_origins" {
  type = list(string)
}

variable "cognito_user_pool_arn" {
  description = "User Pool cuyos tokens acepta el autorizador de la REST API"
  type        = string
}

variable "stage_name" {
  type = string
}

variable "enable_waf" {
  description = "Crea y asocia el WAF regional a la REST API (costo mensual fijo)"
  type        = bool
  default     = false
}

variable "waf_rate_limit" {
  description = "Solicitudes por IP en 5 minutos antes de bloquear (RNF-06)"
  type        = number
  default     = 300
}

variable "ffmpeg_layer_arn" {
  description = "Capa de Lambda con ffmpeg/ffprobe en /opt/bin, para media-jobs"
  type        = string
  default     = ""
}

data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.bundle_dir
  output_path = "${path.module}/.build/${var.prefix}-lambda.zip"
}

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "${var.prefix}-lambda"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Mínimo privilegio: cada permiso apunta a un recurso concreto
data "aws_iam_policy_document" "app" {
  statement {
    actions   = ["rds-data:ExecuteStatement", "rds-data:BatchExecuteStatement", "rds-data:BeginTransaction", "rds-data:CommitTransaction", "rds-data:RollbackTransaction"]
    resources = [var.db_cluster_arn]
  }
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.db_secret_arn]
  }
  statement {
    actions   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility", "sqs:GetQueueAttributes"]
    resources = values(var.queue_arns)
  }
  statement {
    actions   = ["events:PutEvents"]
    resources = [var.event_bus_arn]
  }
  statement {
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:PutObjectTagging"]
    resources = ["${var.bucket_arn}/*"]
  }
  statement {
    actions   = ["dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"]
    resources = [var.table_arn]
  }
  statement {
    actions   = ["scheduler:CreateSchedule", "scheduler:DeleteSchedule"]
    resources = ["*"]
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [var.scheduler_role_arn]
  }
}

resource "aws_iam_role_policy" "app" {
  role   = aws_iam_role.lambda.id
  policy = data.aws_iam_policy_document.app.json
}

locals {
  functions = {
    http          = { handler = "index.http", timeout = 28, memory = 512 } # 28 s: da tiempo a que Aurora despierte (API Gateway corta a los 29 s)
    note-writes   = { handler = "index.noteWrites", timeout = 30, memory = 512 }
    domain-events = { handler = "index.domainEvents", timeout = 20, memory = 512 }
    media-jobs    = { handler = "index.mediaJobs", timeout = 300, memory = 2048 }
    migrate       = { handler = "index.migrate", timeout = 300, memory = 256 }
  }
}

resource "aws_lambda_function" "this" {
  for_each         = local.functions
  function_name    = "${var.prefix}-${each.key}"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = each.value.handler
  timeout          = each.value.timeout
  memory_size      = each.value.memory
  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256
  layers           = each.key == "media-jobs" && var.ffmpeg_layer_arn != "" ? [var.ffmpeg_layer_arn] : []

  environment {
    variables = merge(var.environment, each.key == "media-jobs" ? { PATH = "/opt/bin:/usr/local/bin:/usr/bin:/bin" } : {})
  }

  depends_on = [aws_cloudwatch_log_group.this, aws_iam_role_policy_attachment.logs]
}

resource "aws_lambda_event_source_mapping" "queues" {
  for_each                = { for k in ["note-writes", "domain-events", "media-jobs"] : k => k }
  event_source_arn        = var.queue_arns[each.key]
  function_name           = aws_lambda_function.this[each.key].arn
  batch_size              = each.key == "media-jobs" ? 1 : 10
  function_response_types = ["ReportBatchItemFailures"]

  scaling_config {
    maximum_concurrency = each.key == "note-writes" ? 5 : 10
  }
}

resource "aws_cloudwatch_log_group" "this" {
  for_each          = local.functions
  name              = "/aws/lambda/${var.prefix}-${each.key}"
  retention_in_days = 14 # sin retención, los logs se guardan (y se cobran) para siempre
}

# ---------- REST API ----------
# Se eligió REST y no HTTP API porque solo REST admite WAF (RNF-06).
# Una sola ruta {proxy+}: el enrutador del backend resuelve la ruta; el autorizador de Cognito
# rechaza antes cualquier petición sin un token válido (RNF-14) y la Lambda revisa los permisos.
resource "aws_api_gateway_rest_api" "this" {
  name = "${var.prefix}-api"
  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

resource "aws_api_gateway_authorizer" "cognito" {
  name            = "${var.prefix}-cognito"
  rest_api_id     = aws_api_gateway_rest_api.this.id
  type            = "COGNITO_USER_POOLS"
  provider_arns   = [var.cognito_user_pool_arn]
  identity_source = "method.request.header.Authorization"
}

resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id   = aws_api_gateway_rest_api.this.root_resource_id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "proxy" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "proxy" {
  rest_api_id             = aws_api_gateway_rest_api.this.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy.http_method
  type                    = "AWS_PROXY"
  integration_http_method = "POST"
  uri                     = aws_lambda_function.this["http"].invoke_arn
}

# CORS: el navegador pregunta con OPTIONS (sin token) antes de cada llamada.
# Lo responde API Gateway directamente, sin invocar la Lambda.
locals {
  cors_headers = {
    "Access-Control-Allow-Origin"  = "'*'" # la sesión va en la cabecera Authorization, no en cookies
    "Access-Control-Allow-Headers" = "'authorization,content-type'"
    "Access-Control-Allow-Methods" = "'GET,POST,PUT,PATCH,DELETE,OPTIONS'"
  }
}

resource "aws_api_gateway_method" "options" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options" {
  rest_api_id       = aws_api_gateway_rest_api.this.id
  resource_id       = aws_api_gateway_resource.proxy.id
  http_method       = aws_api_gateway_method.options.http_method
  type              = "MOCK"
  request_templates = { "application/json" = jsonencode({ statusCode = 200 }) }
}

resource "aws_api_gateway_method_response" "options" {
  rest_api_id         = aws_api_gateway_rest_api.this.id
  resource_id         = aws_api_gateway_resource.proxy.id
  http_method         = aws_api_gateway_method.options.http_method
  status_code         = "200"
  response_parameters = { for k, _ in local.cors_headers : "method.response.header.${k}" => true }
}

resource "aws_api_gateway_integration_response" "options" {
  rest_api_id         = aws_api_gateway_rest_api.this.id
  resource_id         = aws_api_gateway_resource.proxy.id
  http_method         = aws_api_gateway_method.options.http_method
  status_code         = aws_api_gateway_method_response.options.status_code
  response_parameters = { for k, v in local.cors_headers : "method.response.header.${k}" => v }
  depends_on          = [aws_api_gateway_integration.options]
}

# Para que el navegador pueda leer también los 401 del autorizador y los 5XX de API Gateway
resource "aws_api_gateway_gateway_response" "cors" {
  for_each            = toset(["DEFAULT_4XX", "DEFAULT_5XX"])
  rest_api_id         = aws_api_gateway_rest_api.this.id
  response_type       = each.key
  response_parameters = { for k, v in local.cors_headers : "gatewayresponse.header.${k}" => v }
}

resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  # Cualquier cambio en rutas o integraciones genera un despliegue nuevo
  triggers = {
    redeploy = sha1(jsonencode([
      aws_api_gateway_resource.proxy,
      aws_api_gateway_method.proxy,
      aws_api_gateway_integration.proxy,
      aws_api_gateway_method.options,
      aws_api_gateway_integration.options,
      aws_api_gateway_integration_response.options,
      aws_api_gateway_authorizer.cognito,
      aws_api_gateway_gateway_response.cors,
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [aws_api_gateway_integration.proxy, aws_api_gateway_integration_response.options]
}

resource "aws_api_gateway_stage" "this" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  deployment_id = aws_api_gateway_deployment.this.id
  stage_name    = var.stage_name
}

# Límite de volumen para toda la API (el bloqueo por origen lo hace el WAF)
resource "aws_api_gateway_method_settings" "all" {
  rest_api_id = aws_api_gateway_rest_api.this.id
  stage_name  = aws_api_gateway_stage.this.stage_name
  method_path = "*/*"
  settings {
    throttling_burst_limit = 200
    throttling_rate_limit  = 100
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["http"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.this.execution_arn}/*/*"
}

# ---------- WAF regional (RNF-06), solo si enable_waf = true ----------
resource "aws_wafv2_web_acl" "api" {
  count = var.enable_waf ? 1 : 0
  name  = "${var.prefix}-api"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "limite-por-ip"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.prefix}-api-limite-por-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.prefix}-api"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "api" {
  count        = var.enable_waf ? 1 : 0
  resource_arn = aws_api_gateway_stage.this.arn
  web_acl_arn  = aws_wafv2_web_acl.api[0].arn
}

output "api_url" {
  value = aws_api_gateway_stage.this.invoke_url
}

output "api_name" {
  value = aws_api_gateway_rest_api.this.name
}

output "stage_name" {
  value = aws_api_gateway_stage.this.stage_name
}

output "function_names" {
  value = { for k, f in aws_lambda_function.this : k => f.function_name }
}

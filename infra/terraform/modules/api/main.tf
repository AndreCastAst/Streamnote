# Cómputo: las mismas rutas y consumidores del backend, empaquetados como Lambda.
#   http          ← API Gateway HTTP API
#   note-writes   ← SQS (concurrencia máxima 5 para no saturar Aurora, RNF-18)
#   domain-events ← SQS (destino de la regla de EventBridge y de Scheduler)
#   media-jobs    ← SQS (necesita una capa con ffmpeg; ver README)

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
    http          = { handler = "index.http", timeout = 15, memory = 512 }
    note-writes   = { handler = "index.noteWrites", timeout = 30, memory = 512 }
    domain-events = { handler = "index.domainEvents", timeout = 20, memory = 512 }
    media-jobs    = { handler = "index.mediaJobs", timeout = 300, memory = 2048 }
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

resource "aws_apigatewayv2_api" "http" {
  name          = "${var.prefix}-api"
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = var.web_origins
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    allow_headers = ["authorization", "content-type"]
  }
}

resource "aws_apigatewayv2_integration" "http" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.this["http"].invoke_arn
  payload_format_version = "2.0"
}

# Una sola ruta: el enrutador del backend resuelve la ruta y valida el JWT de Cognito
resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.http.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 200
    throttling_rate_limit  = 100
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this["http"].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

output "api_url" {
  value = aws_apigatewayv2_api.http.api_endpoint
}

# Monitoreo (RNF-12): CloudWatch mide, la alarma decide y SNS avisa por correo al equipo.
# Todas las alarmas entran en la capa gratuita (hasta 10).

variable "prefix" {
  type = string
}

variable "alert_email" {
  description = "Correo que recibe las alertas. AWS manda un correo de confirmación la primera vez"
  type        = string
  default     = ""
}

variable "api_name" {
  type = string
}

variable "api_stage" {
  type = string
}

variable "dlq_names" {
  type = map(string)
}

variable "lambda_names" {
  type = map(string)
}

resource "aws_sns_topic" "alerts" {
  name = "${var.prefix}-alertas"
}

resource "aws_sns_topic_subscription" "email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# RNF-12: errores 5XX > 2 % de las solicitudes durante 5 minutos.
# En una REST API, el promedio de 5XXError ya es la proporción de solicitudes con error.
resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${var.prefix}-api-errores-5xx"
  alarm_description   = "Más del 2 % de las solicitudes a la API fallan (RNF-12)"
  namespace           = "AWS/ApiGateway"
  metric_name         = "5XXError"
  dimensions          = { ApiName = var.api_name, Stage = var.api_stage }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0.02
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# RNF-10 / RNF-11: un mensaje que falló 3 veces terminó en la DLQ y hay que revisarlo
resource "aws_cloudwatch_metric_alarm" "dlq" {
  for_each            = var.dlq_names
  alarm_name          = "${var.prefix}-dlq-${each.key}"
  alarm_description   = "Hay mensajes en la DLQ de ${each.key}"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = each.value }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Errores de la Lambda que atiende la API
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  for_each            = var.lambda_names
  alarm_name          = "${var.prefix}-lambda-errores-${each.key}"
  alarm_description   = "La función ${each.key} está fallando"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  dimensions          = { FunctionName = each.value }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

output "topic_arn" {
  value = aws_sns_topic.alerts.arn
}

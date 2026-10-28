# Colas SQS con DLQ, bus de EventBridge y la regla que lleva los eventos de dominio a su cola.
# Se usa igual en local (contra moto) y en AWS.

variable "prefix" {
  type = string
}

variable "queues" {
  description = "Colas a crear: tiempo de visibilidad y reintentos antes de la DLQ"
  type = map(object({
    visibility_timeout = number
    max_receive_count  = number
  }))
  default = {
    note-writes   = { visibility_timeout = 90, max_receive_count = 3 }   # RNF-05, RNF-10
    domain-events = { visibility_timeout = 30, max_receive_count = 3 }   # RNF-11
    media-jobs    = { visibility_timeout = 300, max_receive_count = 10 } # unir y subir grabaciones
  }
}

resource "aws_sqs_queue" "dlq" {
  for_each                  = var.queues
  name                      = "${var.prefix}-${each.key}-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "this" {
  for_each                   = var.queues
  name                       = "${var.prefix}-${each.key}"
  visibility_timeout_seconds = each.value.visibility_timeout
  message_retention_seconds  = 1209600 # 14 días: si la base cae, nada se pierde
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = each.value.max_receive_count
  })
}

resource "aws_cloudwatch_event_bus" "this" {
  name = "${var.prefix}-bus"
}

resource "aws_cloudwatch_event_rule" "domain_events" {
  name           = "${var.prefix}-domain-events"
  event_bus_name = aws_cloudwatch_event_bus.this.name
  event_pattern  = jsonencode({ source = ["streamnote.app"] })
}

resource "aws_cloudwatch_event_target" "domain_events" {
  rule           = aws_cloudwatch_event_rule.domain_events.name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  target_id      = "domain-events-queue"
  arn            = aws_sqs_queue.this["domain-events"].arn
}

# Permite que EventBridge (y EventBridge Scheduler) dejen mensajes en la cola de eventos
resource "aws_sqs_queue_policy" "domain_events" {
  queue_url = aws_sqs_queue.this["domain-events"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["events.amazonaws.com", "scheduler.amazonaws.com"] }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.this["domain-events"].arn
    }]
  })
}

output "queue_urls" {
  value = { for k, q in aws_sqs_queue.this : k => q.id }
}

output "queue_arns" {
  value = { for k, q in aws_sqs_queue.this : k => q.arn }
}

output "event_bus_name" {
  value = aws_cloudwatch_event_bus.this.name
}

output "event_bus_arn" {
  value = aws_cloudwatch_event_bus.this.arn
}

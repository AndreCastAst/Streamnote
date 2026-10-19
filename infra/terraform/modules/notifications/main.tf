# Tabla de notificaciones: una partición por usuario, ordenada por fecha.

variable "prefix" {
  type = string
}

resource "aws_dynamodb_table" "notifications" {
  name         = "${var.prefix}-notifications"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "sk"

  attribute {
    name = "userId"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }
}

output "table_name" {
  value = aws_dynamodb_table.notifications.name
}

output "table_arn" {
  value = aws_dynamodb_table.notifications.arn
}

# Entorno local: los mismos módulos que en AWS, aplicados contra moto (emulador de AWS).
# docker compose lo ejecuta automáticamente en el servicio "infra".
#   terraform -chdir=infra/terraform/envs/local init
#   terraform -chdir=infra/terraform/envs/local apply -var aws_endpoint=http://localhost:5000

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "aws_endpoint" {
  type    = string
  default = "http://localhost:5000"
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    s3       = var.aws_endpoint
    sqs      = var.aws_endpoint
    dynamodb = var.aws_endpoint
    events   = var.aws_endpoint
    sts      = var.aws_endpoint
    iam      = var.aws_endpoint
  }
}

locals {
  prefix = "streamnote-local"
}

module "messaging" {
  source = "../../modules/messaging"
  prefix = local.prefix
}

module "storage" {
  source        = "../../modules/storage"
  prefix        = local.prefix
  force_destroy = true
}

module "notifications" {
  source = "../../modules/notifications"
  prefix = local.prefix
}

output "queue_urls" {
  value = module.messaging.queue_urls
}

output "event_bus_name" {
  value = module.messaging.event_bus_name
}

output "recordings_bucket" {
  value = module.storage.bucket_name
}

output "notifications_table" {
  value = module.notifications.table_name
}

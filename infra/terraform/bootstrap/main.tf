# Bootstrap: se aplica UNA sola vez, a mano (por ejemplo desde AWS CloudShell).
# Crea lo que el pipeline necesita antes de poder entrar a AWS:
#   1. el bucket donde vive el estado de Terraform
#   2. el proveedor OIDC que hace que AWS confíe en los tokens de GitHub Actions
#   3. el rol que asume el pipeline, solo desde nuestro repositorio
# Su propio estado queda local: casi nunca se vuelve a tocar.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
  default_tags {
    tags = { proyecto = "streamnote", entorno = "bootstrap" }
  }
}

variable "github_repo" {
  description = "Repositorio que puede desplegar, como dueño/nombre (mayúsculas incluidas)"
  type        = string
  default     = "AndreCastAst/Streamnote"
}

variable "create_oidc_provider" {
  description = "false si la cuenta ya tiene el proveedor OIDC de GitHub (solo puede haber uno)"
  type        = bool
  default     = true
}

data "aws_caller_identity" "me" {}

# ---------- 1) Bucket del estado ----------
resource "aws_s3_bucket" "tfstate" {
  bucket = "streamnote-tfstate-${data.aws_caller_identity.me.account_id}" # único en el mundo
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled" # si el estado se daña, se vuelve a una versión anterior
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true # el estado puede contener secretos: nunca público
}

# ---------- 2) AWS confía en los tokens de GitHub Actions ----------
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

# ---------- 3) Rol del pipeline, solo desde nuestro repositorio ----------
data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:*"] # evita que otro repositorio use el rol
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name                 = "streamnote-github-deploy"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy_attachment" "admin" {
  role       = aws_iam_role.github_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess" # simple para el curso; ver mejoras en la guía
}

output "role_arn" {
  description = "Va en GitHub como variable AWS_ROLE_ARN"
  value       = aws_iam_role.github_deploy.arn
}

output "state_bucket" {
  description = "Debe coincidir con infra/terraform/envs/dev/backend.tf"
  value       = aws_s3_bucket.tfstate.bucket
}

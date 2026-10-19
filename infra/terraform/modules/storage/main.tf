# Bucket de grabaciones con la política de retención acordada:
# - estado=provisional  → se borra a los N días si nadie la conserva
# - estado=conservada   → nunca se borra; baja a Glacier Instant Retrieval (día 30) y a Deep Archive (día 180)
# La API cambia la etiqueta con PutObjectTagging cuando alguien pulsa "Conservar".

variable "prefix" {
  type = string
}

variable "provisional_days" {
  type    = number
  default = 3
}

variable "force_destroy" {
  description = "true solo en local: permite borrar el bucket con objetos dentro"
  type        = bool
  default     = false
}

resource "aws_s3_bucket" "recordings" {
  bucket        = "${var.prefix}-recordings"
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "recordings" {
  bucket                  = aws_s3_bucket.recordings.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "recordings" {
  bucket = aws_s3_bucket.recordings.id

  rule {
    id     = "borrar-provisionales"
    status = "Enabled"
    filter {
      tag {
        key   = "estado"
        value = "provisional"
      }
    }
    expiration {
      days = var.provisional_days
    }
  }

  rule {
    id     = "degradar-conservadas"
    status = "Enabled"
    filter {
      tag {
        key   = "estado"
        value = "conservada"
      }
    }
    transition {
      days          = 30
      storage_class = "GLACIER_IR"
    }
    transition {
      days          = 180
      storage_class = "DEEP_ARCHIVE"
    }
  }
}

output "bucket_name" {
  value = aws_s3_bucket.recordings.bucket
}

output "bucket_arn" {
  value = aws_s3_bucket.recordings.arn
}

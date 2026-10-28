# Frontend estático (React + Vite): bucket S3 privado servido por CloudFront con OAC.
# El WAF de CloudFront (alcance global) se crea solo si enable_waf = true: es lo único con costo fijo.

variable "prefix" {
  type = string
}

variable "bucket_suffix" {
  description = "Sufijo para que el nombre del bucket sea único en el mundo"
  type        = string
}

variable "enable_waf" {
  type    = bool
  default = false
}

variable "waf_rate_limit" {
  description = "Solicitudes por IP en 5 minutos antes de bloquear (RNF-06)"
  type        = number
  default     = 300
}

resource "aws_s3_bucket" "web" {
  bucket        = "${var.prefix}-web-${var.bucket_suffix}"
  force_destroy = true # solo contiene el build; el pipeline lo vuelve a subir
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${var.prefix}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_wafv2_web_acl" "cloudfront" {
  count = var.enable_waf ? 1 : 0
  name  = "${var.prefix}-cloudfront"
  scope = "CLOUDFRONT" # el WAF de CloudFront siempre se crea en us-east-1

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
      metric_name                = "${var.prefix}-cf-limite-por-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.prefix}-cloudfront"
    sampled_requests_enabled   = true
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  comment             = "${var.prefix} frontend"
  default_root_object = "index.html"
  price_class         = "PriceClass_All" # incluye ubicaciones en Sudamérica
  web_acl_id          = var.enable_waf ? aws_wafv2_web_acl.cloudfront[0].arn : null

  origin {
    origin_id                = "web"
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id       = "web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = "658327ea-f89d-4fab-a63d-7e88639e58f6" # Managed-CachingOptimized
  }

  # Aplicación de una sola página: cualquier ruta (/notas, /c/123...) devuelve index.html
  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Solo esta distribución de CloudFront puede leer el bucket
data "aws_iam_policy_document" "web" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web.json
}

output "bucket_name" {
  value = aws_s3_bucket.web.bucket
}

output "distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "domain_name" {
  value = aws_cloudfront_distribution.web.domain_name
}

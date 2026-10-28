# Aurora PostgreSQL Serverless v2 con RDS Data API: las Lambda consultan por HTTPS con IAM,
# sin VPC, sin NAT Gateway y sin RDS Proxy. Escritor y lector en zonas distintas (RNF-04).
# Con capacidad mínima 0 se pausa sola: nada cobra por estar encendido.

variable "prefix" {
  type = string
}

variable "subnet_ids" {
  description = "Subredes privadas en al menos dos zonas de disponibilidad"
  type        = list(string)
}

variable "vpc_id" {
  type = string
}

variable "min_acu" {
  description = "0 = se pausa sola cuando no hay uso (sin costo de cómputo)"
  type        = number
  default     = 0
}

variable "seconds_until_auto_pause" {
  description = "Tiempo sin conexiones antes de pausarse; 1 hora para no dormirse en horario de clases"
  type        = number
  default     = 3600
}

variable "deletion_protection" {
  description = "true en producción; false en dev para poder destruir el entorno"
  type        = bool
  default     = true
}

variable "skip_final_snapshot" {
  type    = bool
  default = false
}

# Aurora PostgreSQL 16: la primera de la lista que AWS todavía ofrezca.
# La capacidad mínima 0 pide 16.3 o superior.
data "aws_rds_engine_version" "postgres" {
  engine             = "aurora-postgresql"
  preferred_versions = ["16.11", "16.10", "16.9", "16.8", "16.6"]
}

variable "max_acu" {
  type    = number
  default = 4
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.prefix}-db"
  subnet_ids = var.subnet_ids
}

# Sin reglas de entrada: nadie se conecta por red; solo se usa la Data API
resource "aws_security_group" "db" {
  name   = "${var.prefix}-db"
  vpc_id = var.vpc_id
}

resource "aws_rds_cluster" "this" {
  cluster_identifier          = "${var.prefix}-db"
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = data.aws_rds_engine_version.postgres.version_actual
  database_name               = "streamnote"
  master_username             = "streamnote"
  manage_master_user_password = true # el secreto queda en Secrets Manager
  enable_http_endpoint        = true # RDS Data API
  db_subnet_group_name        = aws_db_subnet_group.this.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  storage_encrypted           = true
  backup_retention_period     = 35 # respaldo continuo sin costo extra dentro de este plazo
  deletion_protection         = var.deletion_protection
  copy_tags_to_snapshot       = true
  skip_final_snapshot         = var.skip_final_snapshot
  final_snapshot_identifier   = var.skip_final_snapshot ? null : "${var.prefix}-db-final"

  serverlessv2_scaling_configuration {
    min_capacity             = var.min_acu
    max_capacity             = var.max_acu
    seconds_until_auto_pause = var.min_acu == 0 ? var.seconds_until_auto_pause : null
  }

  lifecycle {
    ignore_changes = [engine_version] # AWS aplica las versiones menores; no forzar cambios en cada plan
  }
}

resource "aws_rds_cluster_instance" "this" {
  for_each           = { writer = 0, reader = 1 }
  identifier         = "${var.prefix}-db-${each.key}"
  cluster_identifier = aws_rds_cluster.this.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.this.engine
  engine_version     = aws_rds_cluster.this.engine_version
  promotion_tier     = each.value

  lifecycle {
    ignore_changes = [engine_version]
  }
}

output "cluster_arn" {
  value = aws_rds_cluster.this.arn
}

output "cluster_id" {
  value = aws_rds_cluster.this.cluster_identifier
}

output "secret_arn" {
  value = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

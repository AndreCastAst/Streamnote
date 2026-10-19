# Aurora PostgreSQL Serverless v2 con RDS Data API: las Lambda consultan por HTTPS con IAM,
# sin VPC, sin NAT Gateway y sin RDS Proxy. Escritor y lector en zonas distintas (RNF-04).

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
  type    = number
  default = 0.5
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
  engine_version              = "16.6"
  database_name               = "streamnote"
  master_username             = "streamnote"
  manage_master_user_password = true # el secreto queda en Secrets Manager
  enable_http_endpoint        = true # RDS Data API
  db_subnet_group_name        = aws_db_subnet_group.this.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  storage_encrypted           = true
  backup_retention_period     = 35 # respaldo continuo sin costo extra dentro de este plazo
  deletion_protection         = true
  copy_tags_to_snapshot       = true
  final_snapshot_identifier   = "${var.prefix}-db-final"

  serverlessv2_scaling_configuration {
    min_capacity = var.min_acu
    max_capacity = var.max_acu
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
}

output "cluster_arn" {
  value = aws_rds_cluster.this.arn
}

output "secret_arn" {
  value = aws_rds_cluster.this.master_user_secret[0].secret_arn
}

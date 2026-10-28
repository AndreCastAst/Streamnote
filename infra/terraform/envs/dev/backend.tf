# El estado vive en el bucket que creó infra/terraform/bootstrap, nunca en el repositorio.
terraform {
  required_version = ">= 1.10"

  backend "s3" {
    bucket       = "streamnote-tfstate-555294074210"
    key          = "dev/terraform.tfstate" # prod usaría "prod/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true # bloqueo nativo de S3: dos pipelines no pueden aplicar a la vez
    encrypt      = true
  }
}

#!/bin/sh
# Lo ejecuta el servicio "infra" de docker compose. Crea (o recrea) los recursos en moto.
set -e
cd /terraform/envs/local
echo "Esperando al emulador de AWS en $AWS_ENDPOINT..."
until wget -q -O /dev/null "$AWS_ENDPOINT/moto-api/"; do sleep 1; done
terraform init -input=false
terraform apply -input=false -auto-approve -var "aws_endpoint=$AWS_ENDPOINT"

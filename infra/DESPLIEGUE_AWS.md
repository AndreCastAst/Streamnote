# Desplegar StreamNote en AWS (MVP)

Cuenta: `555294074210` · Región: `us-east-1` · Repositorio: `AndreCastAst/Streamnote`

El orden importa: primero el **bootstrap** (una vez, a mano), después todo lo hace **GitHub Actions**.

## 1. Subir el código a una rama (en tu PC)

En la carpeta `streamnote`:

```bash
git checkout -b infra/aws-mvp
git add -A
git commit -m "infra: despliegue del MVP en AWS con Terraform y GitHub Actions"
git push -u origin infra/aws-mvp
```

Se sube a una rama y no a `main` porque un push a `main` dispara el despliegue, y el despliegue todavía no puede entrar a AWS.

## 2. Bootstrap desde AWS CloudShell (una sola vez)

Entra a la consola de AWS, revisa que arriba a la derecha diga **N. Virginia (us-east-1)** y abre **CloudShell** (el ícono `>_` de la barra superior). CloudShell ya tiene tu sesión: no hacen falta llaves de acceso.

```bash
# Terraform (CloudShell no lo trae)
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
curl -sLo tf.zip "https://releases.hashicorp.com/terraform/1.12.2/terraform_1.12.2_linux_${ARCH}.zip"
mkdir -p ~/bin && unzip -o tf.zip -d ~/bin && export PATH=$HOME/bin:$PATH
terraform version

# Confirmar la cuenta: debe decir 555294074210
aws sts get-caller-identity

# Código y bootstrap
git clone -b infra/aws-mvp https://github.com/AndreCastAst/Streamnote.git
cd Streamnote/infra/terraform/bootstrap
terraform init
terraform apply        # escribe "yes"
```

Al final imprime `role_arn` (`arn:aws:iam::555294074210:role/streamnote-github-deploy`) y `state_bucket` (`streamnote-tfstate-555294074210`).

Si falla:

| Error | Qué hacer |
|---|---|
| `EntityAlreadyExists` en el proveedor OIDC | La cuenta ya lo tiene: `terraform apply -var create_oidc_provider=false` |
| `AccessDenied` / `not authorized` | Tu usuario no tiene permisos de IAM o S3. Pídele al profesor permisos de administrador para el proyecto. |

## 3. Configurar GitHub

En el repositorio: **Settings → Secrets and variables → Actions → pestaña Variables → New repository variable**.

| Variable | Valor |
|---|---|
| `AWS_ROLE_ARN` | `arn:aws:iam::555294074210:role/streamnote-github-deploy` |
| `AWS_REGION` | `us-east-1` |
| `ALERT_EMAIL` | el correo del equipo que recibe las alarmas |

Opcional (login con Google): variable `GOOGLE_CLIENT_ID` y **secret** `GOOGLE_CLIENT_SECRET`. Sin ellos se entra con correo y contraseña de Cognito.

Opcional: en **Settings → Environments** crear `prod` con *Required reviewers*. El entorno `dev` se crea solo la primera vez que corre un workflow.

## 4. Pull Request → plan, merge → deploy

1. En GitHub, abre un Pull Request de `infra/aws-mvp` hacia `main`. Corre **plan** (unos 3 minutos) y en su log se ve todo lo que se va a crear.
2. Si sale en verde, haz **Merge**. Corre **deploy**: la primera vez tarda **20 a 30 minutos** (Aurora y CloudFront son lo más lento).
3. Al terminar, en **Actions → deploy → Summary** aparece la URL de la web (`https://xxxx.cloudfront.net`).
4. Revisa tu correo: AWS manda un correo **"AWS Notification - Subscription Confirmation"**. Confirma para recibir las alarmas.

## 5. Probar

Abre la URL de la web → **Entrar** → **Sign up** → correo, contraseña y el código que llega al correo. Crea una comunidad y una nota.

La primera solicitud después de una hora sin uso puede tardar unos 15 segundos: Aurora estaba pausada (capacidad mínima 0) y está despertando.

## Errores típicos del pipeline

| Error | Causa probable |
|---|---|
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `AWS_ROLE_ARN` mal copiado, o el bootstrap no se aplicó. |
| `Error acquiring the state lock` | Un despliegue anterior murió a medias. Espera a que no corra otro y usa `terraform force-unlock <ID>`. |
| `Your account must be verified before you can add new CloudFront resources` | Cuenta nueva: abre un caso en AWS Support pidiendo habilitar CloudFront. Vuelve a correr deploy (Actions → deploy → Run workflow). |
| `TooManyRequestsException` en Lambda | La cuenta tiene una cuota baja de ejecuciones simultáneas. Revísala en Service Quotas → AWS Lambda → Concurrent executions. |
| La migración falla con `DatabaseResumingException` | Aurora despertando. Vuelve a correr deploy. |
| `BucketAlreadyExists` | Ya no debería pasar (los buckets llevan el número de cuenta); si pasa, cambia el sufijo. |

## Qué se despliega y qué queda para la fase 2

| Desplegado (MVP) | Fase 2 (diseñado, no desplegado) |
|---|---|
| S3 + CloudFront (web), Cognito, REST API con autorizador de Cognito, Lambdas por función, Aurora Serverless v2 (mínimo 0, Data API, escritor + lector en 2 zonas), SQS + DLQ, EventBridge, Scheduler (rol), DynamoDB (notificaciones y caché con TTL), S3 de grabaciones, Secrets Manager, CloudWatch + SNS (5 alarmas) | IVS e IVS Chat, WebSocket API (colaboración), Web Push, AWS Backup, subida de imágenes/PDF con URL prefirmada |

El WAF ya está en el código detrás de la variable `enable_waf` (apagada en dev porque cobra unos 12 USD/mes). Para la demo: `terraform apply -var enable_waf=true`, o cambiar el valor por defecto y hacer merge.

## Borrar todo (cuando termine el curso)

Desde CloudShell, en `Streamnote/infra/terraform/envs/dev`: compila las Lambdas (`cd ../../../../backend && npm ci && npm run build:lambda`), vuelve y corre `terraform init && terraform destroy`. Después, en `bootstrap`: `terraform destroy` (vacía antes el bucket del estado).

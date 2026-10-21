# StreamNote

Apuntes modulares, comunidades con permisos y clases en vivo donde los participantes comparten módulos de sus notas entre sí. Esta versión corre completa en tu computadora y está organizada para desplegarse después en AWS con Terraform sin reescribir el código.

## Arrancar en local

Necesitas **Docker Desktop** (o Docker Engine con Compose v2.20 o superior) y Chrome, Edge o Firefox.

```bash
docker compose up --build
```

La primera vez tarda unos minutos porque descarga imágenes y Terraform crea los recursos. Cuando veas `worker listo`, abre **http://localhost:5173**.

Para probar los dos roles a la vez, entra con un correo en una ventana normal y con otro en una ventana de incógnito. No se pide contraseña: es un inicio de sesión de desarrollo que en AWS reemplaza Cognito.

### Recorrido de prueba

1. **Ana** crea una comunidad privada y copia el código de invitación.
2. **Beto** se une con el código, entra a la comunidad y pulsa «Pedir permiso para transmitir».
3. Ana recibe el aviso, va a *Miembros* y le activa «Puede transmitir».
4. Ana inicia un directo y pulsa «Compartir cámara». Beto recibe el aviso «está en vivo» y entra.
5. Los dos toman apuntes en su propia nota de la sesión. Ana pasa el cursor sobre un módulo y pulsa «Compartir en el directo»; a Beto le aparece en «Lo que se comparte» y lo agrega a su nota, marcado con resaltador y el nombre de Ana.
6. Ana termina el directo. En un minuto la grabación aparece en la comunidad como **provisional**. Beto puede «Pedir que se conserve»; Ana pulsa «Conservar».

## Qué reemplaza a qué

| En AWS | En local | Qué cambia en el código |
| --- | --- | --- |
| Aurora PostgreSQL Serverless v2 + RDS Data API | PostgreSQL 16 | `DB_DRIVER=pg` o `data-api` ([db.ts](backend/src/core/db.ts)) |
| API Gateway HTTP + Lambda | Fastify | Nada: las mismas rutas ([router.ts](backend/src/app/router.ts)) |
| Consumidores SQS en Lambda | Proceso `worker` | Nada: las mismas funciones ([lambda.ts](backend/src/entrypoints/lambda.ts)) |
| SQS, EventBridge, S3, DynamoDB | moto (emulador de AWS) | Solo `AWS_ENDPOINT_URL` |
| EventBridge Scheduler | El worker revisa la tabla cada 10 s | `SCHEDULER_MODE=poll` o `eventbridge` |
| Cognito con Google | `/auth/dev-login` | `AUTH_MODE=local` o `cognito` |
| Amazon IVS + grabación a S3 | MediaMTX (WebRTC WHIP/WHEP) + ffmpeg | `MEDIA_PROVIDER` (adaptador de IVS pendiente) |
| IVS Chat y Web Push | WebSocket de la API | Interfaz `Realtime` |
| Ciclo de vida de S3 | El worker borra lo provisional vencido | `EMULATE_S3_LIFECYCLE` |

Los recursos de mensajería, almacenamiento y notificaciones los crea **Terraform** con los mismos módulos en los dos entornos: `infra/terraform/envs/local` apunta a moto e `infra/terraform/envs/aws` a AWS.

## Cómo está armado

```
backend/
  migrations/        SQL del esquema (PostgreSQL / Aurora)
  src/core/          adaptadores: base de datos, colas, eventos, S3, DynamoDB, video, tiempo real
  src/domains/       reglas de negocio: comunidades y permisos, notas, directos, notificaciones
  src/entrypoints/   server (API local), worker, lambda (AWS), migrate, bootstrap-local
  scripts/smoke.ts   46 comprobaciones de la API
web/                 React + Vite
infra/
  mediamtx/          configuración del servidor de video local
  terraform/modules  messaging, storage, notifications, database, api
  terraform/envs     local (moto) y aws
e2e/                 prueba con dos navegadores y cámara simulada
```

Decisiones que vienen del documento de arquitectura:

- **Autoguardado por cola.** `PUT /notes/:id` valida, deja la nota en SQS y responde 202 al instante. El consumidor la aplica solo si su versión es mayor que la guardada, así una escritura vieja que llega tarde no pisa a una nueva. Cada escritura lleva un `opId` para que un mensaje repetido no se aplique dos veces.
- **Eventos de dominio.** Cada dominio publica en EventBridge (`MemberJoined`, `StreamStarted`, `RecordingReady`…); una regla los lleva a una cola y un consumidor decide a quién avisar.
- **Permiso para transmitir.** Lo otorga el creador de la comunidad o un moderador; un miembro puede pedirlo.
- **Tokens de video.** La API firma un token por directo y por acción (emitir o ver), como el token de reproducción de IVS. El servidor de video lo valida en cada conexión.
- **Grabaciones provisionales.** Todo directo se graba, se une en un MP4 con una copia en audio y se sube a S3 con la etiqueta `estado=provisional`. Si quien transmitió o un moderador no la conserva, se borra al vencer el plazo; si la conserva, la etiqueta pasa a `conservada` y el ciclo de vida la baja a Glacier con el tiempo.

## Pruebas

Sin Docker, sin la app corriendo y sin `npm install`:

```bash
cd web && npm test                                                           # reglas del acomodo de la cuadrícula
```

Con la app corriendo:

```bash
cd backend && npm install && npm run smoke                                   # API: permisos, colas, eventos, tokens
cd e2e && npm install && npx playwright install chromium && npm test         # navegador: directo, módulos, grabación
```

## Problemas comunes

- **El directo se queda en «Conectando…».** WebRTC necesita el puerto UDP 8189 libre. En Docker Desktop, MediaMTX anuncia `127.0.0.1`, así que el navegador debe estar en la misma computadora.
- **Terraform falla al crear los recursos** (por ejemplo, sin acceso al registro de Terraform). Usa la alternativa con el SDK de AWS: `COMPOSE_PROFILES=sdk docker compose up`.
- **Desaparecieron las grabaciones** después de reiniciar el contenedor `aws`. moto guarda todo en memoria; al volver a levantarlo, Terraform recrea los recursos pero vacíos.
- **La grabación sale sin video.** El grabador guarda MP4, que admite H.264 y VP9 pero no VP8. La app pide uno de esos dos; si tu navegador no ofrece ninguno, se graba solo el audio.

## Desarrollo sin Docker

Necesitas Node 22.18 o superior, PostgreSQL 16, `pip install "moto[server]"` y el binario de [MediaMTX](https://github.com/bluenviron/mediamtx/releases).

```bash
moto_server -p 5000 &
AWS_ENDPOINT_URL=http://localhost:5000 npm --prefix backend run bootstrap:local
npm --prefix backend run migrate
# en infra/mediamtx/mediamtx.yml cambia api:4000 por localhost:4000 y /recordings por una carpeta local
mediamtx infra/mediamtx/mediamtx.yml &
AWS_ENDPOINT_URL=http://localhost:5000 MEDIA_RECORDINGS_DIR=<esa carpeta> npm --prefix backend run dev:api
AWS_ENDPOINT_URL=http://localhost:5000 MEDIA_RECORDINGS_DIR=<esa carpeta> npm --prefix backend run dev:worker
npm --prefix web run dev
```

## Desplegar en AWS

`infra/terraform/envs/aws` ya declara colas, bus, bucket, tabla, Aurora con Data API, las cuatro Lambda, API Gateway, Cognito y el rol de Scheduler. **Todavía no se ha aplicado**: revisa el `terraform plan` con calma antes de crear nada.

1. `cd backend && npm run build:lambda`
2. Crea `prod.tfvars` con `vpc_id`, `private_subnet_ids` (dos zonas) y `web_origins`.
3. `terraform init && terraform plan -var-file=prod.tfvars`
4. Migraciones: la Data API no ejecuta archivos con varias sentencias. Córrelas una vez con `npm run migrate` desde una máquina con acceso al clúster (por ejemplo, un túnel de Session Manager).

Lo que falta para producción:

- Adaptador de **Amazon IVS** que implemente la interfaz `MediaServer` ([media.ts](backend/src/core/media.ts)). Mientras no exista, las rutas de video responden 501 y el resto de la app funciona.
- **IVS Chat** para el chat y los módulos compartidos (eventos `SendEvent`), y **Web Push** para los avisos. Hoy en AWS los avisos quedan en DynamoDB sin empujarse.
- Una capa de Lambda con **ffmpeg** para `media-jobs`.
- La web en **S3 + CloudFront** (`npm --prefix web run build`).

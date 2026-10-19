// Toda la configuración sale de variables de entorno. Los mismos nombres se usan
// en local (docker-compose / .env) y en AWS (variables de las funciones Lambda).

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Falta la variable de entorno ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`${name} debe ser numérico`);
  return n;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig() {
  return {
    stage: env('STAGE', 'local'),
    port: num('PORT', 4000),
    webOrigin: env('WEB_ORIGIN', 'http://localhost:5173'),

    auth: {
      // 'local': tokens HS256 emitidos por /auth/dev-login (reemplaza a Cognito en local)
      // 'cognito': tokens de un User Pool, validados contra su JWKS
      mode: env('AUTH_MODE', 'local') as 'local' | 'cognito',
      jwtSecret: env('JWT_SECRET', 'dev-secret-cambiar'),
      cognitoIssuer: process.env.COGNITO_ISSUER ?? '',
      cognitoClientId: process.env.COGNITO_CLIENT_ID ?? '',
    },

    db: {
      // 'pg': conexión directa (local); 'data-api': RDS Data API (AWS, sin VPC)
      driver: env('DB_DRIVER', 'pg') as 'pg' | 'data-api',
      url: process.env.DATABASE_URL ?? 'postgres://streamnote:streamnote@localhost:5432/streamnote',
      clusterArn: process.env.DB_CLUSTER_ARN ?? '',
      secretArn: process.env.DB_SECRET_ARN ?? '',
      database: process.env.DB_NAME ?? 'streamnote',
    },

    aws: {
      region: env('AWS_REGION', 'us-east-1'),
      // En local apunta a moto (http://localhost:5000); en AWS se deja vacío
      endpoint: process.env.AWS_ENDPOINT_URL || undefined,
      // URL de S3 que ve el navegador (en Docker difiere de la interna)
      publicS3Endpoint: process.env.AWS_PUBLIC_S3_ENDPOINT || process.env.AWS_ENDPOINT_URL || undefined,
    },

    resources: {
      noteWritesQueueUrl: env('NOTE_WRITES_QUEUE_URL', 'http://localhost:5000/123456789012/streamnote-local-note-writes'),
      domainEventsQueueUrl: env('DOMAIN_EVENTS_QUEUE_URL', 'http://localhost:5000/123456789012/streamnote-local-domain-events'),
      mediaJobsQueueUrl: env('MEDIA_JOBS_QUEUE_URL', 'http://localhost:5000/123456789012/streamnote-local-media-jobs'),
      eventBusName: env('EVENT_BUS_NAME', 'streamnote-local-bus'),
      recordingsBucket: env('RECORDINGS_BUCKET', 'streamnote-local-recordings'),
      notificationsTable: env('NOTIFICATIONS_TABLE', 'streamnote-local-notifications'),
    },

    media: {
      // 'mediamtx' en local; 'ivs' en AWS (adaptador pendiente: responde 501, ver README)
      provider: env('MEDIA_PROVIDER', 'mediamtx') as 'mediamtx' | 'ivs',
      apiUrl: env('MEDIA_API_URL', 'http://localhost:9997'),
      publicWebrtcUrl: env('MEDIA_PUBLIC_WEBRTC_URL', 'http://localhost:8889'),
      publicHlsUrl: env('MEDIA_PUBLIC_HLS_URL', 'http://localhost:8888'),
      recordingsDir: env('MEDIA_RECORDINGS_DIR', './.data/recordings'),
      // RNF-16: ventana para reconectar antes de dar el directo por terminado
      reconnectWindowSeconds: num('STREAM_RECONNECT_WINDOW_SECONDS', 60),
      // Tiempo que se espera a que el emisor conecte por primera vez
      startGraceSeconds: num('STREAM_START_GRACE_SECONDS', 180),
    },

    recordings: {
      provisionalHours: num('RECORDING_PROVISIONAL_HOURS', 72),
      // En AWS la regla de ciclo de vida de S3 borra lo provisional. En local se emula.
      emulateLifecycle: env('EMULATE_S3_LIFECYCLE', 'true') === 'true',
    },

    scheduler: {
      // 'poll': el worker revisa la tabla cada N segundos (local)
      // 'eventbridge': un horario de EventBridge Scheduler por recordatorio (AWS)
      mode: env('SCHEDULER_MODE', 'poll') as 'poll' | 'eventbridge',
      pollSeconds: num('SCHEDULER_POLL_SECONDS', 10),
      targetArn: process.env.SCHEDULER_TARGET_ARN ?? '',
      roleArn: process.env.SCHEDULER_ROLE_ARN ?? '',
    },

    realtime: {
      // El worker publica eventos en tiempo real a través de la API
      apiInternalUrl: env('API_INTERNAL_URL', 'http://localhost:4000'),
      internalSecret: env('INTERNAL_SECRET', 'internal-dev-secret'),
    },
  };
}

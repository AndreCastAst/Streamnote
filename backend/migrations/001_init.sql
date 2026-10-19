-- StreamNote: esquema inicial (PostgreSQL 16 / Aurora PostgreSQL Serverless v2)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text NOT NULL UNIQUE,          -- 'local:<email>' en local, 'cognito:<sub>' en AWS
  email         text NOT NULL,
  display_name  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE communities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  visibility   text NOT NULL CHECK (visibility IN ('public', 'private')),
  invite_code  text NOT NULL UNIQUE,
  owner_id     uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Rol y permiso de transmisión que otorga el creador (o un moderador)
CREATE TABLE memberships (
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'moderator', 'member')),
  can_stream    boolean NOT NULL DEFAULT false,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships(user_id);

-- Notas modulares: una nota es una lista ordenada de módulos
CREATE TABLE notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    uuid NOT NULL REFERENCES users(id),
  title       text NOT NULL,
  version     bigint NOT NULL DEFAULT 1,       -- el worker solo aplica escrituras con versión mayor
  stream_id   uuid,                            -- nota creada para una sesión en vivo
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX notes_owner_idx ON notes(owner_id) WHERE deleted_at IS NULL;

CREATE TABLE note_modules (
  id                uuid NOT NULL,
  note_id           uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  type              text NOT NULL CHECK (type IN ('text', 'heading', 'code', 'checklist', 'quote')),
  content           jsonb NOT NULL,
  source_module_id  uuid,                      -- módulo del que se copió (trazabilidad al compartir)
  source_author     text,
  PRIMARY KEY (note_id, id)
);
CREATE INDEX note_modules_note_idx ON note_modules(note_id, position);

CREATE TABLE note_shares (
  note_id       uuid NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  shared_by     uuid NOT NULL REFERENCES users(id),
  shared_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, community_id)
);

-- Idempotencia de escrituras que llegan por la cola (RNF-05)
CREATE TABLE processed_ops (
  op_id         uuid PRIMARY KEY,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stream_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  host_id       uuid NOT NULL REFERENCES users(id),
  title         text NOT NULL,
  status        text NOT NULL CHECK (status IN ('live', 'ended')),
  media_path    text NOT NULL UNIQUE,
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,                   -- última vez que el servidor de video vio al emisor
  ended_at      timestamptz,
  recording     text NOT NULL DEFAULT 'pending' CHECK (recording IN ('pending', 'processing', 'ready', 'none', 'failed'))
);
CREATE INDEX stream_sessions_community_idx ON stream_sessions(community_id, started_at DESC);

-- Módulos que los participantes comparten durante un directo
CREATE TABLE stream_shared_modules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id    uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  shared_by    uuid NOT NULL REFERENCES users(id),
  type         text NOT NULL,
  content      jsonb NOT NULL,
  source_module_id uuid,
  shared_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stream_shared_modules_idx ON stream_shared_modules(stream_id, shared_at);

-- Grabaciones: provisionales por N horas; solo se conservan las que confirma el anfitrión o un moderador
CREATE TABLE recordings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_id     uuid NOT NULL UNIQUE REFERENCES stream_sessions(id) ON DELETE CASCADE,
  community_id  uuid NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  video_key     text NOT NULL,
  audio_key     text,                          -- NULL si la transmisión no tenía audio
  duration_s    integer NOT NULL,
  size_bytes    bigint NOT NULL,
  status        text NOT NULL CHECK (status IN ('provisional', 'kept', 'expired')),
  expires_at    timestamptz,
  kept_by       uuid REFERENCES users(id),
  kept_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recordings_community_idx ON recordings(community_id, created_at DESC);

-- Recordatorios: en local los dispara un sondeo; en AWS, EventBridge Scheduler
CREATE TABLE reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL,
  fire_at       timestamptz NOT NULL,
  kind          text NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'recording_expiry')),
  ref_id        uuid,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminders_due_idx ON reminders(fire_at) WHERE status = 'pending';

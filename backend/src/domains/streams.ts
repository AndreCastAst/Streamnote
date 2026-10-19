// Directos, módulos compartidos en vivo, chat y grabaciones provisionales.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Deps } from '../app/deps.js';
import { route, requireUser, idParam, forbidden, notFound, conflict, badRequest, unauthorized } from '../core/http.js';
import { ModuleSchema } from './notes.js';
import { canView, getCommunity, getMembership, isManager, requireMember } from './access.js';

const run = promisify(execFile);

interface Session {
  id: string;
  community_id: string;
  host_id: string;
  title: string;
  status: 'live' | 'ended';
  media_path: string;
  started_at: string;
  last_seen_at: string | null;
  ended_at: string | null;
  recording: string;
}

async function loadSession(db: Deps['db'], id: string): Promise<Session> {
  const s = await db.one<Session>('SELECT * FROM stream_sessions WHERE id = :id::uuid', { id });
  if (!s) throw notFound('El directo no existe');
  return s;
}

// ---------- Tokens de video (equivalen al token de reproducción firmado de IVS) ----------
type MediaAction = 'publish' | 'read';

async function mediaToken(deps: Deps, path: string, userId: string, act: MediaAction) {
  return new SignJWT({ path, act })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setAudience('media')
    .setIssuedAt()
    .setExpirationTime(act === 'publish' ? '12h' : '6h')
    .sign(new TextEncoder().encode(deps.cfg.auth.jwtSecret));
}

async function verifyMediaToken(deps: Deps, token: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(deps.cfg.auth.jwtSecret), { audience: 'media' });
  return payload as { sub: string; path: string; act: MediaAction };
}

async function endSession(deps: Deps, sessionId: string, reason: string) {
  const ended = await deps.db.query<Session>(
    `UPDATE stream_sessions SET status = 'ended', ended_at = now() WHERE id = :id::uuid AND status = 'live' RETURNING *`,
    { id: sessionId },
  );
  if (!ended.length) return false;
  const s = ended[0];
  await deps.queue.send(deps.cfg.resources.mediaJobsQueueUrl, { kind: 'process-recording', streamId: s.id });
  await deps.realtime.publish({ channel: `stream:${s.id}`, type: 'stream.ended', data: { reason } }).catch(() => undefined);
  await deps.bus.publish('StreamEnded', { streamId: s.id, communityId: s.community_id, reason });
  return true;
}

function storageTier(status: string, createdAt: Date) {
  if (status === 'provisional') return 'S3 Standard (provisional)';
  const days = (Date.now() - createdAt.getTime()) / 86_400_000;
  if (days < 30) return 'S3 Standard';
  if (days < 180) return 'S3 Glacier Instant Retrieval';
  return 'S3 Glacier Deep Archive';
}

const StartStream = z.object({ title: z.string().trim().min(3).max(120) });
const ShareModule = z.intersection(ModuleSchema, z.object({ sourceModuleId: z.string().uuid().optional() }));
const Chat = z.object({ text: z.string().trim().min(1).max(500) });

export const streamRoutes = [
  // Iniciar un directo: requiere el permiso de transmitir que da el creador
  route({
    method: 'POST',
    path: '/communities/:id/streams',
    auth: 'user',
    body: StartStream,
    async handler(req, deps) {
      const user = requireUser(req);
      const communityId = idParam(req);
      const m = await requireMember(deps.db, communityId, user.id);
      if (!m.can_stream) throw forbidden('Necesitas que el creador de la comunidad te dé permiso para transmitir');
      const live = await deps.db.one('SELECT id FROM stream_sessions WHERE community_id = :c::uuid AND host_id = :u::uuid AND status = :st', {
        c: communityId,
        u: user.id,
        st: 'live',
      });
      if (live) throw conflict('Ya tienes un directo en curso en esta comunidad');
      const id = randomUUID();
      const { title } = req.body as z.infer<typeof StartStream>;
      const session = await deps.db.one<Session>(
        `INSERT INTO stream_sessions (id, community_id, host_id, title, status, media_path)
         VALUES (:id::uuid, :c::uuid, :u::uuid, :title, 'live', :path) RETURNING *`,
        { id, c: communityId, u: user.id, title, path: `s_${id.replaceAll('-', '')}` },
      );
      const c = await getCommunity(deps.db, communityId);
      await deps.bus.publish('StreamStarted', {
        streamId: id,
        communityId,
        communityName: c.name,
        hostId: user.id,
        hostName: user.name,
        title,
      });
      return { status: 201, body: { id: session!.id } };
    },
  }),

  route({
    method: 'GET',
    path: '/communities/:id/streams',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      if (!(await canView(db, id, user.id))) throw forbidden();
      return db.query(
        `SELECT s.id, s.title, s.status, s.started_at, s.ended_at, s.recording, u.display_name AS host
         FROM stream_sessions s JOIN users u ON u.id = s.host_id
         WHERE s.community_id = :c::uuid
         ORDER BY (s.status = 'live') DESC, s.started_at DESC LIMIT 30`,
        { c: id },
      );
    },
  }),

  route({
    method: 'GET',
    path: '/streams/:id',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const s = await loadSession(deps.db, idParam(req));
      if (!(await canView(deps.db, s.community_id, user.id))) throw forbidden('Esta comunidad es privada');
      const c = await getCommunity(deps.db, s.community_id);
      const m = await getMembership(deps.db, s.community_id, user.id);
      const host = await deps.db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = :u::uuid', { u: s.host_id });
      const isHost = s.host_id === user.id;
      const live = s.status === 'live';
      const state = live ? await deps.media.state(s.media_path).catch(() => ({ publishing: false, viewers: 0 })) : null;
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        startedAt: s.started_at,
        endedAt: s.ended_at,
        community: { id: c.id, name: c.name },
        host: { id: s.host_id, name: host?.display_name },
        isHost,
        isMember: !!m,
        canManage: isHost || isManager(m),
        publishing: state?.publishing ?? false,
        viewers: state?.viewers ?? 0,
        publishUrl: live && isHost ? deps.media.publishUrl(s.media_path, await mediaToken(deps, s.media_path, user.id, 'publish')) : null,
        playback: live ? deps.media.playUrls(s.media_path, await mediaToken(deps, s.media_path, user.id, 'read')) : null,
      };
    },
  }),

  route({
    method: 'POST',
    path: '/streams/:id/end',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const s = await loadSession(deps.db, idParam(req));
      const m = await getMembership(deps.db, s.community_id, user.id);
      if (s.host_id !== user.id && !isManager(m)) throw forbidden();
      await endSession(deps, s.id, 'host');
      return { ok: true };
    },
  }),

  // Compartir un módulo de mis notas con todos los participantes del directo
  route({
    method: 'POST',
    path: '/streams/:id/modules',
    auth: 'user',
    body: ShareModule,
    async handler(req, deps) {
      const user = requireUser(req);
      const s = await loadSession(deps.db, idParam(req));
      if (s.status !== 'live') throw badRequest('El directo ya terminó');
      if (!(await canView(deps.db, s.community_id, user.id))) throw forbidden();
      const b = req.body as z.infer<typeof ShareModule>;
      const row = await deps.db.one(
        `INSERT INTO stream_shared_modules (stream_id, shared_by, type, content, source_module_id)
         VALUES (:s::uuid, :u::uuid, :type, :content::jsonb, :src::uuid)
         RETURNING id, type, content, source_module_id AS "sourceModuleId", shared_at AS "sharedAt"`,
        { s: s.id, u: user.id, type: b.type, content: b.content, src: b.sourceModuleId ?? null },
      );
      const shared = { ...row, sharedBy: { id: user.id, name: user.name } };
      await deps.realtime.publish({ channel: `stream:${s.id}`, type: 'module.shared', data: shared });
      return { status: 201, body: shared };
    },
  }),

  route({
    method: 'GET',
    path: '/streams/:id/modules',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const s = await loadSession(deps.db, idParam(req));
      if (!(await canView(deps.db, s.community_id, user.id))) throw forbidden();
      const rows = await deps.db.query(
        `SELECT m.id, m.type, m.content, m.source_module_id AS "sourceModuleId", m.shared_at AS "sharedAt",
                json_build_object('id', u.id, 'name', u.display_name) AS "sharedBy"
         FROM stream_shared_modules m JOIN users u ON u.id = m.shared_by
         WHERE m.stream_id = :s::uuid ORDER BY m.shared_at`,
        { s: s.id },
      );
      return rows;
    },
  }),

  // Chat efímero (en AWS: IVS Chat, sin persistencia)
  route({
    method: 'POST',
    path: '/streams/:id/chat',
    auth: 'user',
    body: Chat,
    async handler(req, deps) {
      const user = requireUser(req);
      const s = await loadSession(deps.db, idParam(req));
      if (s.status !== 'live') throw badRequest('El directo ya terminó');
      if (!(await canView(deps.db, s.community_id, user.id))) throw forbidden();
      const msg = { id: randomUUID(), text: (req.body as { text: string }).text, from: { id: user.id, name: user.name }, at: new Date().toISOString() };
      await deps.realtime.publish({ channel: `stream:${s.id}`, type: 'chat.message', data: msg });
      return { status: 201, body: msg };
    },
  }),

  // ---------- Grabaciones ----------
  route({
    method: 'GET',
    path: '/communities/:id/recordings',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const id = idParam(req);
      if (!(await canView(deps.db, id, user.id))) throw forbidden();
      const m = await getMembership(deps.db, id, user.id);
      const rows = await deps.db.query(
        `SELECT r.*, s.title, s.host_id, u.display_name AS host
         FROM recordings r JOIN stream_sessions s ON s.id = r.stream_id JOIN users u ON u.id = s.host_id
         WHERE r.community_id = :c::uuid AND r.status <> 'expired'
         ORDER BY r.created_at DESC`,
        { c: id },
      );
      return Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          streamId: r.stream_id,
          title: r.title,
          host: r.host,
          status: r.status,
          durationSeconds: r.duration_s,
          sizeBytes: Number(r.size_bytes),
          createdAt: r.created_at,
          expiresAt: r.expires_at,
          storageTier: storageTier(r.status, new Date(r.created_at)),
          canKeep: r.status === 'provisional' && (r.host_id === user.id || isManager(m)),
          videoUrl: await deps.storage.signedUrl(r.video_key),
          audioUrl: r.audio_key ? await deps.storage.signedUrl(r.audio_key) : null,
        })),
      );
    },
  }),

  // Conservar: cambia la etiqueta en S3 para que la regla de ciclo de vida no la borre
  route({
    method: 'POST',
    path: '/recordings/:id/keep',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const r = await deps.db.one('SELECT r.*, s.host_id, s.title FROM recordings r JOIN stream_sessions s ON s.id = r.stream_id WHERE r.id = :id::uuid', {
        id: idParam(req),
      });
      if (!r || r.status === 'expired') throw notFound('La grabación no existe o ya se borró');
      const m = await getMembership(deps.db, r.community_id, user.id);
      if (r.host_id !== user.id && !isManager(m)) throw forbidden('Solo quien transmitió o un moderador puede conservar la grabación');
      if (r.status === 'kept') return { ok: true };
      const tags = { estado: 'conservada' };
      await deps.storage.setTags(r.video_key, tags);
      if (r.audio_key) await deps.storage.setTags(r.audio_key, tags);
      await deps.db.query(
        `UPDATE recordings SET status = 'kept', expires_at = NULL, kept_by = :u::uuid, kept_at = now() WHERE id = :id::uuid`,
        { u: user.id, id: r.id },
      );
      const pending = await deps.db.query<{ id: string }>(
        `UPDATE reminders SET status = 'cancelled' WHERE ref_id = :id::uuid AND kind = 'recording_expiry' AND status = 'pending' RETURNING id`,
        { id: r.id },
      );
      for (const p of pending) await deps.scheduler.cancel(p.id);
      await deps.bus.publish('RecordingKept', { recordingId: r.id, communityId: r.community_id, title: r.title, byUserId: user.id, byName: user.name });
      return { ok: true };
    },
  }),

  // Un alumno pide que se conserve: se avisa al anfitrión y a los moderadores
  route({
    method: 'POST',
    path: '/recordings/:id/keep-requests',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const r = await deps.db.one('SELECT r.*, s.host_id, s.title FROM recordings r JOIN stream_sessions s ON s.id = r.stream_id WHERE r.id = :id::uuid', {
        id: idParam(req),
      });
      if (!r || r.status !== 'provisional') throw notFound('La grabación no está pendiente de conservar');
      await requireMember(deps.db, r.community_id, user.id);
      await deps.bus.publish('RecordingKeepRequested', {
        recordingId: r.id,
        communityId: r.community_id,
        hostId: r.host_id,
        title: r.title,
        userId: user.id,
        userName: user.name,
      });
      return { status: 202, body: { ok: true } };
    },
  }),

  // MediaMTX consulta aquí antes de dejar emitir o ver (en AWS: token de reproducción de IVS)
  route({
    method: 'POST',
    path: '/internal/media/auth',
    auth: 'none',
    async handler(req, deps) {
      const b = (req.body ?? {}) as { action?: string; path?: string; query?: string; token?: string; password?: string };
      const token = b.token || new URLSearchParams(b.query ?? '').get('token') || b.password;
      if (!token || !b.path) throw unauthorized();
      let claims;
      try {
        claims = await verifyMediaToken(deps, token);
      } catch {
        throw unauthorized();
      }
      if (claims.path !== b.path) throw unauthorized();
      if (b.action === 'publish') {
        if (claims.act !== 'publish') throw unauthorized();
        const s = await deps.db.one('SELECT status FROM stream_sessions WHERE media_path = :p', { p: b.path });
        if (s?.status !== 'live') throw unauthorized();
        return { ok: true };
      }
      if (b.action === 'read') return { ok: true };
      throw unauthorized();
    },
  }),
];

// ---------- Procesos del worker ----------

/**
 * Cierra los directos cuyo emisor no volvió dentro de la ventana de reconexión (RNF-16),
 * o que nunca llegaron a conectar. En AWS lo resuelve IVS con sus eventos de estado.
 */
export async function reconcileStreams(deps: Deps) {
  const live = await deps.db.query<Session>(`SELECT * FROM stream_sessions WHERE status = 'live'`);
  const now = Date.now();
  for (const s of live) {
    const state = await deps.media.state(s.media_path);
    if (state.publishing) {
      await deps.db.query('UPDATE stream_sessions SET last_seen_at = now() WHERE id = :id::uuid', { id: s.id });
      continue;
    }
    const lastSeen = s.last_seen_at ? new Date(s.last_seen_at).getTime() : null;
    if (lastSeen === null && now - new Date(s.started_at).getTime() > deps.cfg.media.startGraceSeconds * 1000) {
      await endSession(deps, s.id, 'never-connected');
    } else if (lastSeen !== null && now - lastSeen > deps.cfg.media.reconnectWindowSeconds * 1000) {
      await endSession(deps, s.id, 'disconnected');
    }
  }
}

export class RetryLater extends Error {}

async function ffprobe(path: string) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path]);
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type: string }[] };
  return {
    duration: Math.round(Number(info.format?.duration ?? 0)),
    hasAudio: !!info.streams?.some((st) => st.codec_type === 'audio'),
  };
}

/**
 * Une los segmentos grabados en un solo MP4, extrae una copia en audio y sube ambos a S3
 * con la etiqueta estado=provisional. La regla de ciclo de vida los borra si nadie los conserva.
 */
export async function processRecording(deps: Deps, streamId: string) {
  const s = await loadSession(deps.db, streamId);
  if (s.recording === 'ready' || s.recording === 'none') return;
  const state = await deps.media.state(s.media_path);
  if (state.publishing) throw new RetryLater('El emisor sigue conectado');

  const files = await deps.media.recordingFiles(s.media_path);
  if (!files.length) {
    await deps.db.query(`UPDATE stream_sessions SET recording = 'none' WHERE id = :id::uuid`, { id: s.id });
    return;
  }
  // Esperar a que el servidor de video termine de escribir el último segmento
  const newest = Math.max(...(await Promise.all(files.map(async (f) => (await stat(f)).mtimeMs))));
  if (Date.now() - newest < 5000) throw new RetryLater('El último segmento aún se está escribiendo');

  await deps.db.query(`UPDATE stream_sessions SET recording = 'processing' WHERE id = :id::uuid`, { id: s.id });
  const work = await mkdtemp(join(tmpdir(), 'rec-'));
  try {
    const list = join(work, 'list.txt');
    await writeFile(list, files.map((f) => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'));
    const video = join(work, 'video.mp4');
    await run('ffmpeg', ['-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', video]);
    const info = await ffprobe(video);
    let audio: string | null = null;
    if (info.hasAudio) {
      audio = join(work, 'audio.m4a');
      await run('ffmpeg', ['-v', 'error', '-i', video, '-vn', '-c:a', 'aac', '-b:a', '64k', audio]);
    }

    const prefix = `recordings/${s.community_id}/${s.id}`;
    const tags = { estado: 'provisional' };
    await deps.storage.uploadFile(`${prefix}/video.mp4`, video, 'video/mp4', tags);
    if (audio) await deps.storage.uploadFile(`${prefix}/audio.m4a`, audio, 'audio/mp4', tags);

    const hours = deps.cfg.recordings.provisionalHours;
    const expiresAt = new Date(Date.now() + hours * 3_600_000);
    const rec = await deps.db.one<{ id: string }>(
      `INSERT INTO recordings (stream_id, community_id, video_key, audio_key, duration_s, size_bytes, status, expires_at)
       VALUES (:s::uuid, :c::uuid, :v, :a, :d, :size, 'provisional', :exp) RETURNING id`,
      {
        s: s.id,
        c: s.community_id,
        v: `${prefix}/video.mp4`,
        a: audio ? `${prefix}/audio.m4a` : null,
        d: info.duration,
        size: (await stat(video)).size,
        exp: expiresAt,
      },
    );
    // Aviso al anfitrión antes del borrado (24 h antes, o a mitad de plazo si es más corto)
    const warnAt = new Date(expiresAt.getTime() - Math.min(24 * 3_600_000, (hours * 3_600_000) / 2));
    const reminder = await deps.db.one<{ id: string }>(
      `INSERT INTO reminders (user_id, title, fire_at, kind, ref_id)
       VALUES (:u::uuid, :t, :at, 'recording_expiry', :r::uuid) RETURNING id`,
      { u: s.host_id, t: `La grabación «${s.title}» se borrará pronto si no la conservas`, at: warnAt, r: rec!.id },
    );
    await deps.scheduler.schedule(reminder!.id, warnAt);
    await deps.db.query(`UPDATE stream_sessions SET recording = 'ready' WHERE id = :id::uuid`, { id: s.id });
    await deps.bus.publish('RecordingReady', {
      recordingId: rec!.id,
      streamId: s.id,
      communityId: s.community_id,
      hostId: s.host_id,
      title: s.title,
      expiresAt: expiresAt.toISOString(),
    });
    await rm(dirname(files[0]), { recursive: true, force: true });
  } catch (e) {
    await deps.db.query(`UPDATE stream_sessions SET recording = 'failed' WHERE id = :id::uuid`, { id: s.id });
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Solo en local: emula la regla de ciclo de vida que en AWS borra lo provisional vencido. */
export async function expireProvisionalRecordings(deps: Deps) {
  const due = await deps.db.query(`SELECT * FROM recordings WHERE status = 'provisional' AND expires_at < now()`);
  for (const r of due) {
    await deps.storage.delete(r.video_key);
    if (r.audio_key) await deps.storage.delete(r.audio_key);
    await deps.db.query(`UPDATE recordings SET status = 'expired' WHERE id = :id::uuid`, { id: r.id });
  }
  return due.length;
}

// Notificaciones y recordatorios.
// Los dominios publican eventos en EventBridge; una regla los lleva a la cola domain-events
// y este consumidor decide a quién avisar. Las notificaciones se guardan en DynamoDB y se
// empujan en tiempo real (en AWS, además, por Web Push).
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../app/deps.js';
import { route, requireUser, idParam, badRequest, notFound } from '../core/http.js';
import { managerIds, memberIds } from './access.js';

interface Notice {
  type: string;
  title: string;
  body: string;
  link?: string;
}

export async function notify(deps: Deps, userIds: string[], n: Notice) {
  const unique = [...new Set(userIds)];
  for (const userId of unique) {
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const item = { userId, sk: `${createdAt}#${id}`, id, createdAt, read: false, ...n };
    await deps.notifications.put(item);
    await deps.realtime.publish({ channel: `user:${userId}`, type: 'notification', data: item }).catch(() => undefined);
  }
}

async function communityName(deps: Deps, id: string) {
  return (await deps.db.one<{ name: string }>('SELECT name FROM communities WHERE id = :id::uuid', { id }))?.name ?? 'la comunidad';
}

const without = (ids: string[], ...exclude: (string | undefined)[]) => ids.filter((id) => !exclude.includes(id));
type D = Record<string, any>;

/** Reacciones a eventos de dominio. Un evento desconocido se ignora (no bloquea la cola). */
export async function handleDomainEvent(deps: Deps, type: string, d: D) {
  switch (type) {
    case 'MemberJoined': {
      const name = await communityName(deps, d.communityId);
      return notify(deps, without(await managerIds(deps.db, d.communityId), d.userId), {
        type,
        title: `${d.userName} se unió a ${name}`,
        body: 'Puedes darle permiso para transmitir desde la lista de miembros.',
        link: `/c/${d.communityId}`,
      });
    }
    case 'StreamPermissionRequested': {
      const name = await communityName(deps, d.communityId);
      return notify(deps, await managerIds(deps.db, d.communityId), {
        type,
        title: `${d.userName} pide permiso para transmitir`,
        body: `En ${name}. Actívalo en la lista de miembros si estás de acuerdo.`,
        link: `/c/${d.communityId}`,
      });
    }
    case 'MemberPermissionsChanged': {
      const name = await communityName(deps, d.communityId);
      if (d.canStreamChanged) {
        await notify(deps, [d.userId], {
          type,
          title: d.canStream ? `Ya puedes transmitir en ${name}` : `Se retiró tu permiso para transmitir en ${name}`,
          body: d.canStream ? 'Inicia un directo desde la página de la comunidad.' : 'Habla con quien administra la comunidad si crees que es un error.',
          link: `/c/${d.communityId}`,
        });
      }
      if (d.roleChanged) {
        await notify(deps, [d.userId], {
          type,
          title: d.role === 'moderator' ? `Ahora moderas ${name}` : `Ya no moderas ${name}`,
          body: d.role === 'moderator' ? 'Puedes dar permiso para transmitir y conservar grabaciones.' : '',
          link: `/c/${d.communityId}`,
        });
      }
      return;
    }
    case 'StreamStarted':
      return notify(deps, without(await memberIds(deps.db, d.communityId), d.hostId), {
        type,
        title: `${d.hostName} está en vivo en ${d.communityName}`,
        body: d.title,
        link: `/live/${d.streamId}`,
      });
    case 'NoteShared': {
      const name = await communityName(deps, d.communityId);
      return notify(deps, without(await memberIds(deps.db, d.communityId), d.userId), {
        type,
        title: `${d.userName} compartió «${d.title}»`,
        body: `En ${name}.`,
        link: `/notes/${d.noteId}`,
      });
    }
    case 'RecordingReady':
      return notify(deps, [d.hostId, ...(await managerIds(deps.db, d.communityId))], {
        type,
        title: `La grabación «${d.title}» está lista`,
        body: `Es provisional: se borrará el ${new Date(d.expiresAt).toLocaleString('es-PE', { timeZone: 'America/Lima' })} si nadie la conserva.`,
        link: `/c/${d.communityId}?tab=grabaciones`,
      });
    case 'RecordingKeepRequested':
      return notify(deps, without([d.hostId, ...(await managerIds(deps.db, d.communityId))], d.userId), {
        type,
        title: `${d.userName} pide conservar «${d.title}»`,
        body: 'Si no la conservas, se borrará al vencer el plazo provisional.',
        link: `/c/${d.communityId}?tab=grabaciones`,
      });
    case 'RecordingKept':
      return notify(deps, without(await managerIds(deps.db, d.communityId), d.byUserId), {
        type,
        title: `«${d.title}» se conservará`,
        body: `${d.byName} la conservó. Con el tiempo pasará a almacenamiento más barato.`,
        link: `/c/${d.communityId}?tab=grabaciones`,
      });
    case 'ReminderFire': // enviado por EventBridge Scheduler en AWS
      return fireReminder(deps, d.reminderId);
    case 'ReminderDue':
      return notify(deps, [d.userId], {
        type,
        title: d.kind === 'recording_expiry' ? 'Grabación por vencer' : 'Recordatorio',
        body: d.title,
        link: d.kind === 'recording_expiry' && d.communityId ? `/c/${d.communityId}?tab=grabaciones` : '/recordatorios',
      });
    default:
      return;
  }
}

async function publishDue(deps: Deps, r: { id: string; user_id: string; title: string; kind: string; ref_id: string | null }) {
  let communityId: string | undefined;
  if (r.kind === 'recording_expiry' && r.ref_id) {
    communityId = (await deps.db.one<{ community_id: string }>('SELECT community_id FROM recordings WHERE id = :id::uuid', { id: r.ref_id }))?.community_id;
  }
  await deps.bus.publish('ReminderDue', { reminderId: r.id, userId: r.user_id, title: r.title, kind: r.kind, communityId });
}

/** Local: el worker llama a esto cada pocos segundos. SKIP LOCKED evita duplicados si hay dos workers. */
export async function fireDueReminders(deps: Deps) {
  const due = await deps.db.query(
    `UPDATE reminders SET status = 'sent'
     WHERE id IN (SELECT id FROM reminders WHERE status = 'pending' AND fire_at <= now()
                  ORDER BY fire_at LIMIT 50 FOR UPDATE SKIP LOCKED)
     RETURNING id, user_id, title, kind, ref_id`,
  );
  for (const r of due) await publishDue(deps, r);
  return due.length;
}

export async function fireReminder(deps: Deps, id: string) {
  const r = await deps.db.one(
    `UPDATE reminders SET status = 'sent' WHERE id = :id::uuid AND status = 'pending' RETURNING id, user_id, title, kind, ref_id`,
    { id },
  );
  if (r) await publishDue(deps, r);
}

const CreateReminder = z.object({
  title: z.string().trim().min(1).max(200),
  fireAt: z.string().datetime({ offset: true }),
});

export const notificationRoutes = [
  route({
    method: 'GET',
    path: '/notifications',
    auth: 'user',
    async handler(req, deps) {
      return deps.notifications.latest(requireUser(req).id);
    },
  }),

  route({
    method: 'POST',
    path: '/notifications/read-all',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const unread = (await deps.notifications.latest(user.id)).filter((n) => !n.read);
      for (const n of unread) await deps.notifications.markRead(user.id, n.sk);
      return { updated: unread.length };
    },
  }),

  route({
    method: 'GET',
    path: '/reminders',
    auth: 'user',
    async handler(req, { db }) {
      return db.query(
        `SELECT id, title, fire_at AS "fireAt", status, kind FROM reminders
         WHERE user_id = :u::uuid AND (status = 'pending' OR fire_at > now() - interval '7 days')
         ORDER BY fire_at`,
        { u: requireUser(req).id },
      );
    },
  }),

  route({
    method: 'POST',
    path: '/reminders',
    auth: 'user',
    body: CreateReminder,
    async handler(req, deps) {
      const user = requireUser(req);
      const b = req.body as z.infer<typeof CreateReminder>;
      const fireAt = new Date(b.fireAt);
      if (fireAt.getTime() < Date.now() - 60_000) throw badRequest('La fecha ya pasó');
      if (fireAt.getTime() > Date.now() + 366 * 86_400_000) throw badRequest('Máximo un año a futuro');
      const r = await deps.db.one<{ id: string }>(
        `INSERT INTO reminders (user_id, title, fire_at) VALUES (:u::uuid, :t, :at) RETURNING id, title, fire_at AS "fireAt", status, kind`,
        { u: user.id, t: b.title, at: fireAt },
      );
      await deps.scheduler.schedule(r!.id, fireAt);
      return { status: 201, body: r };
    },
  }),

  route({
    method: 'DELETE',
    path: '/reminders/:id',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const r = await deps.db.one(
        `UPDATE reminders SET status = 'cancelled' WHERE id = :id::uuid AND user_id = :u::uuid AND status = 'pending' RETURNING id`,
        { id: idParam(req), u: user.id },
      );
      if (!r) throw notFound('El recordatorio no existe o ya se envió');
      await deps.scheduler.cancel(r.id);
      return { ok: true };
    },
  }),
];

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { route, requireUser, idParam, badRequest, forbidden, notFound, conflict } from '../core/http.js';
import { getCommunity, getMembership, requireMember, requireManager, isManager, canView } from './access.js';

// Sin caracteres que se confunden al dictarlos (0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const inviteCode = () => [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');

const CreateCommunity = z.object({
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(500).default(''),
  visibility: z.enum(['public', 'private']),
});

const UpdateMember = z
  .object({ role: z.enum(['moderator', 'member']).optional(), canStream: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.canStream !== undefined, 'Nada que cambiar');

const JoinByCode = z.object({ code: z.string().trim().toUpperCase().min(4).max(16) });

export const communityRoutes = [
  route({
    method: 'POST',
    path: '/communities',
    auth: 'user',
    body: CreateCommunity,
    async handler(req, { db }) {
      const user = requireUser(req);
      const b = req.body as z.infer<typeof CreateCommunity>;
      const community = await db.tx(async (tx) => {
        const c = await tx.one(
          `INSERT INTO communities (name, description, visibility, invite_code, owner_id)
           VALUES (:name, :description, :visibility, :code, :owner::uuid) RETURNING *`,
          { ...b, code: inviteCode(), owner: user.id },
        );
        // El creador puede transmitir desde el inicio
        await tx.query(
          `INSERT INTO memberships (community_id, user_id, role, can_stream) VALUES (:c::uuid, :u::uuid, 'owner', true)`,
          { c: c.id, u: user.id },
        );
        return c;
      });
      return { status: 201, body: community };
    },
  }),

  // Mis comunidades, con mi rol
  route({
    method: 'GET',
    path: '/communities',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      return db.query(
        `SELECT c.id, c.name, c.description, c.visibility, m.role, m.can_stream,
                (SELECT count(*)::int FROM memberships x WHERE x.community_id = c.id) AS members,
                EXISTS (SELECT 1 FROM stream_sessions s WHERE s.community_id = c.id AND s.status = 'live') AS live
         FROM memberships m JOIN communities c ON c.id = m.community_id
         WHERE m.user_id = :u::uuid ORDER BY c.name`,
        { u: user.id },
      );
    },
  }),

  // Comunidades públicas a las que aún no pertenezco
  route({
    method: 'GET',
    path: '/communities/discover',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      return db.query(
        `SELECT c.id, c.name, c.description, c.visibility,
                (SELECT count(*)::int FROM memberships x WHERE x.community_id = c.id) AS members
         FROM communities c
         WHERE c.visibility = 'public'
           AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.community_id = c.id AND m.user_id = :u::uuid)
         ORDER BY c.created_at DESC LIMIT 50`,
        { u: user.id },
      );
    },
  }),

  route({
    method: 'POST',
    path: '/communities/join-by-code',
    auth: 'user',
    body: JoinByCode,
    async handler(req, deps) {
      const user = requireUser(req);
      const { code } = req.body as z.infer<typeof JoinByCode>;
      const c = await deps.db.one<{ id: string }>('SELECT id FROM communities WHERE invite_code = :code', { code });
      if (!c) throw notFound('Código de invitación no válido');
      await join(deps, c.id, user);
      return { communityId: c.id };
    },
  }),

  route({
    method: 'GET',
    path: '/communities/:id',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      const c = await getCommunity(db, id);
      const me = await getMembership(db, id, user.id);
      if (!me && c.visibility === 'private') throw forbidden('Esta comunidad es privada');
      const members = me
        ? await db.query(
            `SELECT u.id, u.display_name AS name, u.email, m.role, m.can_stream, m.joined_at
             FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.community_id = :c::uuid
             ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END, u.display_name`,
            { c: id },
          )
        : [];
      return {
        id: c.id,
        name: c.name,
        description: c.description,
        visibility: c.visibility,
        ownerId: c.owner_id,
        // Solo quien administra ve el código de invitación
        inviteCode: isManager(me) ? c.invite_code : undefined,
        me: me ?? null,
        members,
      };
    },
  }),

  route({
    method: 'POST',
    path: '/communities/:id/join',
    auth: 'user',
    async handler(req, deps) {
      const user = requireUser(req);
      const id = idParam(req);
      const c = await getCommunity(deps.db, id);
      if (c.visibility !== 'public') throw forbidden('Las comunidades privadas requieren un código de invitación');
      await join(deps, id, user);
      return { ok: true };
    },
  }),

  route({
    method: 'POST',
    path: '/communities/:id/leave',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      const m = await requireMember(db, id, user.id);
      if (m.role === 'owner') throw badRequest('El creador no puede abandonar su comunidad');
      await db.query('DELETE FROM memberships WHERE community_id = :c::uuid AND user_id = :u::uuid', { c: id, u: user.id });
      return { ok: true };
    },
  }),

  // Cambiar rol o permiso de transmisión.
  // El creador cambia roles y permisos; un moderador solo da o quita el permiso a miembros.
  route({
    method: 'PATCH',
    path: '/communities/:id/members/:userId',
    auth: 'user',
    body: UpdateMember,
    async handler(req, { db, bus }) {
      const user = requireUser(req);
      const id = idParam(req);
      const targetId = idParam(req, 'userId');
      const b = req.body as z.infer<typeof UpdateMember>;
      const me = await requireManager(db, id, user.id);
      const target = await getMembership(db, id, targetId);
      if (!target) throw notFound('Esa persona no es miembro');
      if (target.role === 'owner') throw forbidden('No se pueden cambiar los permisos del creador');
      if (me.role === 'moderator' && (b.role !== undefined || target.role !== 'member')) {
        throw forbidden('Un moderador solo puede dar o quitar el permiso de transmitir a miembros');
      }
      const row = await db.one(
        `UPDATE memberships SET role = COALESCE(:role, role), can_stream = COALESCE(:canStream, can_stream)
         WHERE community_id = :c::uuid AND user_id = :u::uuid RETURNING role, can_stream`,
        { role: b.role ?? null, canStream: b.canStream ?? null, c: id, u: targetId },
      );
      await bus.publish('MemberPermissionsChanged', {
        communityId: id,
        userId: targetId,
        byUserId: user.id,
        role: row.role,
        canStream: row.can_stream,
        canStreamChanged: b.canStream !== undefined && b.canStream !== target.can_stream,
        roleChanged: b.role !== undefined && b.role !== target.role,
      });
      return row;
    },
  }),

  route({
    method: 'DELETE',
    path: '/communities/:id/members/:userId',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      const targetId = idParam(req, 'userId');
      const me = await requireManager(db, id, user.id);
      const target = await getMembership(db, id, targetId);
      if (!target) throw notFound('Esa persona no es miembro');
      if (target.role === 'owner' || (me.role === 'moderator' && target.role !== 'member')) throw forbidden();
      await db.query('DELETE FROM memberships WHERE community_id = :c::uuid AND user_id = :u::uuid', { c: id, u: targetId });
      return { ok: true };
    },
  }),

  route({
    method: 'POST',
    path: '/communities/:id/invite-code',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      const m = await requireMember(db, id, user.id);
      if (m.role !== 'owner') throw forbidden('Solo el creador puede regenerar el código');
      return db.one('UPDATE communities SET invite_code = :code WHERE id = :c::uuid RETURNING invite_code AS "inviteCode"', {
        code: inviteCode(),
        c: id,
      });
    },
  }),

  // Un miembro pide permiso para transmitir: avisa al creador y a los moderadores
  route({
    method: 'POST',
    path: '/communities/:id/stream-permission-requests',
    auth: 'user',
    async handler(req, { db, bus }) {
      const user = requireUser(req);
      const id = idParam(req);
      const m = await requireMember(db, id, user.id);
      if (m.can_stream) throw conflict('Ya tienes permiso para transmitir');
      await bus.publish('StreamPermissionRequested', { communityId: id, userId: user.id, userName: user.name });
      return { status: 202, body: { ok: true } };
    },
  }),

  // Apuntes compartidos con la comunidad
  route({
    method: 'GET',
    path: '/communities/:id/notes',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      if (!(await canView(db, id, user.id))) throw forbidden();
      return db.query(
        `SELECT n.id, n.title, n.updated_at, u.display_name AS author, s.shared_at,
                (SELECT count(*)::int FROM note_modules nm WHERE nm.note_id = n.id) AS modules
         FROM note_shares s JOIN notes n ON n.id = s.note_id JOIN users u ON u.id = n.owner_id
         WHERE s.community_id = :c::uuid AND n.deleted_at IS NULL
         ORDER BY s.shared_at DESC`,
        { c: id },
      );
    },
  }),
];

async function join({ db, bus }: import('../app/deps.js').Deps, communityId: string, user: { id: string; name: string }) {
  const inserted = await db.query(
    `INSERT INTO memberships (community_id, user_id, role) VALUES (:c::uuid, :u::uuid, 'member')
     ON CONFLICT DO NOTHING RETURNING user_id`,
    { c: communityId, u: user.id },
  );
  if (inserted.length) await bus.publish('MemberJoined', { communityId, userId: user.id, userName: user.name });
}

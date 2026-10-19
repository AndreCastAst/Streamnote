// Reglas de permisos de comunidades, compartidas por todos los dominios.
import type { Db } from '../core/db.js';
import { forbidden, notFound } from '../core/http.js';

export type Role = 'owner' | 'moderator' | 'member';

export interface Membership {
  role: Role;
  can_stream: boolean;
}

export interface CommunityRow {
  id: string;
  name: string;
  description: string;
  visibility: 'public' | 'private';
  invite_code: string;
  owner_id: string;
  created_at: string;
}

export async function getCommunity(db: Db, id: string): Promise<CommunityRow> {
  const c = await db.one<CommunityRow>('SELECT * FROM communities WHERE id = :id::uuid', { id });
  if (!c) throw notFound('La comunidad no existe');
  return c;
}

export async function getMembership(db: Db, communityId: string, userId: string): Promise<Membership | undefined> {
  return db.one<Membership>('SELECT role, can_stream FROM memberships WHERE community_id = :c::uuid AND user_id = :u::uuid', {
    c: communityId,
    u: userId,
  });
}

export async function requireMember(db: Db, communityId: string, userId: string): Promise<Membership> {
  const m = await getMembership(db, communityId, userId);
  if (!m) throw forbidden('Debes ser miembro de la comunidad');
  return m;
}

export const isManager = (m: Membership | undefined) => m?.role === 'owner' || m?.role === 'moderator';

export async function requireManager(db: Db, communityId: string, userId: string): Promise<Membership> {
  const m = await requireMember(db, communityId, userId);
  if (!isManager(m)) throw forbidden('Solo el creador o un moderador puede hacer esto');
  return m;
}

/** Ver contenido: miembros siempre; en comunidades públicas, cualquier usuario con sesión. */
export async function canView(db: Db, communityId: string, userId: string): Promise<boolean> {
  const c = await getCommunity(db, communityId);
  if (c.visibility === 'public') return true;
  return !!(await getMembership(db, communityId, userId));
}

export async function managerIds(db: Db, communityId: string): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>(
    `SELECT user_id FROM memberships WHERE community_id = :c::uuid AND role IN ('owner', 'moderator')`,
    { c: communityId },
  );
  return rows.map((r) => r.user_id);
}

export async function memberIds(db: Db, communityId: string): Promise<string[]> {
  const rows = await db.query<{ user_id: string }>('SELECT user_id FROM memberships WHERE community_id = :c::uuid', { c: communityId });
  return rows.map((r) => r.user_id);
}

// Carpetas del explorador de archivos. Cada usuario tiene su árbol (por parent_id); las carpetas
// del sistema («Directos» y una por comunidad) se crean solas para las notas de los directos.
import { z } from 'zod';
import type { Db } from '../core/db.js';
import { route, requireUser, idParam, badRequest, notFound, conflict } from '../core/http.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'UUID no válido');

const FolderName = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((s) => !s.includes('/'), 'El nombre no puede llevar «/»');

const CreateFolder = z.object({ name: FolderName, parentId: uuid.optional() });

// parentId: null = raíz; sin parentId = no mover
const UpdateFolder = z
  .object({ name: FolderName.optional(), parentId: uuid.nullable().optional() })
  .refine((v) => v.name !== undefined || v.parentId !== undefined, 'Nada que cambiar');

type FolderKind = 'user' | 'directos' | 'community';

interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  kind: FolderKind;
  community_id: string | null;
}

const FOLDER_COLUMNS = 'id, parent_id, name, kind, community_id';

const toFolder = (f: FolderRow) => ({ id: f.id, parentId: f.parent_id, name: f.name, kind: f.kind, communityId: f.community_id });

/** La carpeta si es del usuario; si no existe o es de otro, 404. */
export async function ownFolder(db: Db, userId: string, folderId: string): Promise<FolderRow> {
  const f = await db.one<FolderRow>(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE id = :id::uuid AND owner_id = :u::uuid`, {
    id: folderId,
    u: userId,
  });
  if (!f) throw notFound('La carpeta no existe');
  return f;
}

/** Violación de un índice único: `pg` la entrega con code 23505; el Data API, con el texto de Postgres. */
export function isUniqueViolation(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  if ((e as { code?: unknown }).code === '23505') return true;
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('duplicate key value violates unique constraint');
}

const MAX_SUFFIX = 50;

/**
 * Busca o crea una carpeta del sistema. INSERT ... ON CONFLICT DO NOTHING absorbe tanto el choque
 * con la carpeta del sistema que ya existe (o que otro pedido acaba de crear) como el choque de
 * nombre con una carpeta del usuario: si no devuelve fila y la del sistema no existe, el choque fue
 * de nombre y se reintenta con « (2)», « (3)»…
 */
async function systemFolder(
  db: Db,
  userId: string,
  kind: 'directos' | 'community',
  parentId: string | null,
  communityId: string | null,
  baseName: string,
): Promise<string> {
  const chars = Array.from(baseName);
  for (let n = 1; n <= MAX_SUFFIX; n++) {
    const suffix = n === 1 ? '' : ` (${n})`;
    const name = chars.slice(0, 120 - suffix.length).join('').trimEnd() + suffix;
    const inserted = await db.one<{ id: string }>(
      `INSERT INTO folders (owner_id, parent_id, name, kind, community_id)
       VALUES (:u::uuid, :p::uuid, :name, :kind, :c::uuid)
       ON CONFLICT DO NOTHING RETURNING id`,
      { u: userId, p: parentId, name, kind, c: communityId },
    );
    if (inserted) return inserted.id;
    const existing =
      kind === 'directos'
        ? await db.one<{ id: string }>(`SELECT id FROM folders WHERE owner_id = :u::uuid AND kind = 'directos'`, { u: userId })
        : await db.one<{ id: string }>(`SELECT id FROM folders WHERE owner_id = :u::uuid AND kind = 'community' AND community_id = :c::uuid`, {
            u: userId,
            c: communityId,
          });
    if (existing) return existing.id;
  }
  throw conflict('No se pudo crear la carpeta de los directos: hay demasiadas carpetas con ese nombre');
}

/** Carpeta «Directos / [comunidad]» del usuario; crea las que falten. Devuelve el id de la de la comunidad. */
export async function directosFolder(db: Db, userId: string, communityId: string, communityName: string): Promise<string> {
  const directos = await systemFolder(db, userId, 'directos', null, null, 'Directos');
  const base = Array.from(communityName.replaceAll('/', '-').trim()).slice(0, 120).join('') || 'Comunidad';
  return systemFolder(db, userId, 'community', directos, communityId, base);
}

export const folderRoutes = [
  // Árbol del usuario: carpetas y archivos (hoy solo notas); el cliente lo arma
  route({
    method: 'GET',
    path: '/files',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const folders = await db.query<FolderRow>(`SELECT ${FOLDER_COLUMNS} FROM folders WHERE owner_id = :u::uuid`, { u: user.id });
      const notes = await db.query<{
        id: string;
        title: string;
        folder_id: string | null;
        updated_at: string;
        stream_id: string | null;
        locked: boolean;
        community_id: string | null;
        community_name: string | null;
      }>(
        `SELECT n.id, n.title, n.folder_id, n.updated_at, n.stream_id, n.locked, c.id AS community_id, c.name AS community_name
         FROM notes n LEFT JOIN communities c ON c.id = n.community_id
         WHERE n.owner_id = :u::uuid AND n.deleted_at IS NULL`,
        { u: user.id },
      );
      return {
        folders: folders.map(toFolder),
        items: notes.map((n) => ({
          kind: 'note' as const,
          id: n.id,
          title: n.title,
          folderId: n.folder_id,
          updatedAt: n.updated_at,
          streamId: n.stream_id,
          locked: n.locked,
          community: n.community_id ? { id: n.community_id, name: n.community_name } : null,
        })),
      };
    },
  }),

  route({
    method: 'POST',
    path: '/folders',
    auth: 'user',
    body: CreateFolder,
    async handler(req, { db }) {
      const user = requireUser(req);
      const b = req.body as z.infer<typeof CreateFolder>;
      if (b.parentId) await ownFolder(db, user.id, b.parentId);
      // Con kind = 'user' el único índice que puede chocar es el del nombre
      const f = await db.one<FolderRow>(
        `INSERT INTO folders (owner_id, parent_id, name) VALUES (:u::uuid, :p::uuid, :name)
         ON CONFLICT DO NOTHING RETURNING ${FOLDER_COLUMNS}`,
        { u: user.id, p: b.parentId ?? null, name: b.name },
      );
      if (!f) throw conflict('Ya existe una carpeta con ese nombre aquí');
      return { status: 201, body: toFolder(f) };
    },
  }),

  // Renombrar y mover
  route({
    method: 'PATCH',
    path: '/folders/:id',
    auth: 'user',
    body: UpdateFolder,
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      const b = req.body as z.infer<typeof UpdateFolder>;
      const folder = await ownFolder(db, user.id, id);
      if (b.parentId) await ownFolder(db, user.id, b.parentId);
      const moving = b.parentId !== undefined && b.parentId !== folder.parent_id;
      if (moving) {
        if (folder.kind !== 'user') throw badRequest('Las carpetas del sistema no se pueden mover');
        if (b.parentId) {
          // Subir desde el destino hasta la raíz: si pasa por la carpeta, el destino es ella o una descendiente
          const loop = await db.one(
            `WITH RECURSIVE up AS (
               SELECT id, parent_id FROM folders WHERE id = :target::uuid
               UNION
               SELECT f.id, f.parent_id FROM folders f JOIN up ON f.id = up.parent_id
             )
             SELECT 1 AS found FROM up WHERE id = :id::uuid`,
            { target: b.parentId, id },
          );
          if (loop) throw badRequest('No puedes mover una carpeta dentro de sí misma');
        }
      }
      const name = b.name ?? folder.name;
      const parentId = b.parentId === undefined ? folder.parent_id : b.parentId;
      const taken = await db.one(
        `SELECT 1 AS found FROM folders
         WHERE owner_id = :u::uuid AND parent_id IS NOT DISTINCT FROM :p::uuid AND lower(name) = lower(:name) AND id <> :id::uuid`,
        { u: user.id, p: parentId, name, id },
      );
      if (taken) throw conflict('Ya existe una carpeta con ese nombre aquí');
      // Fuera de transacción: si otro pedido gana la carrera, el error del índice no aborta nada
      try {
        const updated = await db.one<FolderRow>(
          `UPDATE folders SET name = :name, parent_id = :p::uuid WHERE id = :id::uuid RETURNING ${FOLDER_COLUMNS}`,
          { name, p: parentId, id },
        );
        return toFolder(updated!);
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict('Ya existe una carpeta con ese nombre aquí');
        throw e;
      }
    },
  }),

  // Solo si está vacía (sin subcarpetas ni notas no borradas)
  route({
    method: 'DELETE',
    path: '/folders/:id',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      await db.tx(async (tx) => {
        await ownFolder(tx, user.id, id);
        const busy = await tx.one(
          `SELECT 1 AS found
           WHERE EXISTS (SELECT 1 FROM folders WHERE parent_id = :id::uuid)
              OR EXISTS (SELECT 1 FROM notes WHERE folder_id = :id::uuid AND deleted_at IS NULL)`,
          { id },
        );
        if (busy) throw conflict('La carpeta no está vacía');
        // Las notas borradas que aún la referencian no deben impedir el borrado
        await tx.query('UPDATE notes SET folder_id = NULL WHERE folder_id = :id::uuid AND deleted_at IS NOT NULL', { id });
        await tx.query('DELETE FROM folders WHERE id = :id::uuid', { id });
      });
      return { ok: true };
    },
  }),

  // Vaciar: borra las notas que están directamente en la carpeta (no las de sus subcarpetas)
  route({
    method: 'POST',
    path: '/folders/:id/empty',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const id = idParam(req);
      await ownFolder(db, user.id, id);
      // Una sola sentencia (atómica): marca las notas como borradas y quita sus filas de note_shares
      const r = await db.one<{ deleted: number }>(
        `WITH del AS (
           UPDATE notes SET deleted_at = now()
           WHERE owner_id = :u::uuid AND folder_id = :id::uuid AND deleted_at IS NULL
           RETURNING id
         ), unshared AS (
           DELETE FROM note_shares WHERE note_id IN (SELECT id FROM del)
         )
         SELECT count(*)::int AS deleted FROM del`,
        { u: user.id, id },
      );
      return { deleted: Number(r?.deleted ?? 0) };
    },
  }),
];

// Notas modulares. Una nota es una lista ordenada de módulos (texto, título, código,
// lista de tareas, cita). El autoguardado no escribe en la base: deja la nota en una
// cola SQS y responde 202 al instante (RNF-03). Un consumidor la aplica en orden de versión.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../app/deps.js';
import type { Db } from '../core/db.js';
import { route, requireUser, idParam, badRequest, forbidden, notFound } from '../core/http.js';
import { canView, requireMember } from './access.js';

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'UUID no válido');
const str = (max: number) => z.string().max(max);

export const ModuleSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), content: z.object({ text: str(20000) }) }),
  z.object({ type: z.literal('heading'), content: z.object({ text: str(300), level: z.union([z.literal(1), z.literal(2)]) }) }),
  z.object({ type: z.literal('code'), content: z.object({ code: str(20000), language: str(30) }) }),
  z.object({
    type: z.literal('checklist'),
    content: z.object({ items: z.array(z.object({ text: str(500), done: z.boolean() })).max(200) }),
  }),
  z.object({ type: z.literal('quote'), content: z.object({ text: str(5000), cite: str(200).optional() }) }),
]);

const NoteModule = z.intersection(
  z.object({ id: uuid, sourceModuleId: uuid.nullish(), sourceAuthor: str(80).nullish() }),
  ModuleSchema,
);
export type NoteModule = z.infer<typeof NoteModule>;

const CreateNote = z.object({
  title: z.string().trim().min(1).max(200),
  streamId: uuid.optional(),
  modules: z.array(NoteModule).max(500).optional(),
});

const SaveNote = z.object({
  opId: uuid,
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  modules: z.array(NoteModule).max(500),
});
type SaveNote = z.infer<typeof SaveNote>;

export interface NoteWriteMessage extends SaveNote {
  noteId: string;
  userId: string;
}

const MAX_NOTE_BYTES = 200_000; // margen bajo el límite de un mensaje de SQS

async function loadNote(db: Db, id: string) {
  const note = await db.one<{ id: string; owner_id: string; title: string; version: string; stream_id: string | null; updated_at: string }>(
    'SELECT id, owner_id, title, version, stream_id, updated_at FROM notes WHERE id = :id::uuid AND deleted_at IS NULL',
    { id },
  );
  if (!note) throw notFound('La nota no existe');
  return note;
}

async function loadModules(db: Db, noteId: string) {
  const rows = await db.query<{ id: string; type: string; content: unknown; source_module_id: string | null; source_author: string | null }>(
    'SELECT id, type, content, source_module_id, source_author FROM note_modules WHERE note_id = :n::uuid ORDER BY position',
    { n: noteId },
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    content: typeof r.content === 'string' ? JSON.parse(r.content) : r.content,
    sourceModuleId: r.source_module_id,
    sourceAuthor: r.source_author,
  }));
}

/** El dueño puede editar; los miembros de una comunidad con la que se compartió pueden leer. */
async function readAccess(db: Db, noteId: string, ownerId: string, userId: string) {
  if (ownerId === userId) return 'edit' as const;
  const shares = await db.query<{ community_id: string }>('SELECT community_id FROM note_shares WHERE note_id = :n::uuid', { n: noteId });
  for (const s of shares) if (await canView(db, s.community_id, userId)) return 'read' as const;
  return null;
}

async function insertModules(db: Db, noteId: string, modules: NoteModule[]) {
  let position = 0;
  for (const m of modules) {
    await db.query(
      `INSERT INTO note_modules (id, note_id, position, type, content, source_module_id, source_author)
       VALUES (:id::uuid, :noteId::uuid, :position, :type, :content::jsonb, :src::uuid, :author)`,
      { id: m.id, noteId, position: position++, type: m.type, content: m.content, src: m.sourceModuleId ?? null, author: m.sourceAuthor ?? null },
    );
  }
}

const emptyText = (): NoteModule => ({ id: randomUUID(), type: 'text', content: { text: '' } });

export const noteRoutes = [
  route({
    method: 'GET',
    path: '/notes',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      return db.query(
        `SELECT n.id, n.title, n.updated_at, n.version, n.stream_id,
                (SELECT count(*)::int FROM note_modules m WHERE m.note_id = n.id) AS modules,
                (SELECT coalesce(json_agg(json_build_object('id', c.id, 'name', c.name)), '[]'::json)
                   FROM note_shares s JOIN communities c ON c.id = s.community_id WHERE s.note_id = n.id) AS shared_with
         FROM notes n WHERE n.owner_id = :u::uuid AND n.deleted_at IS NULL
         ORDER BY n.updated_at DESC`,
        { u: user.id },
      );
    },
  }),

  route({
    method: 'POST',
    path: '/notes',
    auth: 'user',
    body: CreateNote,
    async handler(req, { db }) {
      const user = requireUser(req);
      const b = req.body as z.infer<typeof CreateNote>;
      const note = await db.tx(async (tx) => {
        const n = await tx.one<{ id: string }>(
          `INSERT INTO notes (owner_id, title, stream_id) VALUES (:u::uuid, :title, :stream::uuid) RETURNING id, title, version, created_at`,
          { u: user.id, title: b.title, stream: b.streamId ?? null },
        );
        await insertModules(tx, n!.id, b.modules?.length ? b.modules : [emptyText()]);
        return n;
      });
      return { status: 201, body: note };
    },
  }),

  route({
    method: 'GET',
    path: '/notes/:id',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const note = await loadNote(db, idParam(req));
      const access = await readAccess(db, note.id, note.owner_id, user.id);
      if (!access) throw forbidden('No tienes acceso a esta nota');
      const author = await db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = :u::uuid', { u: note.owner_id });
      const shares = await db.query(
        `SELECT c.id, c.name FROM note_shares s JOIN communities c ON c.id = s.community_id WHERE s.note_id = :n::uuid`,
        { n: note.id },
      );
      return {
        id: note.id,
        title: note.title,
        version: Number(note.version),
        streamId: note.stream_id,
        updatedAt: note.updated_at,
        author: author?.display_name,
        canEdit: access === 'edit',
        sharedWith: access === 'edit' ? shares : [],
        modules: await loadModules(db, note.id),
      };
    },
  }),

  // Autoguardado: valida, encola y responde. El consumidor aplica la versión más nueva.
  route({
    method: 'PUT',
    path: '/notes/:id',
    auth: 'user',
    body: SaveNote,
    async handler(req, { db, queue, cfg }) {
      const user = requireUser(req);
      const id = idParam(req);
      const b = req.body as SaveNote;
      const note = await loadNote(db, id);
      if (note.owner_id !== user.id) throw forbidden('Solo el autor puede editar esta nota');
      const ids = new Set(b.modules.map((m) => m.id));
      if (ids.size !== b.modules.length) throw badRequest('Hay módulos con el mismo id');
      const message: NoteWriteMessage = { ...b, noteId: id, userId: user.id };
      if (Buffer.byteLength(JSON.stringify(message)) > MAX_NOTE_BYTES) throw badRequest('La nota es demasiado grande');
      await queue.send(cfg.resources.noteWritesQueueUrl, message);
      return { status: 202, body: { accepted: true, version: b.version } };
    },
  }),

  route({
    method: 'DELETE',
    path: '/notes/:id',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const note = await loadNote(db, idParam(req));
      if (note.owner_id !== user.id) throw forbidden();
      await db.query('UPDATE notes SET deleted_at = now() WHERE id = :n::uuid', { n: note.id });
      await db.query('DELETE FROM note_shares WHERE note_id = :n::uuid', { n: note.id });
      return { ok: true };
    },
  }),

  // Copiar a mis notas una nota compartida (los módulos guardan de dónde vienen)
  route({
    method: 'POST',
    path: '/notes/:id/copy',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const note = await loadNote(db, idParam(req));
      if (!(await readAccess(db, note.id, note.owner_id, user.id))) throw forbidden();
      const author = await db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = :u::uuid', { u: note.owner_id });
      const modules = (await loadModules(db, note.id)).map((m) => ({
        ...m,
        id: randomUUID(),
        sourceModuleId: m.sourceModuleId ?? m.id,
        sourceAuthor: m.sourceAuthor ?? author?.display_name ?? null,
      })) as NoteModule[];
      const copy = await db.tx(async (tx) => {
        const n = await tx.one<{ id: string }>(`INSERT INTO notes (owner_id, title) VALUES (:u::uuid, :t) RETURNING id, title`, {
          u: user.id,
          t: `${note.title} (copia)`,
        });
        await insertModules(tx, n!.id, modules);
        return n;
      });
      return { status: 201, body: copy };
    },
  }),

  route({
    method: 'POST',
    path: '/notes/:id/shares',
    auth: 'user',
    body: z.object({ communityId: uuid }),
    async handler(req, { db, bus }) {
      const user = requireUser(req);
      const note = await loadNote(db, idParam(req));
      if (note.owner_id !== user.id) throw forbidden('Solo el autor puede compartir la nota');
      const { communityId } = req.body as { communityId: string };
      await requireMember(db, communityId, user.id);
      const rows = await db.query(
        `INSERT INTO note_shares (note_id, community_id, shared_by) VALUES (:n::uuid, :c::uuid, :u::uuid)
         ON CONFLICT DO NOTHING RETURNING note_id`,
        { n: note.id, c: communityId, u: user.id },
      );
      if (rows.length) {
        await bus.publish('NoteShared', { noteId: note.id, title: note.title, communityId, userId: user.id, userName: user.name });
      }
      return { status: 201, body: { ok: true } };
    },
  }),

  route({
    method: 'DELETE',
    path: '/notes/:id/shares/:communityId',
    auth: 'user',
    async handler(req, { db }) {
      const user = requireUser(req);
      const note = await loadNote(db, idParam(req));
      if (note.owner_id !== user.id) throw forbidden();
      await db.query('DELETE FROM note_shares WHERE note_id = :n::uuid AND community_id = :c::uuid', {
        n: note.id,
        c: idParam(req, 'communityId'),
      });
      return { ok: true };
    },
  }),
];

/**
 * Consumidor de la cola de escrituras.
 * - Idempotente: cada opId se aplica una sola vez aunque SQS entregue el mensaje dos veces.
 * - Ordenado: solo se aplica si su versión es mayor que la guardada (SQS estándar no garantiza orden).
 */
export async function applyNoteWrite({ db }: Pick<Deps, 'db'>, msg: NoteWriteMessage): Promise<'applied' | 'duplicate' | 'stale'> {
  return db.tx(async (tx) => {
    const fresh = await tx.query('INSERT INTO processed_ops (op_id) VALUES (:op::uuid) ON CONFLICT DO NOTHING RETURNING op_id', { op: msg.opId });
    if (!fresh.length) return 'duplicate';
    const updated = await tx.query(
      `UPDATE notes SET title = :title, version = :v, updated_at = now()
       WHERE id = :n::uuid AND owner_id = :u::uuid AND deleted_at IS NULL AND version < :v
       RETURNING id`,
      { title: msg.title, v: msg.version, n: msg.noteId, u: msg.userId },
    );
    if (!updated.length) return 'stale';
    await tx.query('DELETE FROM note_modules WHERE note_id = :n::uuid', { n: msg.noteId });
    await insertModules(tx, msg.noteId, msg.modules);
    return 'applied';
  });
}

// Notas modulares. Una nota es una lista ordenada de módulos (texto, título, código,
// lista de tareas, cita). El autoguardado no escribe en la base: deja la nota en una
// cola SQS y responde 202 al instante (RNF-03). Un consumidor la aplica en orden de versión.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../app/deps.js';
import type { Db } from '../core/db.js';
import { route, requireUser, idParam, badRequest, forbidden, notFound, conflict } from '../core/http.js';
import { canView, getMembership, requireMember } from './access.js';
import { directosFolder, ownFolder } from './folders.js';

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

// Acomodo en una cuadrícula de 12 columnas, en unidades de cuadrícula. El alto es un mínimo:
// el cliente lo agranda al dibujar si el contenido no cabe.
export const GRID_COLS = 12;
export const MAX_H = 200;

const Layout = z
  .object({
    x: z.number().int().min(0).max(GRID_COLS - 1),
    y: z.number().int().min(0).max(100_000),
    w: z.number().int().min(1).max(GRID_COLS),
    h: z.number().int().min(1).max(MAX_H),
  })
  .refine((l) => l.x + l.w <= GRID_COLS, { message: 'El módulo se sale de la cuadrícula' });
type Layout = z.infer<typeof Layout>;

// Opcional: los mensajes viejos de la cola y los clientes desactualizados no lo traen.
const NoteModule = z.intersection(
  z.object({ id: uuid, sourceModuleId: uuid.nullish(), sourceAuthor: str(80).nullish(), layout: Layout.optional() }),
  ModuleSchema,
);
export type NoteModule = z.infer<typeof NoteModule>;

/** Alto inicial por tipo (los mismos valores que la migración 002). */
export function defaultHeight(type: NoteModule['type']): number {
  switch (type) {
    case 'heading':
      return 2;
    case 'code':
      return 5;
    case 'text':
    case 'quote':
    case 'checklist':
      return 3;
  }
}

const CreateNote = z.object({
  title: z.string().trim().min(1).max(200),
  streamId: uuid.optional(),
  folderId: uuid.optional(), // se ignora si hay streamId: la nota va a «Directos / [comunidad]»
  modules: z.array(NoteModule).max(500).optional(),
});

const MoveNote = z.object({ folderId: uuid.nullable() }); // null = raíz

const UnlinkNote = z.object({ version: z.number().int().positive().optional() });

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

interface NoteRow {
  id: string;
  owner_id: string;
  title: string;
  version: string;
  stream_id: string | null;
  updated_at: string;
  folder_id: string | null;
  community_id: string | null; // vinculada: quienes ven la comunidad la leen
  locked: boolean; // copia congelada: nadie la edita
}

async function loadNote(db: Db, id: string): Promise<NoteRow> {
  const note = await db.one<NoteRow>(
    `SELECT id, owner_id, title, version, stream_id, updated_at, folder_id, community_id, locked
     FROM notes WHERE id = :id::uuid AND deleted_at IS NULL`,
    { id },
  );
  if (!note) throw notFound('La nota no existe');
  return note;
}

async function loadModules(db: Db, noteId: string) {
  const rows = await db.query<{
    id: string;
    type: string;
    content: unknown;
    source_module_id: string | null;
    source_author: string | null;
    x: number;
    y: number;
    w: number;
    h: number;
  }>(
    'SELECT id, type, content, source_module_id, source_author, x, y, w, h FROM note_modules WHERE note_id = :n::uuid ORDER BY position',
    { n: noteId },
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    content: typeof r.content === 'string' ? JSON.parse(r.content) : r.content,
    sourceModuleId: r.source_module_id,
    sourceAuthor: r.source_author,
    layout: { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h) },
  }));
}

/**
 * El dueño puede editar (salvo una copia congelada, que solo lee); pueden leer quienes ven una
 * comunidad con la que se compartió o la comunidad a la que está vinculada (en las públicas,
 * también los no miembros: ven, pero no participan). Las copias congeladas también tienen
 * comunidad y siguen en solo lectura para todos.
 */
async function readAccess(db: Db, note: NoteRow, userId: string): Promise<'edit' | 'read' | null> {
  if (note.owner_id === userId) return note.locked ? 'read' : 'edit';
  const shares = await db.query<{ community_id: string }>('SELECT community_id FROM note_shares WHERE note_id = :n::uuid', { n: note.id });
  for (const s of shares) if (await canView(db, s.community_id, userId)) return 'read';
  if (note.community_id && (await canView(db, note.community_id, userId))) return 'read';
  return null;
}

/**
 * Inserta los módulos con su acomodo. Los que llegan sin acomodo van al final, a ancho completo,
 * apilados en el orden en que llegaron. `position` es el orden de lectura: (y, x), y a igualdad,
 * el orden del arreglo. No se validan solapamientos: el cliente los resuelve al dibujar.
 */
async function insertModules(db: Db, noteId: string, modules: NoteModule[]) {
  let bottom = modules.reduce((max, m) => (m.layout ? Math.max(max, m.layout.y + m.layout.h) : max), 0);
  const placed = modules.map((m, index) => {
    let layout: Layout | undefined = m.layout;
    if (!layout) {
      layout = { x: 0, y: bottom, w: GRID_COLS, h: defaultHeight(m.type) };
      bottom += layout.h;
    }
    return { m, layout, index };
  });
  placed.sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x || a.index - b.index);
  let position = 0;
  for (const { m, layout } of placed) {
    await db.query(
      `INSERT INTO note_modules (id, note_id, position, type, content, source_module_id, source_author, x, y, w, h)
       VALUES (:id::uuid, :noteId::uuid, :position, :type, :content::jsonb, :src::uuid, :author, :x, :y, :w, :h)`,
      {
        id: m.id,
        noteId,
        position: position++,
        type: m.type,
        content: m.content,
        src: m.sourceModuleId ?? null,
        author: m.sourceAuthor ?? null,
        x: layout.x,
        y: layout.y,
        w: layout.w,
        h: layout.h,
      },
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
    async handler(req, { db, realtime }) {
      const user = requireUser(req);
      const b = req.body as z.infer<typeof CreateNote>;
      // Nota de un directo: va a «Directos / [comunidad]» y queda vinculada a la comunidad.
      // Solo los miembros toman notas: un no miembro de una pública ve el directo, pero no participa.
      let stream: { community_id: string; name: string } | undefined;
      if (b.streamId) {
        stream = await db.one<{ community_id: string; name: string }>(
          'SELECT s.community_id, c.name FROM stream_sessions s JOIN communities c ON c.id = s.community_id WHERE s.id = :id::uuid',
          { id: b.streamId },
        );
        if (!stream) throw notFound('El directo no existe');
        if (!(await canView(db, stream.community_id, user.id))) throw forbidden('No tienes acceso a este directo');
        if (!(await getMembership(db, stream.community_id, user.id))) throw forbidden('Únete a la comunidad para tomar notas en este directo');
      } else if (b.folderId) {
        await ownFolder(db, user.id, b.folderId);
      }
      const communityId = stream?.community_id ?? null;
      const note = await db.tx(async (tx) => {
        const folderId = stream ? await directosFolder(tx, user.id, stream.community_id, stream.name) : (b.folderId ?? null);
        const n = await tx.one<{ id: string }>(
          `INSERT INTO notes (owner_id, title, stream_id, folder_id, community_id)
           VALUES (:u::uuid, :title, :stream::uuid, :folder::uuid, :community::uuid)
           RETURNING id, title, version, created_at`,
          { u: user.id, title: b.title, stream: b.streamId ?? null, folder: folderId, community: communityId },
        );
        await insertModules(tx, n!.id, b.modules?.length ? b.modules : [emptyText()]);
        return n;
      });
      // Una pestaña nueva aparece en el cuadro de los demás sin esperar a su primer guardado
      if (b.streamId) await notifyNoteUpdated({ db, realtime }, note!.id);
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
      const access = await readAccess(db, note, user.id);
      if (!access) throw forbidden('No tienes acceso a esta nota');
      const author = await db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = :u::uuid', { u: note.owner_id });
      const shares = await db.query(
        `SELECT c.id, c.name FROM note_shares s JOIN communities c ON c.id = s.community_id WHERE s.note_id = :n::uuid`,
        { n: note.id },
      );
      const community = note.community_id
        ? await db.one<{ id: string; name: string }>('SELECT id, name FROM communities WHERE id = :c::uuid', { c: note.community_id })
        : undefined;
      return {
        id: note.id,
        title: note.title,
        version: Number(note.version),
        streamId: note.stream_id,
        updatedAt: note.updated_at,
        author: author?.display_name,
        canEdit: access === 'edit', // falso en una copia congelada, también para su autor
        isOwner: note.owner_id === user.id,
        locked: note.locked,
        folderId: note.folder_id,
        community: community ?? null,
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
      if (note.locked) throw conflict('La nota está congelada');
      const ids = new Set(b.modules.map((m) => m.id));
      if (ids.size !== b.modules.length) throw badRequest('Hay módulos con el mismo id');
      const message: NoteWriteMessage = { ...b, noteId: id, userId: user.id };
      if (Buffer.byteLength(JSON.stringify(message)) > MAX_NOTE_BYTES) throw badRequest('La nota es demasiado grande');
      await queue.send(cfg.resources.noteWritesQueueUrl, message);
      return { status: 202, body: { accepted: true, version: b.version } };
    },
  }),

  // Mover a otra carpeta propia (o a la raíz). No pasa por la cola: no toca version ni updated_at.
  route({
    method: 'PATCH',
    path: '/notes/:id',
    auth: 'user',
    body: MoveNote,
    async handler(req, { db }) {
      const user = requireUser(req);
      const note = await loadNote(db, idParam(req));
      if (note.owner_id !== user.id) throw forbidden();
      const { folderId } = req.body as z.infer<typeof MoveNote>;
      if (folderId) await ownFolder(db, user.id, folderId);
      await db.query('UPDATE notes SET folder_id = :f::uuid WHERE id = :n::uuid', { f: folderId, n: note.id });
      return { id: note.id, folderId };
    },
  }),

  // Desligar de la comunidad: la nota queda solo para su autor y la comunidad se queda con una
  // copia congelada de este momento, en «Directos / [comunidad]» del autor.
  route({
    method: 'POST',
    path: '/notes/:id/unlink',
    auth: 'user',
    body: UnlinkNote,
    async handler(req, { db }) {
      const user = requireUser(req);
      const note = await loadNote(db, idParam(req));
      if (note.owner_id !== user.id) throw forbidden('Solo el autor puede desligar la nota');
      const communityId = note.community_id;
      if (!communityId) throw badRequest('La nota no está vinculada a una comunidad');
      if (note.locked) throw badRequest('Una copia congelada no se puede desligar');
      if (note.stream_id) {
        const s = await db.one<{ status: string }>('SELECT status FROM stream_sessions WHERE id = :s::uuid', { s: note.stream_id });
        if (s?.status === 'live') throw conflict('Desliga la nota cuando termine el directo');
      }
      // El cliente manda la última versión que envió: si la cola aún no la aplicó, la copia saldría sin esos cambios
      const { version } = req.body as z.infer<typeof UnlinkNote>;
      if (version !== undefined && version > Number(note.version)) throw conflict('La nota todavía se está guardando; intenta en un momento');
      const frozenId = await db.tx(async (tx) => {
        // Primero la original: si dos pedidos llegan a la vez, el segundo espera el bloqueo y ya no la encuentra vinculada
        const released = await tx.one(
          `UPDATE notes SET community_id = NULL, stream_id = NULL
           WHERE id = :n::uuid AND community_id = :c::uuid AND NOT locked AND deleted_at IS NULL RETURNING id`,
          { n: note.id, c: communityId },
        );
        if (!released) throw conflict('La nota ya no está vinculada a la comunidad');
        await tx.query('DELETE FROM note_shares WHERE note_id = :n::uuid AND community_id = :c::uuid', { n: note.id, c: communityId });
        const c = await tx.one<{ name: string }>('SELECT name FROM communities WHERE id = :c::uuid', { c: communityId });
        const folder = await directosFolder(tx, user.id, communityId, c?.name ?? 'Comunidad');
        const frozen = await tx.one<{ id: string }>(
          `INSERT INTO notes (owner_id, title, stream_id, community_id, locked, folder_id)
           VALUES (:u::uuid, :t, :s::uuid, :c::uuid, true, :f::uuid) RETURNING id`,
          { u: user.id, t: note.title, s: note.stream_id, c: communityId, f: folder },
        );
        // Los módulos tal cual (mismos ids: la clave es (note_id, id)), con su acomodo y su trazabilidad
        await insertModules(tx, frozen!.id, (await loadModules(tx, note.id)) as NoteModule[]);
        return frozen!.id;
      });
      return { id: note.id, frozenId };
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
      if (!(await readAccess(db, note, user.id))) throw forbidden();
      // Leer basta con ver la comunidad; copiar es participar: hay que ser miembro de la comunidad
      // por la que llega (la vinculada o alguna con la que se compartió)
      if (note.owner_id !== user.id) {
        const member = await db.one(
          `SELECT 1 FROM memberships m WHERE m.user_id = :u::uuid
             AND (m.community_id = :c::uuid OR m.community_id IN (SELECT s.community_id FROM note_shares s WHERE s.note_id = :n::uuid))`,
          { u: user.id, c: note.community_id, n: note.id },
        );
        if (!member) throw forbidden('Únete a la comunidad para copiar esta nota');
      }
      const author = await db.one<{ display_name: string }>('SELECT display_name FROM users WHERE id = :u::uuid', { u: note.owner_id });
      const modules = (await loadModules(db, note.id)).map((m) => ({
        ...m,
        id: randomUUID(),
        sourceModuleId: m.sourceModuleId ?? m.id,
        sourceAuthor: m.sourceAuthor ?? author?.display_name ?? null,
      })) as NoteModule[];
      const copy = await db.tx(async (tx) => {
        // Sin folder_id, community_id ni locked: la copia va a la raíz, privada y editable
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
 * Avisa en el canal del directo que una nota del directo se creó o cambió, para que los demás
 * recarguen ese espacio. Solo las vinculadas y no congeladas: el canal lo escucha cualquiera que
 * vea la comunidad, y de una privada se filtrarían su título y su existencia.
 * Nunca lanza: se llama después de aplicar el guardado, y un error ahí dejaría el mensaje en la
 * cola, cuyo reintento ya sería 'duplicate' (el aviso es un extra, no parte del guardado).
 */
export async function notifyNoteUpdated({ db, realtime }: Pick<Deps, 'db' | 'realtime'>, noteId: string): Promise<void> {
  try {
    const n = await db.one<{ stream_id: string | null; community_id: string | null; locked: boolean; owner_id: string; version: string; title: string }>(
      'SELECT stream_id, community_id, locked, owner_id, version, title FROM notes WHERE id = :id::uuid AND deleted_at IS NULL',
      { id: noteId },
    );
    if (!n?.stream_id || !n.community_id || n.locked) return;
    await realtime.publish({
      channel: `stream:${n.stream_id}`,
      type: 'note.updated',
      data: { noteId, ownerId: n.owner_id, version: Number(n.version), title: n.title },
    });
  } catch {
    // Se ignora: perder un aviso solo retrasa la actualización de un cuadro del tablero
  }
}

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

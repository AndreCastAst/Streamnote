// Lógica pura del árbol de archivos («Mis archivos») y de las pestañas de la vista de trabajo (sin React).
// Solo sintaxis que Node puede borrar al quitar los tipos: la prueban web/test/files.test.ts con `node --test`.

/** Carpeta del usuario tal como la devuelve `GET /files`. */
export interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'user' | 'directos' | 'community';
  communityId: string | null;
}

/** Elemento del árbol: por ahora solo notas (`kind` deja la puerta abierta a otros archivos). */
export interface FileItem {
  kind: 'note';
  id: string;
  title: string;
  folderId: string | null;
  updatedAt: string;
  streamId: string | null;
  locked: boolean;
  community: { id: string; name: string } | null;
}

/** Nodo del árbol; `folder: null` es la raíz. */
export interface TreeNode {
  folder: FolderRow | null;
  folders: TreeNode[];
  items: FileItem[];
}

/** Pestañas abiertas en la vista de trabajo, de izquierda a derecha. */
export interface TabsState {
  open: string[];
  active: string | null;
}

/** Título que se muestra: las notas sin título aparecen como «Nota sin título». */
export const displayTitle = (t: string) => t.trim() || 'Nota sin título';

const compare = (a: string, b: string) => a.localeCompare(b, 'es', { sensitivity: 'base', numeric: true });

/** Copia ordenada del árbol: en cada nivel, primero las carpetas y luego las notas, en orden alfabético. */
export function sortNodes(node: TreeNode): TreeNode {
  return {
    folder: node.folder,
    folders: node.folders.map(sortNodes).sort((a, b) => compare(a.folder?.name ?? '', b.folder?.name ?? '')),
    items: [...node.items].sort((a, b) => compare(displayTitle(a.title), displayTitle(b.title))),
  };
}

/** Verdadero si, subiendo por los padres desde `f`, se vuelve a `f` (la carpeta está en un ciclo). */
function inCycle(byId: Map<string, FolderRow>, f: FolderRow): boolean {
  const seen = new Set<string>();
  let parent = f.parentId;
  while (parent !== null && !seen.has(parent)) {
    if (parent === f.id) return true;
    seen.add(parent);
    parent = byId.get(parent)?.parentId ?? null;
  }
  return false;
}

/**
 * Arma el árbol ya ordenado. Van a la raíz las carpetas cuyo padre no existe o que forman un ciclo
 * (sus hijas siguen dentro de ellas) y las notas cuya carpeta no existe.
 */
export function buildTree(folders: FolderRow[], items: FileItem[]): TreeNode {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const root: TreeNode = { folder: null, folders: [], items: [] };
  const nodes = new Map<string, TreeNode>(folders.map((f) => [f.id, { folder: f, folders: [], items: [] }]));
  for (const f of folders) {
    const node = nodes.get(f.id)!;
    const parent = f.parentId !== null && byId.has(f.parentId) && !inCycle(byId, f) ? nodes.get(f.parentId)! : root;
    parent.folders.push(node);
  }
  for (const it of items) {
    const parent = (it.folderId !== null && nodes.get(it.folderId)) || root;
    parent.items.push(it);
  }
  return sortNodes(root);
}

/** Ids de la carpeta y de todas sus descendientes, en todos los niveles. */
export function descendantIds(folders: FolderRow[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (f.parentId === null) continue;
    const list = children.get(f.parentId) ?? [];
    list.push(f.id);
    children.set(f.parentId, list);
  }
  const out = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    for (const c of children.get(queue.pop()!) ?? []) {
      if (out.has(c)) continue;
      out.add(c);
      queue.push(c);
    }
  }
  return out;
}

/**
 * Si la carpeta `id` se puede mover dentro de `targetParentId` (`null` = raíz): no si no existe, si es del
 * sistema («Directos» o la de una comunidad), si el destino no existe o si el destino es ella misma o una descendiente.
 */
export function canMoveFolder(folders: FolderRow[], id: string, targetParentId: string | null): boolean {
  const f = folders.find((x) => x.id === id);
  if (!f || f.kind !== 'user') return false;
  if (targetParentId === null) return true;
  if (!folders.some((x) => x.id === targetParentId)) return false;
  return !descendantIds(folders, id).has(targetParentId);
}

/** Carpetas desde la raíz hasta `folderId` (incluida); `[]` para la raíz o una carpeta que no existe. */
export function pathTo(folders: FolderRow[], folderId: string | null): FolderRow[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: FolderRow[] = [];
  const seen = new Set<string>();
  let cur = folderId === null ? undefined : byId.get(folderId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.push(cur);
    cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
  }
  return path.reverse();
}

/** Notas que están directamente en la carpeta (no las de sus subcarpetas): las que borra «Vaciar carpeta». */
export function directItems(items: FileItem[], folderId: string): FileItem[] {
  return items.filter((i) => i.folderId === folderId);
}

/** Si la carpeta no tiene subcarpetas ni notas (solo así se puede eliminar). */
export function isEmpty(folders: FolderRow[], items: FileItem[], folderId: string): boolean {
  return !folders.some((f) => f.parentId === folderId) && !items.some((i) => i.folderId === folderId);
}

/** Abre una pestaña: si ya está, solo la activa; si no, la agrega a la derecha de la activa (o al final). */
export function openTab(s: TabsState, id: string): TabsState {
  if (s.open.includes(id)) return { open: [...s.open], active: id };
  const at = s.active === null ? -1 : s.open.indexOf(s.active);
  const open = [...s.open];
  if (at === -1) open.push(id);
  else open.splice(at + 1, 0, id);
  return { open, active: id };
}

/** La pestaña que queda activa si se quita la de la posición `at` de `before`: la siguiente que sobrevive a la derecha o, si no hay, a la izquierda. */
function neighbour(before: string[], at: number, kept: Set<string>): string | null {
  for (let i = at + 1; i < before.length; i++) if (kept.has(before[i])) return before[i];
  for (let i = at - 1; i >= 0; i--) if (kept.has(before[i])) return before[i];
  return null;
}

/** Cierra una pestaña; si era la activa, activa la de la derecha o, si no hay, la de la izquierda. */
export function closeTab(s: TabsState, id: string): TabsState {
  const open = s.open.filter((t) => t !== id);
  if (s.active !== id) return { open, active: s.active };
  return { open, active: neighbour(s.open, s.open.indexOf(id), new Set(open)) };
}

/**
 * Quita las pestañas de notas que ya no están en `existing`, salvo `keep` (la de la URL actual, que puede ser
 * una nota ajena). Si se quitó la activa, activa la vecina con la misma regla que `closeTab`.
 */
export function pruneTabs(s: TabsState, existing: Set<string>, keep?: string | null): TabsState {
  const open = s.open.filter((t) => existing.has(t) || t === keep);
  const kept = new Set(open);
  if (s.active === null || kept.has(s.active)) return { open, active: s.active };
  const at = s.open.indexOf(s.active);
  return { open, active: at === -1 ? (open[0] ?? null) : neighbour(s.open, at, kept) };
}

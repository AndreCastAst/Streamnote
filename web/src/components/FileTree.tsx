import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { api, ApiError, type FileItem, type FolderRow } from '../api';
import { buildTree, canMoveFolder, directItems, displayTitle, isEmpty, pathTo, type TreeNode } from '../files';
import { Dialog } from './Dialog';

// Panel «Mis archivos»: árbol de carpetas y notas del usuario, con teclado, menú «⋯», «Mover a…»,
// arrastrar y soltar, y las confirmaciones de vaciar y eliminar. Las acciones de carpetas y de mover o
// eliminar notas las hace el propio árbol; crear notas, abrirlas y desligarlas las hace la vista de trabajo.

export interface FileTreeProps {
  /** Para la clave de localStorage de las carpetas expandidas. */
  userId: string;
  folders: FolderRow[];
  items: FileItem[];
  activeNoteId: string | null;
  /** Títulos en vivo (mientras se escribe en la hoja) que reemplazan los de `GET /files`. */
  titles: Record<string, string>;
  /** Abre la nota como pestaña. */
  onOpen(noteId: string): void;
  /** La vista crea la nota (`POST /notes`) en esa carpeta (`null` = raíz) y la abre. */
  onCreateNote(folderId: string | null): void;
  /** Algo cambió en el servidor: volver a pedir `GET /files`. */
  onChanged(): void;
  /** Notas eliminadas: cerrar sus pestañas. */
  onNotesDeleted(noteIds: string[]): void;
  /** La vista confirma y desliga la nota de su comunidad. */
  onUnlink(noteId: string): void;
}

/** Lo que se mueve, arrastra o recibe una acción. */
type Target = { kind: 'folder'; id: string } | { kind: 'note'; id: string };
/** Fila visible del árbol, en orden de arriba abajo (para el teclado). */
interface Row {
  key: string; // 'f:<id>' o 'n:<id>'
  kind: 'folder' | 'note';
  id: string;
  parent: string | null; // clave de la carpeta que la contiene
}
type Editing = { mode: 'new'; parentId: string | null } | { mode: 'rename'; folderId: string };
type DialogState =
  | { type: 'move'; target: Target }
  | { type: 'empty'; folderId: string }
  | { type: 'delete-folder'; folderId: string }
  | { type: 'delete-note'; noteId: string };
interface MenuState {
  key: string;
  right: number;
  top?: number;
  bottom?: number;
}
interface MenuEntry {
  label: string;
  run(): void;
  disabled?: boolean;
  reason?: string;
}

const DRAG_TYPE = 'application/x-streamnote';
const MENU_HEIGHT = 200; // alto aproximado del menú, para abrirlo hacia arriba si no cabe abajo

const keyOf = (t: Target) => (t.kind === 'folder' ? 'f:' : 'n:') + t.id;
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo salió mal; intenta de nuevo');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const depthStyle = (depth: number) => ({ '--depth': depth }) as CSSProperties;

function loadExpanded(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(`streamnote.tree.${userId}`);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveExpanded(userId: string, ids: Set<string>) {
  try {
    localStorage.setItem(`streamnote.tree.${userId}`, JSON.stringify([...ids]));
  } catch {
    /* almacenamiento no disponible: el expandido dura lo que la página */
  }
}

export function FileTree({ userId, folders, items, activeNoteId, titles, onOpen, onCreateNote, onChanged, onNotesDeleted, onUnlink }: FileTreeProps) {
  const uid = useId();
  const domId = (key: string) => `${uid}-row-${key}`;
  const menuButtonId = (key: string) => `${uid}-menu-${key}`;

  const [expanded, setExpanded] = useState(() => loadExpanded(userId));
  const userRef = useRef(userId);
  userRef.current = userId;
  useEffect(() => setExpanded(loadExpanded(userId)), [userId]);
  useEffect(() => saveExpanded(userRef.current, expanded), [expanded]);

  const [selected, setSelected] = useState<string | null>(null); // carpeta donde se crea lo nuevo
  const [focusKey, setFocusKey] = useState<string | null>(null);
  // Fila que se enfoca cuando aparezca (tras crear o mover). Con `parent` (tras mover), solo cuando ya esté
  // dentro de esa carpeta (`null` = raíz): antes de que llegue el nuevo GET /files sigue en su lugar anterior,
  // y si se enfocara allí, el foco se perdería al volver a montarse la fila en su nuevo lugar.
  const focusAfter = useRef<{ key: string; parent?: string | null } | null>(null);

  const [editing, setEditingState] = useState<Editing | null>(null);
  const editingRef = useRef<Editing | null>(null);
  const [editName, setEditName] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const editBusy = useRef(false);
  const setEditing = (e: Editing | null) => {
    editingRef.current = e;
    setEditingState(e);
  };

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [moveDest, setMoveDest] = useState<string | null | undefined>(undefined); // undefined = sin elegir; null = raíz

  const [dragging, setDragging] = useState<Target | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null | undefined>(undefined); // null = raíz

  // ---------- Datos derivados ----------
  const shownItems = useMemo(
    () => items.map((i) => (titles[i.id] !== undefined && titles[i.id] !== i.title ? { ...i, title: titles[i.id] } : i)),
    [items, titles],
  );
  const tree = useMemo(() => buildTree(folders, shownItems), [folders, shownItems]);
  const folderById = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const itemById = useMemo(() => new Map(shownItems.map((i) => [i.id, i])), [shownItems]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (node: TreeNode, parent: string | null) => {
      for (const c of node.folders) {
        const key = `f:${c.folder!.id}`;
        out.push({ key, kind: 'folder', id: c.folder!.id, parent });
        if (expanded.has(c.folder!.id)) walk(c, key);
      }
      for (const it of node.items) out.push({ key: `n:${it.id}`, kind: 'note', id: it.id, parent });
    };
    walk(tree, null);
    return out;
  }, [tree, expanded]);

  // Foco itinerante: una sola fila con tabIndex 0
  const rowKeys = new Set(rows.map((r) => r.key));
  const tabKey =
    focusKey && rowKeys.has(focusKey) ? focusKey : activeNoteId && rowKeys.has(`n:${activeNoteId}`) ? `n:${activeNoteId}` : (rows[0]?.key ?? null);

  const selectedFolder = selected !== null && folderById.has(selected) ? selected : null;
  const nameOf = (t: Target) => (t.kind === 'folder' ? (folderById.get(t.id)?.name ?? '') : displayTitle(itemById.get(t.id)?.title ?? ''));

  // ---------- Efectos ----------
  // Al cambiar la nota activa, su carpeta pasa a ser la seleccionada y se expande el camino hasta ella
  const activeFolder = activeNoteId ? items.find((i) => i.id === activeNoteId)?.folderId : undefined;
  useEffect(() => {
    if (activeFolder === undefined) return;
    setSelected(activeFolder);
    if (activeFolder !== null) expandPath(activeFolder);
  }, [activeNoteId, activeFolder]);

  // Enfocar la fila pendiente en cuanto aparece (la carpeta nueva llega con el siguiente GET /files)
  useEffect(() => {
    const pending = focusAfter.current;
    if (!pending) return;
    const { key, parent } = pending;
    const el = document.getElementById(domId(key));
    if (!el) return;
    if (parent !== undefined) {
      const holder = el.parentElement?.closest<HTMLElement>('[role="treeitem"]');
      if ((holder?.dataset.key ?? null) !== (parent === null ? null : `f:${parent}`)) return;
    }
    focusAfter.current = null;
    setFocusKey(key);
    el.focus();
  });

  // Menú: el foco entra al primer elemento; clic fuera, desplazamiento o cambio de tamaño lo cierran
  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || document.getElementById(menuButtonId(menu.key))?.contains(t)) return;
      setMenu(null);
    };
    const dismiss = () => setMenu(null);
    document.addEventListener('mousedown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [menu?.key]);

  // ---------- Ayudantes ----------
  function expandPath(folderId: string) {
    const ids = pathTo(folders, folderId).map((f) => f.id);
    setExpanded((prev) => (ids.every((id) => prev.has(id)) ? prev : new Set([...prev, ...ids])));
  }

  const setExpand = (folderId: string, open: boolean) =>
    setExpanded((prev) => {
      if (prev.has(folderId) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(folderId);
      else next.delete(folderId);
      return next;
    });

  const setRowError = (key: string, message: string | null) =>
    setErrors((prev) => {
      if (message === null && !(key in prev)) return prev;
      const next = { ...prev };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });

  const focusRow = (key: string) => {
    setFocusKey(key);
    document.getElementById(domId(key))?.focus();
  };

  const clickFolder = (f: FolderRow) => {
    setSelected(f.id);
    setFocusKey(`f:${f.id}`);
    setExpand(f.id, !expanded.has(f.id));
  };

  // ---------- Crear y renombrar carpetas ----------
  const startNewFolder = () => {
    const parentId = selectedFolder;
    if (parentId) expandPath(parentId);
    setEditName('');
    setEditError(null);
    setEditing({ mode: 'new', parentId });
  };

  const startRename = (folderId: string) => {
    setRowError(`f:${folderId}`, null);
    setEditName(folderById.get(folderId)?.name ?? '');
    setEditError(null);
    setEditing({ mode: 'rename', folderId });
  };

  const cancelEdit = () => {
    const e = editingRef.current;
    setEditing(null);
    setEditError(null);
    if (e?.mode === 'rename') focusRow(`f:${e.folderId}`);
    else if (e?.parentId) focusRow(`f:${e.parentId}`);
  };

  const submitEdit = async (fromBlur: boolean) => {
    const e = editingRef.current;
    if (!e || editBusy.current) return;
    const name = editName.trim();
    if (!name) {
      if (fromBlur) cancelEdit();
      else setEditError('Escribe un nombre');
      return;
    }
    if (name.includes('/')) {
      setEditError('El nombre no puede llevar «/»');
      return;
    }
    if (e.mode === 'rename' && name === folderById.get(e.folderId)?.name) {
      cancelEdit();
      return;
    }
    editBusy.current = true;
    try {
      if (e.mode === 'new') {
        const f = await api<FolderRow>('POST', '/folders', { name, parentId: e.parentId ?? undefined });
        setSelected(f.id);
        focusAfter.current = { key: `f:${f.id}` };
      } else {
        await api('PATCH', `/folders/${e.folderId}`, { name });
        focusAfter.current = { key: `f:${e.folderId}` };
      }
      setEditing(null);
      setEditError(null);
      onChanged();
    } catch (err) {
      setEditError(errorText(err));
    } finally {
      editBusy.current = false;
    }
  };

  const nameInput = (label: string) => (
    <span className="tree-edit">
      <input
        aria-label={label}
        value={editName}
        maxLength={120}
        autoFocus
        aria-invalid={editError ? true : undefined}
        onChange={(e) => {
          setEditName(e.target.value);
          setEditError(null);
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') {
            e.preventDefault();
            void submitEdit(false);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
          }
        }}
        onBlur={() => void submitEdit(true)}
      />
      {editError && (
        <span role="alert" className="tree-error">
          {editError}
        </span>
      )}
    </span>
  );

  // ---------- Mover ----------
  const move = async (t: Target, dest: string | null) => {
    if (t.kind === 'note') await api('PATCH', `/notes/${t.id}`, { folderId: dest });
    else await api('PATCH', `/folders/${t.id}`, { parentId: dest });
    if (dest !== null) expandPath(dest);
    focusAfter.current = { key: keyOf(t), parent: dest };
    onChanged();
  };

  /** Destinos válidos para `t`: carpetas (en el orden del árbol, con su profundidad) y la raíz. */
  const destinations = (t: Target) => {
    const out: { id: string; name: string; kind: FolderRow['kind']; depth: number; valid: boolean }[] = [];
    const walk = (node: TreeNode, depth: number) => {
      for (const c of node.folders) {
        const f = c.folder!;
        // Al mover una carpeta, ni ella ni sus descendientes son destinos: no se recorre su rama
        if (t.kind === 'folder' && f.id === t.id) continue;
        const valid = t.kind === 'note' || canMoveFolder(folders, t.id, f.id);
        out.push({ id: f.id, name: f.name, kind: f.kind, depth, valid });
        walk(c, depth + 1);
      }
    };
    walk(tree, 0);
    return out.filter((d) => d.valid);
  };

  const currentParent = (t: Target): string | null =>
    t.kind === 'folder' ? (folderById.get(t.id)?.parentId ?? null) : (itemById.get(t.id)?.folderId ?? null);

  // ---------- Diálogos ----------
  const openDialog = (d: DialogState) => {
    setDialogError(null);
    setDialogBusy(false);
    setMoveDest(undefined);
    setDialog(d);
  };

  const closeDialog = () => {
    const d = dialog;
    setDialog(null);
    setDialogError(null);
    setDialogBusy(false);
    if (!d) return;
    const key =
      d.type === 'move' ? keyOf(d.target) : d.type === 'delete-note' ? `n:${d.noteId}` : `f:${d.folderId}`;
    focusAfter.current = { key };
  };

  const runDialog = async (action: () => Promise<void>) => {
    setDialogBusy(true);
    setDialogError(null);
    try {
      await action();
      setDialog(null);
      setDialogBusy(false);
    } catch (e) {
      setDialogError(errorText(e));
      setDialogBusy(false);
    }
  };

  const confirmMove = (t: Target) =>
    runDialog(async () => {
      if (moveDest === undefined) return;
      if (moveDest === currentParent(t)) return;
      await move(t, moveDest);
    });

  const confirmEmpty = (folderId: string) =>
    runDialog(async () => {
      const ids = directItems(items, folderId).map((i) => i.id);
      await api('POST', `/folders/${folderId}/empty`);
      focusAfter.current = { key: `f:${folderId}` };
      onNotesDeleted(ids);
      onChanged();
    });

  const confirmDeleteFolder = (folderId: string) =>
    runDialog(async () => {
      const parent = folderById.get(folderId)?.parentId ?? null;
      await api('DELETE', `/folders/${folderId}`);
      if (selectedFolder === folderId) setSelected(parent);
      if (parent) focusAfter.current = { key: `f:${parent}` };
      onChanged();
    });

  const confirmDeleteNote = (noteId: string) =>
    runDialog(async () => {
      const it = itemById.get(noteId);
      await api('DELETE', `/notes/${noteId}`);
      if (it?.folderId) focusAfter.current = { key: `f:${it.folderId}` };
      onNotesDeleted([noteId]);
      onChanged();
    });

  const renderDialog = () => {
    if (!dialog) return null;
    const common = { onClose: closeDialog, busy: dialogBusy, error: dialogError };
    if (dialog.type === 'move') {
      const t = dialog.target;
      const here = currentParent(t);
      const name = nameOf(t);
      const options = destinations(t);
      const radioName = `${uid}-dest`;
      return (
        <Dialog {...common} title={`Mover “${name}” a…`} confirmLabel="Mover" confirmDisabled={moveDest === undefined || moveDest === here} onConfirm={() => void confirmMove(t)}>
          <fieldset className="choice move-list">
            <legend className="sr-only">Destino</legend>
            <label className="check-row move-option" style={depthStyle(0)}>
              <input type="radio" name={radioName} checked={moveDest === null} disabled={here === null} onChange={() => setMoveDest(null)} />
              Raíz
              {here === null && <span className="muted small">(ubicación actual)</span>}
            </label>
            {options.map((d) => (
              <label key={d.id} className="check-row move-option" style={depthStyle(d.depth + 1)}>
                <input type="radio" name={radioName} checked={moveDest === d.id} disabled={here === d.id} onChange={() => setMoveDest(d.id)} />
                <FolderIcon kind={d.kind} />
                {d.name}
                {here === d.id && <span className="muted small">(ubicación actual)</span>}
              </label>
            ))}
          </fieldset>
        </Dialog>
      );
    }
    if (dialog.type === 'empty') {
      const f = folderById.get(dialog.folderId);
      const notes = directItems(items, dialog.folderId);
      const frozen = notes.filter((n) => n.locked).length;
      return (
        <Dialog {...common} title="Vaciar carpeta" confirmLabel="Vaciar" danger onConfirm={() => void confirmEmpty(dialog.folderId)}>
          <p>
            Se {notes.length === 1 ? 'borrará' : 'borrarán'} {plural(notes.length, 'nota', 'notas')} de “{f?.name}”. Las subcarpetas no se tocan.
          </p>
          {frozen > 0 && <p>Incluye {plural(frozen, 'copia congelada', 'copias congeladas')} que la comunidad dejará de ver.</p>}
        </Dialog>
      );
    }
    if (dialog.type === 'delete-folder') {
      const f = folderById.get(dialog.folderId);
      return (
        <Dialog {...common} title="Eliminar carpeta" confirmLabel="Eliminar" danger onConfirm={() => void confirmDeleteFolder(dialog.folderId)}>
          <p>¿Eliminar la carpeta “{f?.name}”?</p>
        </Dialog>
      );
    }
    const it = itemById.get(dialog.noteId);
    return (
      <Dialog {...common} title="Eliminar nota" confirmLabel="Eliminar" danger onConfirm={() => void confirmDeleteNote(dialog.noteId)}>
        <p>¿Eliminar “{displayTitle(it?.title ?? '')}”?</p>
        {it?.locked && (
          <p>{it.community ? `La comunidad “${it.community.name}” dejará de ver esta copia.` : 'La comunidad dejará de ver esta copia.'}</p>
        )}
        {it && !it.locked && it.community && <p>Los miembros de “{it.community.name}” dejarán de verla.</p>}
      </Dialog>
    );
  };

  // ---------- Menú «⋯» ----------
  const openMenu = (key: string, button: HTMLElement) => {
    setRowError(key, null);
    const r = button.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    setMenu(r.bottom + MENU_HEIGHT < window.innerHeight ? { key, right, top: r.bottom + 4 } : { key, right, bottom: window.innerHeight - r.top + 4 });
  };

  const closeMenu = (refocus: boolean) => {
    const key = menu?.key;
    setMenu(null);
    if (refocus && key) document.getElementById(menuButtonId(key))?.focus();
  };

  const menuEntries = (key: string): MenuEntry[] => {
    const id = key.slice(2);
    if (key.startsWith('f:')) {
      const f = folderById.get(id);
      if (!f) return [];
      const entries: MenuEntry[] = [{ label: 'Renombrar', run: () => startRename(id) }];
      if (f.kind === 'user') entries.push({ label: 'Mover a…', run: () => openDialog({ type: 'move', target: { kind: 'folder', id } }) });
      entries.push({
        label: 'Vaciar carpeta',
        disabled: directItems(items, id).length === 0,
        run: () => openDialog({ type: 'empty', folderId: id }),
      });
      const empty = isEmpty(folders, items, id);
      entries.push({
        label: 'Eliminar',
        disabled: !empty,
        reason: empty ? undefined : 'Vacíala primero',
        run: () => openDialog({ type: 'delete-folder', folderId: id }),
      });
      return entries;
    }
    const it = itemById.get(id);
    if (!it) return [];
    const entries: MenuEntry[] = [{ label: 'Mover a…', run: () => openDialog({ type: 'move', target: { kind: 'note', id } }) }];
    if (it.community && !it.locked) entries.push({ label: 'Desligar de la comunidad', run: () => onUnlink(id) });
    entries.push({ label: 'Eliminar', run: () => openDialog({ type: 'delete-note', noteId: id }) });
    return entries;
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = entries.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') entries[(i + 1) % entries.length]?.focus();
    else if (e.key === 'ArrowUp') entries[(i - 1 + entries.length) % entries.length]?.focus();
    else if (e.key === 'Home') entries[0]?.focus();
    else if (e.key === 'End') entries[entries.length - 1]?.focus();
    else if (e.key === 'Escape' || e.key === 'Tab') closeMenu(true);
    else return;
    e.preventDefault();
  };

  const renderMenu = () => {
    if (!menu) return null;
    const t: Target = menu.key.startsWith('f:') ? { kind: 'folder', id: menu.key.slice(2) } : { kind: 'note', id: menu.key.slice(2) };
    const entries = menuEntries(menu.key);
    return (
      <div
        ref={menuRef}
        role="menu"
        aria-label={`Acciones de ${nameOf(t)}`}
        className="tree-menu"
        style={{ right: menu.right, top: menu.top, bottom: menu.bottom }}
        onKeyDown={onMenuKey}
      >
        {entries.map((entry) => {
          const reasonId = `${uid}-reason-${entry.label}`;
          return (
            <div role="none" key={entry.label}>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={entry.disabled || undefined}
                aria-describedby={entry.reason ? reasonId : undefined}
                onClick={() => {
                  if (entry.disabled) return;
                  closeMenu(false);
                  entry.run();
                }}
              >
                {entry.label}
              </button>
              {entry.reason && (
                <span id={reasonId} className="tree-menu-reason">
                  {entry.reason}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  const menuButton = (key: string, name: string) => (
    <button
      type="button"
      id={menuButtonId(key)}
      className="tree-more"
      aria-label={`Acciones de ${name}`}
      aria-haspopup="menu"
      aria-expanded={menu?.key === key}
      tabIndex={tabKey === key ? 0 : -1}
      draggable={false}
      onClick={(e) => {
        e.stopPropagation();
        if (menu?.key === key) closeMenu(false);
        else openMenu(key, e.currentTarget);
      }}
    >
      ⋯
    </button>
  );

  // ---------- Teclado del árbol ----------
  const onTreeKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const el = e.target as HTMLElement;
    if (el.getAttribute('role') !== 'treeitem') return;
    const i = rows.findIndex((r) => r.key === el.dataset.key);
    if (i === -1) return;
    const row = rows[i];
    const isOpen = row.kind === 'folder' && expanded.has(row.id);
    if (e.key === 'ArrowDown') {
      if (rows[i + 1]) focusRow(rows[i + 1].key);
    } else if (e.key === 'ArrowUp') {
      if (rows[i - 1]) focusRow(rows[i - 1].key);
    } else if (e.key === 'Home') {
      focusRow(rows[0].key);
    } else if (e.key === 'End') {
      focusRow(rows[rows.length - 1].key);
    } else if (e.key === 'ArrowRight') {
      if (row.kind !== 'folder') return;
      if (!isOpen) setExpand(row.id, true);
      else if (rows[i + 1]?.parent === row.key) focusRow(rows[i + 1].key);
    } else if (e.key === 'ArrowLeft') {
      if (isOpen) setExpand(row.id, false);
      else if (row.parent) focusRow(row.parent);
    } else if (e.key === 'Enter') {
      if (row.kind === 'note') onOpen(row.id);
      else {
        setSelected(row.id);
        setExpand(row.id, !isOpen);
      }
    } else if (e.key === 'F2' && row.kind === 'folder') {
      startRename(row.id);
    } else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const button = document.getElementById(menuButtonId(row.key));
      if (button) openMenu(row.key, button);
    } else return;
    e.preventDefault();
  };

  // ---------- Arrastrar y soltar ----------
  /** Carpeta de destino bajo el puntero (`null` = raíz), o `undefined` si ahí no se puede soltar. */
  const dropDest = (e: DragEvent): string | null | undefined => {
    if (!dragging) return undefined;
    const target = e.target as Element;
    const row = target.closest<HTMLElement>('.tree-row');
    let dest: string | null;
    if (row) {
      if (row.dataset.kind !== 'folder') return undefined;
      dest = row.dataset.id!;
    } else {
      // Fuera de las filas: solo el área vacía del árbol es la raíz
      if (target.closest('.tree-item')) return undefined;
      dest = null;
    }
    if (dest === currentParent(dragging)) return undefined;
    if (dragging.kind === 'folder' && !canMoveFolder(folders, dragging.id, dest)) return undefined;
    return dest;
  };

  const dragProps = (t: Target, enabled: boolean) =>
    enabled
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.stopPropagation();
            setRowError(keyOf(t), null);
            setMenu(null);
            e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(t));
            e.dataTransfer.effectAllowed = 'move';
            setDragging(t);
          },
          onDragEnd: () => {
            setDragging(null);
            setDropTarget(undefined);
          },
        }
      : { draggable: false };

  const bodyDrag = {
    onDragOver: (e: DragEvent<HTMLDivElement>) => {
      const dest = dropDest(e);
      if (dest === undefined) {
        if (dropTarget !== undefined) setDropTarget(undefined);
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (dropTarget !== dest) setDropTarget(dest);
    },
    onDragLeave: (e: DragEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(undefined);
    },
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const dest = dropDest(e);
      const t = dragging;
      setDragging(null);
      setDropTarget(undefined);
      if (dest === undefined || !t) return;
      move(t, dest).catch((err) => setRowError(keyOf(t), errorText(err)));
    },
  };

  // ---------- Dibujo ----------
  const rowError = (key: string, depth: number) =>
    errors[key] ? (
      <p role="alert" className="tree-error tree-row-error" style={depthStyle(depth)}>
        {errors[key]}
      </p>
    ) : null;

  const renderChildren = (node: TreeNode, depth: number): ReactNode => {
    const parentId = node.folder?.id ?? null;
    const newHere =
      editing?.mode === 'new' && (editing.parentId !== null && folderById.has(editing.parentId) ? editing.parentId : null) === parentId;
    return (
      <>
        {newHere && (
          <li role="none" className="tree-new" style={depthStyle(depth)}>
            <FolderIcon kind="user" />
            {nameInput('Nombre de la carpeta')}
          </li>
        )}
        {node.folders.map((c) => renderFolder(c, depth))}
        {node.items.map((it) => renderNote(it, depth))}
      </>
    );
  };

  const renderFolder = (node: TreeNode, depth: number) => {
    const f = node.folder!;
    const key = `f:${f.id}`;
    const open = expanded.has(f.id);
    const nameId = `${uid}-name-${key}`;
    const renaming = editing?.mode === 'rename' && editing.folderId === f.id;
    const classes = ['tree-row', selectedFolder === f.id && 'selected', dropTarget === f.id && 'drop-target'].filter(Boolean).join(' ');
    return (
      <li
        key={key}
        id={domId(key)}
        role="treeitem"
        aria-expanded={open}
        aria-labelledby={nameId}
        tabIndex={tabKey === key ? 0 : -1}
        className="tree-item"
        data-key={key}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocusKey(key);
        }}
      >
        <div className={classes} data-kind="folder" data-id={f.id} data-system={f.kind !== 'user' || undefined} style={depthStyle(depth)} onClick={() => clickFolder(f)} {...dragProps({ kind: 'folder', id: f.id }, f.kind === 'user' && !renaming)}>
          <span className="tree-twisty" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <FolderIcon kind={f.kind} />
          <span id={nameId} className={renaming ? 'sr-only' : 'tree-name'}>
            {f.name}
          </span>
          {renaming && nameInput('Nombre de la carpeta')}
          {!renaming && menuButton(key, f.name)}
        </div>
        {rowError(key, depth)}
        {open && <ul role="group">{renderChildren(node, depth + 1)}</ul>}
      </li>
    );
  };

  const renderNote = (it: FileItem, depth: number) => {
    const key = `n:${it.id}`;
    const nameId = `${uid}-name-${key}`;
    const title = displayTitle(it.title);
    const active = it.id === activeNoteId;
    return (
      <li
        key={key}
        id={domId(key)}
        role="treeitem"
        aria-selected={active}
        aria-labelledby={nameId}
        tabIndex={tabKey === key ? 0 : -1}
        className="tree-item"
        data-key={key}
        onFocus={(e) => {
          if (e.target === e.currentTarget) setFocusKey(key);
        }}
      >
        <div className={`tree-row${active ? ' active' : ''}`} data-kind="note" data-id={it.id} style={depthStyle(depth)} onClick={() => {
          setFocusKey(key);
          onOpen(it.id);
        }} {...dragProps({ kind: 'note', id: it.id }, true)}>
          <span className="tree-twisty" aria-hidden="true" />
          <NoteIcon />
          <span className="tree-text">
            <span id={nameId} className="tree-name">
              {title}
            </span>
            {it.community && (
              <span className="tree-tag" title={`de ${it.community.name}`}>
                de {it.community.name}
              </span>
            )}
          </span>
          {it.locked && (
            <span className="tree-lock" title="Copia congelada">
              <LockIcon />
              <span className="sr-only">Copia congelada</span>
            </span>
          )}
          {menuButton(key, title)}
        </div>
        {rowError(key, depth)}
      </li>
    );
  };

  const treeEmpty = folders.length === 0 && items.length === 0;
  const headingId = `${uid}-heading`;

  return (
    <section className="file-tree" aria-labelledby={headingId}>
      <div className="file-tree-bar">
        <h2 id={headingId}>Mis archivos</h2>
        <div className="file-tree-actions">
          <button type="button" onClick={() => onCreateNote(selectedFolder)}>
            Nueva nota
          </button>
          <button type="button" onClick={startNewFolder}>
            Nueva carpeta
          </button>
        </div>
      </div>
      {treeEmpty && !editing && <p className="tree-empty muted small">Crea tu primera nota o carpeta</p>}
      <div
        className={`tree-body${dropTarget === null ? ' drop-root' : ''}`}
        onClick={(e) => {
          // Clic en el área vacía: lo nuevo se crea en la raíz
          if (!(e.target as Element).closest('.tree-item, .tree-new')) setSelected(null);
        }}
        {...bodyDrag}
      >
        <ul role="tree" aria-label="Mis archivos" className="tree" onKeyDown={onTreeKey}>
          {renderChildren(tree, 0)}
        </ul>
      </div>
      {renderMenu()}
      {renderDialog()}
    </section>
  );
}

// ---------- Íconos (decorativos) ----------
function FolderIcon({ kind }: { kind: FolderRow['kind'] }) {
  if (kind === 'directos')
    return (
      <svg className="tree-icon system" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="1.8" fill="currentColor" />
        <path d="M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  if (kind === 'community')
    return (
      <svg className="tree-icon system" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="5.5" cy="5.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="11" cy="6.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M1.5 13c0-2.4 1.8-4 4-4s4 1.6 4 4M9.5 9.6c.5-.3 1-.4 1.5-.4 1.9 0 3.5 1.4 3.5 3.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    );
  return (
    <svg className="tree-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.75 3.5h4.3l1.5 1.6h6.7v7.9H1.75z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg className="tree-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 1.75h6l3 3v9.5h-9z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.5 8h5M5.5 10.5h5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg className="tree-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" rx="1.2" fill="currentColor" />
      <path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type FilesResponse, type NoteDetail } from '../api';
import { useSession } from '../App';
import { closeTab, displayTitle, openTab, pruneTabs, type TabsState } from '../files';
import { Dialog } from '../components/Dialog';
import { FileTree } from '../components/FileTree';
import { NoteEditor, lastSentVersion } from '../components/NoteEditor';

// Vista de trabajo de «Mis notas» (`/notas` y `/notes/:id`): panel «Mis archivos», pestañas sobre la hoja,
// la hoja de la pestaña activa y el panel derecho de la nota. La URL manda: la pestaña activa es la de `/notes/:id`.

type WsDialog =
  | { type: 'unlink'; noteId: string; community: string }
  | { type: 'delete'; noteId: string; title: string; locked: boolean; community: string | null };

const SAVING_MESSAGE = 'todavía se está guardando';
const UNLINK_RETRIES = 5;
const UNLINK_WAIT_MS = 1500;
const EMPTY_TABS: TabsState = { open: [], active: null };

const tabsKey = (userId: string) => `streamnote.tabs.${userId}`;
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo salió mal; intenta de nuevo');
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

function loadTabs(userId: string): TabsState {
  try {
    const raw = localStorage.getItem(tabsKey(userId));
    const v = raw ? JSON.parse(raw) : null;
    if (!v || !Array.isArray(v.open)) return EMPTY_TABS;
    const open = [...new Set<string>(v.open.filter((x: unknown): x is string => typeof x === 'string'))];
    return { open, active: typeof v.active === 'string' && open.includes(v.active) ? v.active : null };
  } catch {
    return EMPTY_TABS;
  }
}

function saveTabs(userId: string, s: TabsState) {
  try {
    localStorage.setItem(tabsKey(userId), JSON.stringify(s));
  } catch {
    /* almacenamiento no disponible: las pestañas duran lo que la página */
  }
}

export function NotesWorkspace() {
  const { id } = useParams();
  const { user } = useSession();
  const userId = user!.id;
  const navigate = useNavigate();
  const uid = useId();
  const treeId = `${uid}-tree`;
  const panelId = `${uid}-panel`;
  const tabDomId = (t: string) => `${uid}-tab-${t}`;

  const [files, setFiles] = useState<FilesResponse | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [tabs, setTabs] = useState<TabsState>(() => loadTabs(userId));
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [meta, setMeta] = useState<NoteDetail | null>(null);
  const [communities, setCommunities] = useState<{ id: string; name: string }[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [dialog, setDialog] = useState<WsDialog | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogProgress, setDialogProgress] = useState<string | null>(null);

  // Referencias para leer lo último desde las llamadas que terminan después
  const idRef = useRef(id);
  idRef.current = id;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const filesSeq = useRef(0);
  const filesButton = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);

  const updateTabs = (next: TabsState) => {
    tabsRef.current = next;
    setTabs(next);
  };

  useEffect(() => saveTabs(userId, tabs), [userId, tabs]);

  // ---------- Archivos ----------
  const reload = useCallback(() => {
    const seq = ++filesSeq.current;
    api<FilesResponse>('GET', '/files')
      .then((r) => {
        if (seq !== filesSeq.current || !alive.current) return;
        setFiles(r);
        setFilesError(null);
        const next = pruneTabs(tabsRef.current, new Set(r.items.map((i) => i.id)), idRef.current ?? null);
        updateTabs(next);
      })
      .catch((e) => {
        if (seq === filesSeq.current && alive.current) setFilesError(errorText(e));
      });
  }, []);

  useEffect(() => {
    reload();
    api('GET', '/communities')
      .then(setCommunities)
      .catch(() => undefined);
  }, [reload]);

  // ---------- Pestañas (la URL manda) ----------
  useEffect(() => {
    if (id) updateTabs(openTab(tabsRef.current, id));
  }, [id]);

  // En `/notas`, si hay una pestaña activa guardada, se abre
  useEffect(() => {
    if (!id && tabs.active) navigate(`/notes/${tabs.active}`, { replace: true });
  }, [id, tabs.active]);

  // La pestaña activa queda a la vista en la barra (que se desplaza a lo ancho si no caben)
  useEffect(() => {
    if (id) document.getElementById(tabDomId(id))?.parentElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [id, tabs.open.length]);

  const activate = (t: string) => {
    if (t !== id) navigate(`/notes/${t}`);
  };

  /** Cierra estas pestañas; si entre ellas estaba la de la URL, va a la que queda activa (o a `/notas`). */
  const closeTabs = (ids: string[]) => {
    const current = idRef.current;
    let next = tabsRef.current;
    // La de la URL es la activa aunque el efecto que la marca no haya corrido todavía
    if (current && next.active !== current) next = openTab(next, current);
    for (const t of ids) if (next.open.includes(t)) next = closeTab(next, t);
    updateTabs(next);
    if (current && ids.includes(current)) navigate(next.active ? `/notes/${next.active}` : '/notas', { replace: true });
  };

  const onTabsKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const el = e.target as HTMLElement;
    if (el.getAttribute('role') !== 'tab') return;
    const list = shownTabs.open;
    const i = list.indexOf(el.dataset.id ?? '');
    if (i === -1) return;
    let to: string | undefined;
    if (e.key === 'ArrowRight') to = list[(i + 1) % list.length];
    else if (e.key === 'ArrowLeft') to = list[(i - 1 + list.length) % list.length];
    else if (e.key === 'Home') to = list[0];
    else if (e.key === 'End') to = list[list.length - 1];
    else if (e.key === 'Delete') {
      e.preventDefault();
      closeTabs([list[i]]);
      return;
    } else return;
    e.preventDefault();
    activate(to);
    document.getElementById(tabDomId(to))?.focus();
  };

  const setTitle = (noteId: string, title: string) => setTitles((t) => (t[noteId] === title ? t : { ...t, [noteId]: title }));

  const tabTitle = (t: string) => {
    if (titles[t] !== undefined) return displayTitle(titles[t]);
    const item = files?.items.find((i) => i.id === t);
    if (item) return displayTitle(item.title);
    return files ? displayTitle('') : '…';
  };

  // ---------- La nota activa (panel derecho) ----------
  const loadMeta = useCallback(() => {
    if (!id) return;
    const want = id;
    api<NoteDetail>('GET', `/notes/${want}`)
      .then((m) => {
        if (!alive.current || idRef.current !== want) return;
        setMeta(m);
        setTitles((t) => (t[m.id] !== undefined ? t : { ...t, [m.id]: m.title }));
      })
      .catch((e) => {
        if (!alive.current || idRef.current !== want) return;
        // La nota ya no existe o no se puede ver: se cierra su pestaña
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) closeTabs([want]);
      });
  }, [id]);

  useEffect(() => {
    setMeta(null);
    setActionError(null);
    loadMeta();
  }, [loadMeta]);

  const toggleShare = async (communityId: string, on: boolean) => {
    if (!id) return;
    setActionError(null);
    try {
      if (on) await api('POST', `/notes/${id}/shares`, { communityId });
      else await api('DELETE', `/notes/${id}/shares/${communityId}`);
    } catch (e) {
      setActionError(errorText(e));
    }
    loadMeta();
  };

  const copy = async () => {
    if (!id) return;
    setActionError(null);
    try {
      const n = await api('POST', `/notes/${id}/copy`);
      reload();
      navigate(`/notes/${n.id}`);
    } catch (e) {
      setActionError(errorText(e));
    }
  };

  const createNote = async (folderId: string | null) => {
    setActionError(null);
    try {
      const n = await api('POST', '/notes', { title: 'Nota sin título', folderId: folderId ?? undefined });
      setDrawerOpen(false);
      reload();
      navigate(`/notes/${n.id}`);
    } catch (e) {
      setActionError(errorText(e));
    }
  };

  const openNote = (noteId: string) => {
    setDrawerOpen(false);
    activate(noteId);
  };

  // ---------- Diálogos: desligar y eliminar ----------
  const openDialog = (d: WsDialog) => {
    setDialogBusy(false);
    setDialogError(null);
    setDialogProgress(null);
    setDialog(d);
  };

  const closeDialog = () => {
    setDialog(null);
    setDialogError(null);
    setDialogProgress(null);
  };

  const askUnlink = (noteId: string) => {
    const community = files?.items.find((i) => i.id === noteId)?.community ?? (meta?.id === noteId ? meta.community : null);
    openDialog({ type: 'unlink', noteId, community: community?.name ?? 'la comunidad' });
  };

  const unlink = async (noteId: string) => {
    setDialogBusy(true);
    setDialogError(null);
    for (let attempt = 0; ; attempt++) {
      try {
        // La última versión que mandó el editor: si el servidor aún no la tiene, responde 409 y se reintenta
        await api('POST', `/notes/${noteId}/unlink`, { version: lastSentVersion(noteId) ?? undefined });
        break;
      } catch (e) {
        if (!alive.current) return;
        const saving = e instanceof ApiError && e.status === 409 && e.message.includes(SAVING_MESSAGE);
        if (saving && attempt < UNLINK_RETRIES) {
          setDialogProgress('Guardando antes de desligar…');
          await sleep(UNLINK_WAIT_MS);
          if (!alive.current) return;
          continue;
        }
        setDialogProgress(null);
        setDialogError(errorText(e));
        setDialogBusy(false);
        return;
      }
    }
    if (!alive.current) return;
    setDialogBusy(false);
    closeDialog();
    reload();
    if (idRef.current === noteId) loadMeta();
  };

  const askDelete = () => {
    if (!meta) return;
    openDialog({
      type: 'delete',
      noteId: meta.id,
      title: displayTitle(titles[meta.id] ?? meta.title),
      locked: meta.locked,
      community: meta.community?.name ?? null,
    });
  };

  const remove = async (noteId: string) => {
    setDialogBusy(true);
    setDialogError(null);
    try {
      await api('DELETE', `/notes/${noteId}`);
    } catch (e) {
      if (!alive.current) return;
      setDialogError(errorText(e));
      setDialogBusy(false);
      return;
    }
    if (!alive.current) return;
    setDialogBusy(false);
    closeDialog();
    closeTabs([noteId]);
    reload();
  };

  const renderDialog = () => {
    if (!dialog) return null;
    const common = { onClose: closeDialog, busy: dialogBusy, error: dialogError };
    if (dialog.type === 'unlink')
      return (
        <Dialog {...common} title="Desligar de la comunidad" confirmLabel="Desligar" onConfirm={() => void unlink(dialog.noteId)}>
          <p>
            La nota quedará solo para ti y la comunidad “{dialog.community}” se quedará con una copia congelada de cómo está ahora, que nadie
            podrá editar.
          </p>
          {dialogProgress && (
            <p className="muted small" role="status">
              {dialogProgress}
            </p>
          )}
        </Dialog>
      );
    return (
      <Dialog {...common} title="Eliminar nota" confirmLabel="Eliminar" danger onConfirm={() => void remove(dialog.noteId)}>
        <p>¿Eliminar “{dialog.title}”?</p>
        {dialog.locked && <p>{dialog.community ? `La comunidad “${dialog.community}” dejará de ver esta copia.` : 'La comunidad dejará de ver esta copia.'}</p>}
        {!dialog.locked && dialog.community && <p>Los miembros de “{dialog.community}” dejarán de verla.</p>}
      </Dialog>
    );
  };

  // ---------- Cajón en pantallas angostas ----------
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    (drawer?.querySelector<HTMLElement>('[role="treeitem"][tabindex="0"]') ?? drawer?.querySelector<HTMLElement>('button'))?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      // El menú «⋯» y el campo de nombre usan Escape (y lo marcan); con un diálogo abierto, Escape es suyo
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return;
      setDrawerOpen(false);
      filesButton.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // ---------- Dibujo ----------
  // La pestaña de la URL se muestra aunque el efecto que la agrega todavía no haya corrido
  const shownTabs = id && tabs.active !== id ? openTab(tabs, id) : tabs;
  const current = meta && meta.id === id ? meta : null;

  const sidePanel = () => {
    if (!current) return null;
    if (current.canEdit)
      return (
        <>
          {current.community && (
            <div className="panel stack note-link">
              <p>
                Vinculada a <strong>{current.community.name}</strong>: sus miembros la ven en solo lectura.
              </p>
              <button type="button" onClick={() => askUnlink(current.id)}>
                Desligar
              </button>
            </div>
          )}
          <div className="panel stack">
            <h2>Compartir con</h2>
            {communities.length === 0 && <p className="muted small">Únete a una comunidad para compartir tus notas.</p>}
            {communities.map((c) => (
              <label key={c.id} className="check-row">
                <input type="checkbox" checked={current.sharedWith.some((s) => s.id === c.id)} onChange={(e) => void toggleShare(c.id, e.target.checked)} />
                {c.name}
              </label>
            ))}
            <p className="muted small">Los miembros podrán leerla y copiarla a sus notas.</p>
            <button type="button" className="link danger" onClick={askDelete}>
              Eliminar nota
            </button>
          </div>
        </>
      );
    if (current.isOwner && current.locked)
      return (
        <div className="panel stack note-link frozen">
          <h2>Copia congelada</h2>
          <p>
            Copia congelada para <strong>{current.community?.name ?? 'la comunidad'}</strong>: nadie puede editarla.
          </p>
          <button type="button" className="link danger" onClick={askDelete}>
            Eliminar nota
          </button>
        </div>
      );
    return (
      <div className="panel stack">
        <h2>Nota compartida</h2>
        <p className="muted small">Haz una copia para editarla. Cada módulo recordará quién lo escribió.</p>
        <button type="button" className="primary" onClick={() => void copy()}>
          Copiar a mis notas
        </button>
      </div>
    );
  };

  return (
    <div className={`workspace${drawerOpen ? ' drawer-open' : ''}`}>
      <div className="ws-tree" id={treeId} ref={drawerRef}>
        {files ? (
          <FileTree
            userId={userId}
            folders={files.folders}
            items={files.items}
            activeNoteId={id ?? null}
            titles={titles}
            onOpen={openNote}
            onCreateNote={(folderId) => void createNote(folderId)}
            onChanged={reload}
            onNotesDeleted={closeTabs}
            onUnlink={askUnlink}
          />
        ) : (
          <div className="file-tree ws-tree-loading">
            {filesError ? (
              <p className="error small" role="alert">
                {filesError}{' '}
                <button type="button" className="link" onClick={reload}>
                  Reintentar
                </button>
              </p>
            ) : (
              <p className="muted small">Cargando tus archivos…</p>
            )}
          </div>
        )}
      </div>
      {drawerOpen && <div className="ws-backdrop" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}

      <div className="ws-main">
        <div className="ws-tabs-row">
          <button
            type="button"
            ref={filesButton}
            className="ws-files-button"
            aria-expanded={drawerOpen}
            aria-controls={treeId}
            onClick={() => setDrawerOpen((o) => !o)}
          >
            Archivos
          </button>
          {shownTabs.open.length > 0 && (
            <div role="tablist" aria-label="Notas abiertas" className="ws-tabs" onKeyDown={onTabsKey}>
              {shownTabs.open.map((t) => {
                const selected = t === id;
                const title = tabTitle(t);
                return (
                  <div key={t} className={`ws-tab${selected ? ' active' : ''}`}>
                    <button
                      type="button"
                      role="tab"
                      id={tabDomId(t)}
                      data-id={t}
                      aria-selected={selected}
                      aria-controls={selected ? panelId : undefined}
                      tabIndex={selected || (!id && t === shownTabs.open[0]) ? 0 : -1}
                      className="ws-tab-title"
                      title={title}
                      onClick={() => activate(t)}
                    >
                      {title}
                    </button>
                    <button type="button" className="ws-tab-close" aria-label={`Cerrar ${title}`} title="Cerrar" tabIndex={selected ? 0 : -1} onClick={() => closeTabs([t])}>
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {actionError && (
          <p className="error small" role="alert">
            {actionError}
          </p>
        )}
        {id ? (
          <div role="tabpanel" id={panelId} aria-labelledby={tabDomId(id)} className="ws-sheet">
            <NoteEditor key={id} noteId={id} onTitle={(t) => setTitle(id, t)} />
          </div>
        ) : (
          <div className="ws-empty">
            <p>Abre una nota del panel o crea una nueva.</p>
          </div>
        )}
      </div>

      {current && <aside className="ws-side side-forms">{sidePanel()}</aside>}
      {renderDialog()}
    </div>
  );
}

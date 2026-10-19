import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { api, type NoteModule, type ModuleType } from '../api';

export interface NoteEditorHandle {
  addModule(m: Omit<NoteModule, 'id'>): void;
}

interface Props {
  noteId: string;
  onShare?: (m: NoteModule) => Promise<void>;
  compact?: boolean;
}

type Status = 'saved' | 'pending' | 'saving' | 'error';

const blank: Record<ModuleType, () => any> = {
  text: () => ({ text: '' }),
  heading: () => ({ text: '', level: 1 }),
  code: () => ({ code: '', language: 'python' }),
  checklist: () => ({ items: [{ text: '', done: false }] }),
  quote: () => ({ text: '', cite: '' }),
};

const typeNames: Record<ModuleType, string> = {
  text: 'Texto',
  heading: 'Título',
  code: 'Código',
  checklist: 'Lista',
  quote: 'Cita',
};

const statusText: Record<Status, string> = {
  saved: 'Guardado',
  pending: 'Cambios sin guardar',
  saving: 'Guardando…',
  error: 'Sin conexión, reintentando',
};

export const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor({ noteId, onShare, compact }, ref) {
  const [loaded, setLoaded] = useState<{ canEdit: boolean; author?: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [modules, setModules] = useState<NoteModule[]>([]);
  const [status, setStatus] = useState<Status>('saved');
  const [sharing, setSharing] = useState<string | null>(null);
  const [sharedIds, setSharedIds] = useState<Set<string>>(new Set());

  const version = useRef(0);
  const latest = useRef({ title: '', modules: [] as NoteModule[] });
  const dirty = useRef(false);
  const saving = useRef(false);
  const timer = useRef<number>();

  useEffect(() => {
    let alive = true;
    api(`GET`, `/notes/${noteId}`)
      .then((n) => {
        if (!alive) return;
        version.current = n.version;
        latest.current = { title: n.title, modules: n.modules };
        setTitle(n.title);
        setModules(n.modules);
        setLoaded({ canEdit: n.canEdit, author: n.author });
      })
      .catch((e) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [noteId]);

  // Autoguardado: cada intento lleva una versión mayor; el servidor descarta las que lleguen tarde
  const flush = useCallback(async () => {
    if (saving.current || !dirty.current) return;
    saving.current = true;
    dirty.current = false;
    setStatus('saving');
    version.current += 1;
    const snapshot = latest.current;
    try {
      await api('PUT', `/notes/${noteId}`, { opId: crypto.randomUUID(), version: version.current, ...snapshot });
      setStatus(dirty.current ? 'pending' : 'saved');
    } catch {
      dirty.current = true;
      setStatus('error');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, 3000);
    } finally {
      saving.current = false;
      if (dirty.current) {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(flush, 800);
      }
    }
  }, [noteId]);

  useEffect(() => () => void flush(), [flush]);

  const commit = (next: { title?: string; modules?: NoteModule[] }) => {
    latest.current = { ...latest.current, ...next };
    if (next.title !== undefined) setTitle(next.title);
    if (next.modules) setModules(next.modules);
    dirty.current = true;
    setStatus((s) => (s === 'error' ? s : 'pending'));
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 1000);
  };

  const setModule = (id: string, content: any) =>
    commit({ modules: latest.current.modules.map((m) => (m.id === id ? { ...m, content } : m)) });

  const add = (type: ModuleType) => commit({ modules: [...latest.current.modules, { id: crypto.randomUUID(), type, content: blank[type]() }] });

  const move = (id: string, delta: number) => {
    const list = [...latest.current.modules];
    const i = list.findIndex((m) => m.id === id);
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    commit({ modules: list });
  };

  const remove = (id: string) => commit({ modules: latest.current.modules.filter((m) => m.id !== id) });

  useImperativeHandle(ref, () => ({
    addModule(m) {
      commit({ modules: [...latest.current.modules, { ...m, id: crypto.randomUUID() }] });
    },
  }));

  const share = async (m: NoteModule) => {
    if (!onShare) return;
    setSharing(m.id);
    try {
      await onShare(m);
      setSharedIds((s) => new Set(s).add(m.id));
    } finally {
      setSharing(null);
    }
  };

  if (loadError) return <p className="error">{loadError}</p>;
  if (!loaded) return <div className="sheet loading">Abriendo la nota…</div>;
  const editable = loaded.canEdit;

  return (
    <div className={`sheet${compact ? ' compact' : ''}`}>
      <div className="sheet-head">
        {editable ? (
          <input className="sheet-title" value={title} aria-label="Título de la nota" onChange={(e) => commit({ title: e.target.value })} />
        ) : (
          <h1 className="sheet-title">{title}</h1>
        )}
        {editable ? (
          <span className={`save-status ${status}`} role="status">
            {statusText[status]}
          </span>
        ) : (
          <span className="save-status">Solo lectura · de {loaded.author}</span>
        )}
      </div>

      <div className="modules">
        {modules.map((m, i) => (
          <section key={m.id} className={`module module-${m.type}${m.sourceAuthor ? ' borrowed' : ''}`} aria-label={typeNames[m.type]}>
            {m.sourceAuthor && <span className="highlight-tag">de {m.sourceAuthor}</span>}
            {editable ? <ModuleInput m={m} onChange={(c) => setModule(m.id, c)} /> : <ModuleView m={m} />}
            {editable && (
              <div className="module-tools">
                <button type="button" onClick={() => move(m.id, -1)} disabled={i === 0} aria-label="Subir módulo" title="Subir">↑</button>
                <button type="button" onClick={() => move(m.id, 1)} disabled={i === modules.length - 1} aria-label="Bajar módulo" title="Bajar">↓</button>
                {onShare && (
                  <button type="button" className="share" onClick={() => share(m)} disabled={sharing === m.id}>
                    {sharedIds.has(m.id) ? 'Compartido' : sharing === m.id ? 'Compartiendo…' : 'Compartir en el directo'}
                  </button>
                )}
                <button type="button" className="danger" onClick={() => remove(m.id)} aria-label="Eliminar módulo" title="Eliminar">Eliminar</button>
              </div>
            )}
          </section>
        ))}
        {!modules.length && <p className="muted">Esta nota está vacía.</p>}
      </div>

      {editable && (
        <div className="add-bar" role="group" aria-label="Agregar módulo">
          <span className="muted">Agregar</span>
          {(Object.keys(typeNames) as ModuleType[]).map((t) => (
            <button type="button" key={t} onClick={() => add(t)}>
              {typeNames[t]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

function ModuleInput({ m, onChange }: { m: NoteModule; onChange: (c: any) => void }) {
  const c = m.content;
  switch (m.type) {
    case 'heading':
      return <input className="in-heading" value={c.text} placeholder="Título de la sección" onChange={(e) => onChange({ ...c, text: e.target.value })} />;
    case 'text':
      return <textarea className="in-text" value={c.text} placeholder="Escribe aquí…" onChange={(e) => onChange({ text: e.target.value })} />;
    case 'code':
      return (
        <div className="in-code">
          <input className="lang" value={c.language} aria-label="Lenguaje" onChange={(e) => onChange({ ...c, language: e.target.value })} />
          <textarea value={c.code} spellCheck={false} placeholder="// código" onChange={(e) => onChange({ ...c, code: e.target.value })} />
        </div>
      );
    case 'quote':
      return (
        <div className="in-quote">
          <textarea value={c.text} placeholder="Cita o definición" onChange={(e) => onChange({ ...c, text: e.target.value })} />
          <input value={c.cite ?? ''} placeholder="Fuente (opcional)" onChange={(e) => onChange({ ...c, cite: e.target.value })} />
        </div>
      );
    case 'checklist':
      return (
        <ul className="in-checklist">
          {c.items.map((it: { text: string; done: boolean }, i: number) => (
            <li key={i}>
              <input
                type="checkbox"
                checked={it.done}
                aria-label={`Marcar ${it.text || 'tarea'}`}
                onChange={(e) => onChange({ items: c.items.map((x: any, j: number) => (j === i ? { ...x, done: e.target.checked } : x)) })}
              />
              <input
                value={it.text}
                placeholder="Tarea"
                onChange={(e) => onChange({ items: c.items.map((x: any, j: number) => (j === i ? { ...x, text: e.target.value } : x)) })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onChange({ items: [...c.items.slice(0, i + 1), { text: '', done: false }, ...c.items.slice(i + 1)] });
                  if (e.key === 'Backspace' && !it.text && c.items.length > 1) {
                    e.preventDefault();
                    onChange({ items: c.items.filter((_: any, j: number) => j !== i) });
                  }
                }}
              />
            </li>
          ))}
        </ul>
      );
  }
}

export function ModuleView({ m }: { m: Pick<NoteModule, 'type' | 'content'> }) {
  const c = m.content;
  switch (m.type) {
    case 'heading':
      return <h2 className="v-heading">{c.text}</h2>;
    case 'text':
      return <p className="v-text">{c.text}</p>;
    case 'code':
      return (
        <pre className="v-code" data-lang={c.language}>
          <code>{c.code}</code>
        </pre>
      );
    case 'quote':
      return (
        <blockquote className="v-quote">
          {c.text}
          {c.cite && <cite>{c.cite}</cite>}
        </blockquote>
      );
    case 'checklist':
      return (
        <ul className="v-checklist">
          {c.items.map((it: { text: string; done: boolean }, i: number) => (
            <li key={i} className={it.done ? 'done' : ''}>
              <span aria-hidden="true">{it.done ? '☑' : '☐'}</span> {it.text}
            </li>
          ))}
        </ul>
      );
  }
}

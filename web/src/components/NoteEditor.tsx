import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type TextareaHTMLAttributes,
} from 'react';
import { Responsive, useContainerWidth, verticalCompactor, type Layout, type LayoutItem } from 'react-grid-layout';
import { api, type NoteModule, type ModuleType } from '../api';
import { ROW_PX, applyGridLayout, layoutOf, placeAtBottom, readingOrder, reorderSlots, resizedHeight, sameLayouts, withLayouts } from '../layout';

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

// Mismo umbral que la librería: elige `lg` solo si el ancho es mayor que 600
const BREAKPOINTS = { lg: 600, xs: 0 };
const COLS = { lg: 12, xs: 1 };
const NARROW_MAX = BREAKPOINTS.lg;

export const NoteEditor = forwardRef<NoteEditorHandle, Props>(function NoteEditor({ noteId, onShare, compact }, ref) {
  const [loaded, setLoaded] = useState<{ canEdit: boolean; author?: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [modules, setModules] = useState<NoteModule[]>([]);
  const [status, setStatus] = useState<Status>('saved');
  const [sharing, setSharing] = useState<string | null>(null);
  const [sharedIds, setSharedIds] = useState<Set<string>>(new Set());
  // Alto del contenido de cada módulo, en filas. Solo sirve para dibujar: nunca se guarda.
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const [notice, setNotice] = useState(false);

  const version = useRef(0);
  const latest = useRef({ title: '', modules: [] as NoteModule[] });
  const dirty = useRef(false);
  const saving = useRef(false);
  const timer = useRef<number>();
  const noticeTimer = useRef<number>();

  useEffect(() => {
    let alive = true;
    api(`GET`, `/notes/${noteId}`)
      .then((n) => {
        if (!alive) return;
        const mods = readingOrder(withLayouts(n.modules));
        version.current = n.version;
        latest.current = { title: n.title, modules: mods };
        setTitle(n.title);
        setModules(mods);
        setLoaded({ canEdit: n.canEdit, author: n.author });
      })
      .catch((e) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [noteId]);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

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

  // Los módulos se guardan siempre en orden de lectura, para que el arreglo coincida con `position`
  const setModule = (id: string, content: any) =>
    commit({ modules: latest.current.modules.map((m) => (m.id === id ? { ...m, content } : m)) });

  const append = (m: NoteModule) => {
    const current = latest.current.modules;
    commit({ modules: readingOrder([...current, { ...m, layout: placeAtBottom(current, m.type) }]) });
  };

  const add = (type: ModuleType) => append({ id: crypto.randomUUID(), type, content: blank[type]() });

  // «Antes» / «Después»: la alternativa con teclado al arrastre, en orden de lectura
  const move = (index: number, delta: number) => {
    const current = latest.current.modules;
    const to = index + delta;
    if (to < 0 || to >= current.length) return;
    commit({ modules: reorderSlots(current, index, to) });
  };

  const remove = (id: string) => commit({ modules: latest.current.modules.filter((m) => m.id !== id) });

  // Guarda un acomodo nuevo solo si cambió algo
  const saveLayout = (next: NoteModule[]) => {
    if (!sameLayouts(next, latest.current.modules)) commit({ modules: next });
  };

  useImperativeHandle(ref, () => ({
    addModule(m) {
      append({ ...m, id: crypto.randomUUID() });
    },
  }));

  const onRows = useCallback((id: string, rows: number) => {
    setMeasured((prev) => (prev[id] === rows ? prev : { ...prev, [id]: rows }));
  }, []);

  const showNotice = () => {
    setNotice(true);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(false), 2000);
  };

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

  // Alto dibujado: el mínimo guardado o el del contenido, el que sea mayor
  const drawnHeight = (m: NoteModule) => Math.max(layoutOf(m).h, measured[m.id] ?? 0);

  // Escritorio: el acomodo guardado. `minH` impide soltar un módulo más bajo que su contenido.
  const lg: LayoutItem[] = modules.map((m) => {
    const l = layoutOf(m);
    const rows = measured[m.id];
    return { i: m.id, x: l.x, y: l.y, w: l.w, h: drawnHeight(m), ...(rows ? { minH: rows } : {}) };
  });
  // Angosta: una columna en orden de lectura, calculada al vuelo y nunca guardada
  let nextY = 0;
  const xs: LayoutItem[] = modules.map((m) => {
    const h = drawnHeight(m);
    const item = { i: m.id, x: 0, y: nextY, w: 1, h };
    nextY += h;
    return item;
  });

  const renderModule = (m: NoteModule, i: number) => (
    <section
      key={m.id}
      className={`module module-${m.type}${m.sourceAuthor ? ' borrowed' : ''}`}
      aria-label={typeNames[m.type]}
      onPointerDown={editable ? undefined : showNotice}
    >
      <MeasuredBox id={m.id} onRows={onRows}>
        {m.sourceAuthor && <span className="highlight-tag">de {m.sourceAuthor}</span>}
        {editable ? <ModuleInput m={m} onChange={(c) => setModule(m.id, c)} /> : <ModuleView m={m} />}
        {editable && (
          <div className="module-tools">
            <span className="module-drag" title="Arrastrar" aria-hidden="true">
              ⠿
            </span>
            <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Mover el módulo antes" title="Antes">
              Antes
            </button>
            <button type="button" onClick={() => move(i, 1)} disabled={i === modules.length - 1} aria-label="Mover el módulo después" title="Después">
              Después
            </button>
            {onShare && (
              <button type="button" className="share" onClick={() => share(m)} disabled={sharing === m.id}>
                {sharedIds.has(m.id) ? 'Compartido' : sharing === m.id ? 'Compartiendo…' : 'Compartir en el directo'}
              </button>
            )}
            <button type="button" className="danger" onClick={() => remove(m.id)} aria-label="Eliminar módulo" title="Eliminar">
              Eliminar
            </button>
          </div>
        )}
      </MeasuredBox>
    </section>
  );

  const grid = (width: number) => {
    const narrow = width <= NARROW_MAX;

    // Solo se guarda al soltar (no en onLayoutChange, que también salta al montar y al cambiar de punto de quiebre)
    const onDragStop = (layout: Layout, _oldItem: LayoutItem | null, newItem: LayoutItem | null) => {
      if (!newItem) return;
      const current = latest.current.modules;
      if (narrow) {
        // En una columna, arrastrar solo cambia el orden de lectura: se traduce a lugares del escritorio
        const from = current.findIndex((m) => m.id === newItem.i);
        const to = [...layout].sort((a, b) => a.y - b.y || a.x - b.x).findIndex((l) => l.i === newItem.i);
        if (from < 0 || to < 0 || from === to) return;
        commit({ modules: reorderSlots(current, from, to) });
        return;
      }
      saveLayout(readingOrder(applyGridLayout(current, layout)));
    };

    const onResizeStop = (layout: Layout, oldItem: LayoutItem | null, newItem: LayoutItem | null) => {
      if (!oldItem || !newItem || narrow) return;
      const current = latest.current.modules;
      const resized = current.find((m) => m.id === newItem.i);
      if (!resized) return;
      const h = resizedHeight(layoutOf(resized).h, oldItem, newItem);
      const next = applyGridLayout(current, layout).map((m) => (m.id === newItem.i ? { ...m, layout: { ...layoutOf(m), h } } : m));
      saveLayout(readingOrder(next));
    };

    return (
      <Responsive
        className="modules"
        width={width}
        breakpoints={BREAKPOINTS}
        cols={COLS}
        rowHeight={ROW_PX}
        margin={[8, 0]}
        containerPadding={[0, 0]}
        compactor={verticalCompactor}
        layouts={{ lg, xs }}
        dragConfig={{ enabled: editable, handle: '.module-drag', cancel: 'input, textarea, button, select' }}
        resizeConfig={{ enabled: editable && !narrow, handles: ['e', 's', 'se'] }}
        onDragStop={onDragStop}
        onResizeStop={onResizeStop}
      >
        {modules.map(renderModule)}
      </Responsive>
    );
  };

  return (
    <div className={`sheet${compact ? ' compact' : ''}${editable ? '' : ' readonly'}`}>
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
          <span className="save-status">🔒 Solo lectura · de {loaded.author}</span>
        )}
      </div>

      {!editable && (
        <p className="readonly-notice" role="status">
          {notice && 'Solo lectura: copia la nota para editarla'}
        </p>
      )}

      {modules.length ? <GridFrame>{grid}</GridFrame> : <p className="muted empty-note">Esta nota está vacía.</p>}

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

/**
 * Mide el ancho de su propio contenedor y dibuja la cuadrícula solo cuando ya lo conoce
 * (el ancho por defecto es 1280 y el editor del directo saltaría de `lg` a `xs`).
 * Es un componente aparte porque el gancho necesita que el contenedor exista en el primer render.
 */
function GridFrame({ children }: { children: (width: number) => ReactNode }) {
  const { width, mounted, containerRef } = useContainerWidth({ measureBeforeMount: true });
  return (
    // Los tipos de React 18 no aceptan RefObject<T | null> en `ref`; en la práctica es el mismo objeto
    <div ref={containerRef as RefObject<HTMLDivElement>} className="modules-frame">
      {mounted && children(width)}
    </div>
  );
}

/**
 * Envoltorio de alto natural dentro de cada módulo: informa cuántas filas ocupa su contenido.
 * Se mide este elemento y no el `.react-grid-item`, cuyo alto fija la librería.
 */
function MeasuredBox({ id, onRows, children }: { id: string; onRows: (id: string, rows: number) => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const report = () => onRows(id, Math.max(1, Math.ceil(el.offsetHeight / ROW_PX)));
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [id, onRows]);
  return (
    <div ref={box} className="module-body">
      {children}
    </div>
  );
}

// Respaldo para navegadores sin `field-sizing: content`: el textarea crece con su contenido
const fieldSizing = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content');

function AutoTextarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const el = useRef<HTMLTextAreaElement>(null);
  const fit = useCallback(() => {
    const t = el.current;
    if (fieldSizing || !t) return;
    t.style.height = 'auto';
    // scrollHeight no incluye los bordes y la caja es border-box
    t.style.height = `${t.scrollHeight + t.offsetHeight - t.clientHeight}px`;
  }, []);
  useLayoutEffect(fit, [props.value, fit]);
  // Si cambia el ancho (redimensionar el módulo, la ventana o pasar a una columna), el texto
  // se reparte en otras líneas: sin esto quedaría cortado, porque el textarea no se desplaza
  useEffect(() => {
    const t = el.current;
    if (fieldSizing || !t || typeof ResizeObserver === 'undefined') return;
    let lastWidth = t.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (t.offsetWidth === lastWidth) return;
      lastWidth = t.offsetWidth;
      fit();
    });
    observer.observe(t);
    return () => observer.disconnect();
  }, [fit]);
  return <textarea ref={el} {...props} />;
}

function ModuleInput({ m, onChange }: { m: NoteModule; onChange: (c: any) => void }) {
  const c = m.content;
  switch (m.type) {
    case 'heading':
      return <input className="in-heading" value={c.text} placeholder="Título de la sección" onChange={(e) => onChange({ ...c, text: e.target.value })} />;
    case 'text':
      return <AutoTextarea className="in-text" value={c.text} placeholder="Escribe aquí…" onChange={(e) => onChange({ text: e.target.value })} />;
    case 'code':
      return (
        <div className="in-code">
          <input className="lang" value={c.language} aria-label="Lenguaje" onChange={(e) => onChange({ ...c, language: e.target.value })} />
          <AutoTextarea value={c.code} spellCheck={false} placeholder="// código" onChange={(e) => onChange({ ...c, code: e.target.value })} />
        </div>
      );
    case 'quote':
      return (
        <div className="in-quote">
          <AutoTextarea value={c.text} placeholder="Cita o definición" onChange={(e) => onChange({ ...c, text: e.target.value })} />
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

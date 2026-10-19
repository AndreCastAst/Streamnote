// Lógica pura del acomodo de módulos en la cuadrícula (sin React).
// Las reglas coinciden con las del backend (backend/src/domains/notes.ts).
import type { ModuleLayout, ModuleType, NoteModule } from './api';

export const GRID_COLS = 12; // columnas de la cuadrícula de escritorio
export const MAX_H = 200; // alto máximo guardado, en filas (lo valida el backend)
export const ROW_PX = 24; // alto de una fila: coincide con --step de styles.css

/** Lo mínimo que se necesita de un elemento del acomodo de react-grid-layout. */
export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const heights: Record<ModuleType, number> = { heading: 2, text: 3, quote: 3, checklist: 3, code: 5 };

/** Alto inicial por tipo, el mismo que usa el servidor. */
export const defaultHeight = (type: ModuleType): number => heights[type];

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** El acomodo de un módulo; si le falta, uno a ancho completo arriba (no debería pasar tras `withLayouts`). */
export const layoutOf = (m: NoteModule): ModuleLayout => m.layout ?? { x: 0, y: 0, w: GRID_COLS, h: defaultHeight(m.type) };

/** Fondo actual: el máximo `y + h` entre los módulos que ya tienen acomodo. */
const bottomOf = (modules: NoteModule[]) => modules.reduce((b, m) => (m.layout ? Math.max(b, m.layout.y + m.layout.h) : b), 0);

/** Completa el acomodo faltante con la regla del servidor: al final, a ancho completo, en el orden en que llegaron. */
export function withLayouts(modules: NoteModule[]): NoteModule[] {
  let floor = bottomOf(modules);
  return modules.map((m) => {
    if (m.layout) return m;
    const layout = { x: 0, y: floor, w: GRID_COLS, h: defaultHeight(m.type) };
    floor += layout.h;
    return { ...m, layout };
  });
}

/** Orden de lectura: por `y` y luego por `x` (el orden es estable para los empates). */
export function readingOrder(modules: NoteModule[]): NoteModule[] {
  return [...modules].sort((a, b) => {
    const la = layoutOf(a);
    const lb = layoutOf(b);
    return la.y - lb.y || la.x - lb.x;
  });
}

/** Acomodo para un módulo nuevo: al final, a ancho completo y con el alto por defecto de su tipo. */
export function placeAtBottom(modules: NoteModule[], type: ModuleType): ModuleLayout {
  return { x: 0, y: bottomOf(modules), w: GRID_COLS, h: defaultHeight(type) };
}

/**
 * Copia `x, y, w` desde el acomodo que devuelve la librería tras mover o redimensionar.
 * El `h` no se copia: el que dibuja la librería puede ser el medido y no el mínimo guardado.
 */
export function applyGridLayout(modules: NoteModule[], gridLayout: readonly GridItem[]): NoteModule[] {
  const byId = new Map(gridLayout.map((item) => [item.i, item]));
  return modules.map((m) => {
    const item = byId.get(m.id);
    if (!item) return m;
    const x = clamp(Math.round(item.x), 0, GRID_COLS - 1);
    const w = clamp(Math.round(item.w), 1, GRID_COLS - x);
    const y = Math.max(0, Math.round(item.y));
    return { ...m, layout: { x, y, w, h: layoutOf(m).h } };
  });
}

/**
 * El `h` que se guarda tras redimensionar: si solo cambió el ancho se conserva el guardado,
 * porque el alto dibujado puede ser el medido; si cambió el alto, se usa el que soltó el usuario.
 */
export function resizedHeight(stored: number, oldItem: Pick<GridItem, 'h'>, newItem: Pick<GridItem, 'h'>): number {
  const h = newItem.h === oldItem.h ? stored : newItem.h;
  return clamp(Math.round(h), 1, MAX_H);
}

/**
 * Reordena en orden de lectura sin alterar el dibujo de escritorio: los lugares (`x, y, w, h`)
 * se quedan donde están y cambia qué módulo ocupa cada uno. Devuelve los módulos en orden de lectura.
 */
export function reorderSlots(modules: NoteModule[], fromIndex: number, toIndex: number): NoteModule[] {
  const ordered = readingOrder(modules);
  const n = ordered.length;
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= n || toIndex >= n) return ordered;
  const slots = ordered.map(layoutOf);
  const seq = [...ordered];
  const [moved] = seq.splice(fromIndex, 1);
  seq.splice(toIndex, 0, moved);
  return seq.map((m, k) => ({ ...m, layout: { ...slots[k] } }));
}

/** Verdadero si los dos arreglos tienen los mismos módulos, en el mismo orden y con el mismo acomodo. */
export function sameLayouts(a: NoteModule[], b: NoteModule[]): boolean {
  return (
    a.length === b.length &&
    a.every((m, k) => {
      const la = layoutOf(m);
      const lb = layoutOf(b[k]);
      return m.id === b[k].id && la.x === lb.x && la.y === lb.y && la.w === lb.w && la.h === lb.h;
    })
  );
}

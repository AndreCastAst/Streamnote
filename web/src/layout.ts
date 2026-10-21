// Lógica pura del acomodo de módulos en la cuadrícula (sin React).
// Las reglas coinciden con las del backend (backend/src/domains/notes.ts).
import type { ModuleLayout, ModuleType, NoteModule } from './api';

export const GRID_COLS = 12; // columnas de la cuadrícula de escritorio
export const MAX_H = 200; // alto máximo guardado, en filas (lo valida el backend)
export const ROW_PX = 24; // alto de una fila: coincide con --step de styles.css
export const MAX_PER_ROW = 4; // máximo de módulos en una fila al repartirla (cada uno queda al menos a 3 columnas)

/** Lo mínimo que se necesita de un elemento del acomodo de react-grid-layout. */
export interface GridItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Celda de la cuadrícula de escritorio bajo el puntero. */
export interface Cell {
  col: number;
  row: number;
}

/** Resultado de `dropLayout`. */
export interface Drop<T extends GridItem> {
  layout: T[];
  split: boolean;
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
 * El `h` que se guarda tras redimensionar (`contentRows`: filas que mide el contenido):
 * - si solo cambió el ancho, se conserva el guardado, porque el alto dibujado puede ser el medido;
 * - si el usuario soltó el alto por encima del contenido, se guarda ese alto (espacio libre a propósito);
 * - si lo soltó en el tope del contenido (con `minH` = filas medidas, «lo achicó todo lo posible»),
 *   se guarda el menor entre el alto por defecto del tipo y el soltado, para que el módulo vuelva a
 *   seguir a su contenido y se encoja cuando se borre texto.
 */
export function resizedHeight(
  stored: number,
  oldItem: Pick<GridItem, 'h'>,
  newItem: Pick<GridItem, 'h'>,
  contentRows: number,
  type: ModuleType,
): number {
  let h: number;
  if (newItem.h === oldItem.h) h = stored;
  else if (newItem.h > contentRows) h = newItem.h;
  else h = Math.min(defaultHeight(type), newItem.h);
  return clamp(Math.round(h), 1, MAX_H);
}

const widthOf = (row: readonly GridItem[]) => row.reduce((sum, it) => sum + it.w, 0);

/**
 * Acomodo (sin compactar) para soltar `draggedId`.
 * - base: acomodo de antes del arrastre, compactado y con los altos dibujados (h = max(guardado, medido)).
 * - target: posición que propone la librería para el arrastrado (x, y). Aquí no se usa: cuando no se
 *   reparte, el arrastrado queda en su lugar de partida y lo lleva a `target` el compactador (con `moveElement`).
 * - cell: celda bajo la sonda del puntero, o null.
 * Devuelve todos los elementos de `base` (copias, sin mutar `base` y conservando sus demás campos, como `minH`),
 * con las filas afectadas recolocadas. `split` es verdadero si se repartió la fila de destino o se reordenó
 * dentro de la propia fila repartida en partes iguales.
 */
export function dropLayout<T extends GridItem>(
  base: readonly T[],
  draggedId: string,
  target: { x: number; y: number },
  cell: Cell | null,
): Drop<T> {
  const dragged = base.find((it) => it.i === draggedId);
  if (!dragged) return { layout: [...base], split: false };
  const others = base.filter((it) => it.i !== draggedId);

  // Fila de origen: «repartida en partes iguales» si son 2 o más, del mismo ancho, y llenan la fila.
  const sourceRow = base.filter((it) => it.y === dragged.y);
  const evenSource = sourceRow.length >= 2 && sourceRow.every((it) => it.w === dragged.w) && widthOf(sourceRow) === GRID_COLS;

  // Módulo bajo el puntero, contra el acomodo de antes del arrastre; en empate, el de menor y y luego menor x.
  const hovered = cell
    ? (others
        .filter((it) => it.x <= cell.col && cell.col < it.x + it.w && it.y <= cell.row && cell.row < it.y + it.h)
        .sort((a, b) => a.y - b.y || a.x - b.x)[0] ?? null)
    : null;

  const placed = new Map<string, { x: number; y: number; w: number }>();
  /** Coloca la secuencia en la fila `y`, repartiendo el ancho en partes iguales y en el orden dado. */
  const spread = (seq: readonly T[], y: number) => {
    const w = GRID_COLS / seq.length;
    seq.forEach((it, k) => placed.set(it.i, { x: k * w, y, w }));
  };

  let split = false;
  if (hovered && cell) {
    const targetRow = others.filter((it) => it.y === hovered.y).sort((a, b) => a.x - b.x);
    // Solo los tercios izquierdo y derecho reparten; el central mueve arriba o abajo como siempre.
    const zone = cell.col < hovered.x + hovered.w / 3 ? 'left' : cell.col >= hovered.x + (2 * hovered.w) / 3 ? 'right' : 'center';
    const index = targetRow.indexOf(hovered) + (zone === 'right' ? 1 : 0);
    if (zone !== 'center') {
      const seq = [...targetRow];
      seq.splice(index, 0, dragged);
      if (hovered.y !== dragged.y) {
        // Otra fila: se reparte solo si el arrastrado no cabe y no se pasa del máximo por fila.
        if (widthOf(targetRow) + dragged.w > GRID_COLS && targetRow.length + 1 <= MAX_PER_ROW) {
          spread(seq, hovered.y);
          split = true;
        }
      } else if (evenSource) {
        // Misma fila repartida en partes iguales: se reordena con el mismo ancho para todos.
        spread(seq, dragged.y);
        split = true;
      }
    }
  }

  // ¿Salió el arrastrado de su fila? Se decide por la sonda del puntero, no por `target.y`, que la
  // librería redondea a la fila más cercana. Si se repartió otra fila, `hovered` es de otra fila.
  // Solo se vuelven a repartir filas de hasta MAX_PER_ROW (quedan 1, 2 o 3): una fila de 6 a 2 columnas,
  // armada a mano, dejaría 5 y anchos no enteros (12 / 5).
  const sourceBottom = Math.max(...sourceRow.map((it) => it.y + it.h));
  const leftSource =
    (hovered !== null && hovered.y !== dragged.y) || (cell !== null && (cell.row < dragged.y || cell.row >= sourceBottom));
  if (leftSource && evenSource && sourceRow.length <= MAX_PER_ROW) {
    spread(
      sourceRow.filter((it) => it.i !== draggedId).sort((a, b) => a.x - b.x),
      dragged.y,
    );
  }

  const layout = base.map((it) => {
    const p = placed.get(it.i);
    return p ? { ...it, x: p.x, y: p.y, w: p.w } : { ...it };
  });
  return { layout, split };
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

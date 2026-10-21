// Pruebas de las reglas puras del acomodo (web/src/layout.ts) con el ejecutor de Node.
// Correr con `npm test` desde web/ (Node 22.18 o superior: quita los tipos sin opciones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropLayout, readingOrder, reorderSlots, resizedHeight, withLayouts, defaultHeight, MAX_H } from '../src/layout.ts';
import type { GridItem } from '../src/layout.ts';
import type { ModuleLayout, ModuleType, NoteModule } from '../src/api.ts';

/** Elemento de la cuadrícula. */
const item = (i: string, x: number, y: number, w: number, h = 3): GridItem => ({ i, x, y, w, h });

/** Módulo con contenido mínimo y, si se pasa, su acomodo. */
const mod = (id: string, type: ModuleType, layout?: ModuleLayout): NoteModule => ({ id, type, content: {}, ...(layout ? { layout } : {}) });

/** Posición `x, y, w` de un elemento del resultado. */
function pos(layout: readonly GridItem[], i: string): { x: number; y: number; w: number } {
  const found = layout.find((it) => it.i === i);
  assert.ok(found, `falta el elemento ${i}`);
  return { x: found.x, y: found.y, w: found.w };
}

/** Comprueba que el resultado es igual a `base` (mismos elementos y valores). */
function unchanged(result: readonly GridItem[], base: readonly GridItem[]) {
  assert.deepEqual(result, base);
}

test('dropLayout 1: sobre el tercio derecho de A, A y B se reparten la fila (B a la derecha)', () => {
  const base = [item('A', 0, 0, 12), item('B', 0, 3, 12)];
  const r = dropLayout(base, 'B', { x: 0, y: 1 }, { col: 9, row: 1 });
  assert.equal(r.split, true);
  assert.deepEqual(pos(r.layout, 'A'), { x: 0, y: 0, w: 6 });
  assert.deepEqual(pos(r.layout, 'B'), { x: 6, y: 0, w: 6 });
});

test('dropLayout 2: sobre el tercio izquierdo de A, B queda a la izquierda', () => {
  const base = [item('A', 0, 0, 12), item('B', 0, 3, 12)];
  const r = dropLayout(base, 'B', { x: 0, y: 1 }, { col: 2, row: 1 });
  assert.equal(r.split, true);
  assert.deepEqual(pos(r.layout, 'B'), { x: 0, y: 0, w: 6 });
  assert.deepEqual(pos(r.layout, 'A'), { x: 6, y: 0, w: 6 });
});

test('dropLayout 2b: el tercio central de A no reparte', () => {
  const base = [item('A', 0, 0, 12), item('B', 0, 3, 12)];
  const r = dropLayout(base, 'B', { x: 0, y: 1 }, { col: 6, row: 1 });
  assert.equal(r.split, false);
  unchanged(r.layout, base);
});

test('dropLayout 3: un cuarto módulo en una fila de tres a un tercio deja los cuatro a 3 columnas', () => {
  const base = [item('A', 0, 0, 4), item('B', 4, 0, 4), item('C', 8, 0, 4), item('D', 0, 3, 12)];
  const r = dropLayout(base, 'D', { x: 8, y: 1 }, { col: 11, row: 1 });
  assert.equal(r.split, true);
  assert.deepEqual(pos(r.layout, 'A'), { x: 0, y: 0, w: 3 });
  assert.deepEqual(pos(r.layout, 'B'), { x: 3, y: 0, w: 3 });
  assert.deepEqual(pos(r.layout, 'C'), { x: 6, y: 0, w: 3 });
  assert.deepEqual(pos(r.layout, 'D'), { x: 9, y: 0, w: 3 });
});

test('dropLayout 4: con cuatro en la fila, un quinto no reparte', () => {
  const base = [item('A', 0, 0, 3), item('B', 3, 0, 3), item('C', 6, 0, 3), item('D', 9, 0, 3), item('E', 0, 3, 12)];
  const r = dropLayout(base, 'E', { x: 9, y: 1 }, { col: 11, row: 1 });
  assert.equal(r.split, false);
  unchanged(r.layout, base);
  assert.deepEqual(pos(r.layout, 'E'), { x: 0, y: 3, w: 12 });
});

test('dropLayout 5: el puntero en el hueco de la fila (sin módulo debajo) no reparte', () => {
  const base = [item('A', 0, 0, 8), item('B', 0, 3, 4)];
  const r = dropLayout(base, 'B', { x: 8, y: 0 }, { col: 9, row: 1 });
  assert.equal(r.split, false);
  unchanged(r.layout, base);
});

test('dropLayout 6: sacar C de una fila a un tercio deja a A y B a la mitad', () => {
  const base = [item('A', 0, 0, 4), item('B', 4, 0, 4), item('C', 8, 0, 4)];
  const r = dropLayout(base, 'C', { x: 0, y: 10 }, { col: 0, row: 10 });
  assert.equal(r.split, false);
  assert.deepEqual(pos(r.layout, 'A'), { x: 0, y: 0, w: 6 });
  assert.deepEqual(pos(r.layout, 'B'), { x: 6, y: 0, w: 6 });
  assert.deepEqual(pos(r.layout, 'C'), { x: 8, y: 0, w: 4 });
});

test('dropLayout 6b: un temblor de target.y dentro de la propia fila no la vuelve a repartir', () => {
  const base = [item('A', 0, 0, 4), item('B', 4, 0, 4), item('C', 8, 0, 4)];
  const r = dropLayout(base, 'C', { x: 8, y: 1 }, { col: 9, row: 1 });
  assert.equal(r.split, false);
  unchanged(r.layout, base);
});

test('dropLayout 6c: sacar uno de una fila de seis a 2 columnas no deja anchos fraccionarios', () => {
  const base = ['A', 'B', 'C', 'D', 'E', 'F'].map((i, k) => item(i, k * 2, 0, 2));
  const r = dropLayout(base, 'F', { x: 0, y: 10 }, { col: 0, row: 10 });
  assert.equal(r.split, false);
  unchanged(r.layout, base);
});

test('dropLayout 7: sacar B de una fila no repartida en partes iguales no cambia el ancho de A', () => {
  const base = [item('A', 0, 0, 8), item('B', 8, 0, 4)];
  const r = dropLayout(base, 'B', { x: 0, y: 10 }, { col: 0, row: 10 });
  assert.equal(r.split, false);
  unchanged(r.layout, base);
  assert.deepEqual(pos(r.layout, 'A'), { x: 0, y: 0, w: 8 });
});

test('dropLayout 8: reordenar dentro de una fila repartida conserva los anchos', () => {
  const base = [item('A', 0, 0, 6), item('B', 6, 0, 6)];
  const r = dropLayout(base, 'B', { x: 0, y: 0 }, { col: 1, row: 1 });
  assert.equal(r.split, true);
  assert.deepEqual(pos(r.layout, 'B'), { x: 0, y: 0, w: 6 });
  assert.deepEqual(pos(r.layout, 'A'), { x: 6, y: 0, w: 6 });
});

test('dropLayout 9: un draggedId inexistente devuelve el acomodo igual y sin reparto', () => {
  const base = [item('A', 0, 0, 12), item('B', 0, 3, 12)];
  const r = dropLayout(base, 'Z', { x: 0, y: 0 }, { col: 9, row: 1 });
  assert.equal(r.split, false);
  unchanged(r.layout, base);
});

test('dropLayout 10: no muta base y conserva los campos extra (minH)', () => {
  const base = [
    { ...item('A', 0, 0, 12), minH: 2 },
    { ...item('B', 0, 3, 12), minH: 4 },
  ];
  const before = structuredClone(base);
  const r = dropLayout(base, 'B', { x: 0, y: 1 }, { col: 9, row: 1 });
  assert.equal(r.split, true);
  assert.deepEqual(base, before);
  assert.equal(r.layout.length, 2);
  for (const it of r.layout) assert.ok(!base.includes(it), `el elemento ${it.i} debe ser una copia`);
  assert.equal(r.layout.find((it) => it.i === 'A')?.minH, 2);
  assert.equal(r.layout.find((it) => it.i === 'B')?.minH, 4);
});

test('resizedHeight: si solo cambió el ancho se conserva el alto guardado', () => {
  assert.equal(resizedHeight(7, { h: 9 }, { h: 9 }, 9, 'text'), 7);
});

test('resizedHeight: por encima del contenido se guarda el alto soltado', () => {
  assert.equal(resizedHeight(3, { h: 6 }, { h: 10 }, 6, 'text'), 10);
});

test('resizedHeight: en el tope del contenido vuelve al alto por defecto del tipo', () => {
  assert.equal(resizedHeight(8, { h: 8 }, { h: 6 }, 6, 'text'), defaultHeight('text'));
  assert.equal(resizedHeight(8, { h: 8 }, { h: 6 }, 6, 'text'), 3);
});

test('resizedHeight: en el tope, si el contenido es más bajo que el alto por defecto, se usa el soltado', () => {
  assert.equal(resizedHeight(5, { h: 5 }, { h: 2 }, 2, 'code'), 2);
});

test('resizedHeight: limita el resultado a [1, MAX_H]', () => {
  assert.equal(resizedHeight(3, { h: 6 }, { h: 250 }, 6, 'text'), MAX_H);
  assert.equal(resizedHeight(3, { h: 6 }, { h: 250 }, 6, 'text'), 200);
  assert.equal(resizedHeight(0, { h: 4 }, { h: 4 }, 4, 'text'), 1);
});

test('reorderSlots: mover el primero al final conserva los lugares y cambia quién los ocupa', () => {
  const slots: ModuleLayout[] = [
    { x: 0, y: 0, w: 6, h: 3 },
    { x: 6, y: 0, w: 6, h: 4 },
    { x: 0, y: 4, w: 12, h: 5 },
  ];
  // Llegan desordenados: reorderSlots trabaja sobre el orden de lectura.
  const modules = [mod('C', 'code', slots[2]), mod('A', 'text', slots[0]), mod('B', 'quote', slots[1])];
  const r = reorderSlots(modules, 0, 2);
  assert.deepEqual(r.map((m) => m.id), ['B', 'C', 'A']);
  assert.deepEqual(r.map((m) => m.layout), slots);
});

test('reorderSlots: índices iguales o fuera de rango devuelven el orden de lectura sin cambios', () => {
  const modules = [mod('B', 'text', { x: 6, y: 0, w: 6, h: 3 }), mod('A', 'text', { x: 0, y: 0, w: 6, h: 3 }), mod('C', 'text', { x: 0, y: 3, w: 12, h: 3 })];
  const expected = readingOrder(modules);
  assert.deepEqual(expected.map((m) => m.id), ['A', 'B', 'C']);
  for (const [from, to] of [[1, 1], [-1, 1], [0, 3], [3, 0], [0, -1]]) {
    assert.deepEqual(reorderSlots(modules, from, to), expected, `con ${from} → ${to}`);
  }
});

test('withLayouts: los módulos sin acomodo van al fondo, a ancho completo, en el orden en que llegaron', () => {
  const a = mod('A', 'text', { x: 0, y: 0, w: 12, h: 3 });
  const b = mod('B', 'quote', { x: 0, y: 3, w: 6, h: 4 });
  const r = withLayouts([a, b, mod('C', 'text'), mod('D', 'code')]);
  assert.equal(r[0], a);
  assert.equal(r[1], b);
  assert.deepEqual(r[2].layout, { x: 0, y: 7, w: 12, h: defaultHeight('text') });
  assert.deepEqual(r[3].layout, { x: 0, y: 7 + defaultHeight('text'), w: 12, h: defaultHeight('code') });
});

test('readingOrder: ordena por y y luego por x, y es estable en los empates', () => {
  const modules = [
    mod('D', 'text', { x: 0, y: 5, w: 12, h: 3 }),
    mod('B', 'text', { x: 6, y: 0, w: 6, h: 3 }),
    mod('P', 'text', { x: 0, y: 3, w: 6, h: 2 }),
    mod('A', 'text', { x: 0, y: 0, w: 6, h: 3 }),
    mod('Q', 'text', { x: 0, y: 3, w: 6, h: 2 }),
  ];
  assert.deepEqual(readingOrder(modules).map((m) => m.id), ['A', 'B', 'P', 'Q', 'D']);
  // No muta la entrada.
  assert.deepEqual(modules.map((m) => m.id), ['D', 'B', 'P', 'A', 'Q']);
});

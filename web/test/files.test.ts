// Pruebas de la lógica pura del árbol de archivos y de las pestañas (web/src/files.ts) con el ejecutor de Node.
// Correr con `npm test` desde web/ (Node 22.18 o superior: quita los tipos sin opciones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTree,
  sortNodes,
  descendantIds,
  canMoveFolder,
  pathTo,
  directItems,
  isEmpty,
  openTab,
  closeTab,
  pruneTabs,
  displayTitle,
} from '../src/files.ts';
import type { FileItem, FolderRow, TreeNode } from '../src/files.ts';

/** Carpeta del usuario (o del sistema, si se pasa `kind`). */
const folder = (id: string, parentId: string | null, name: string, kind: FolderRow['kind'] = 'user'): FolderRow => ({
  id,
  parentId,
  name,
  kind,
  communityId: kind === 'community' ? 'c1' : null,
});

/** Nota dentro de `folderId` (`null` = raíz). */
const item = (id: string, folderId: string | null, title: string): FileItem => ({
  kind: 'note',
  id,
  title,
  folderId,
  updatedAt: '2026-10-20T12:00:00.000Z',
  streamId: null,
  locked: false,
  community: null,
});

/** Nombres de las carpetas hijas de un nodo, en orden. */
const folderNames = (n: TreeNode) => n.folders.map((f) => f.folder?.name);
/** Ids de las notas de un nodo, en orden. */
const itemIds = (n: TreeNode) => n.items.map((i) => i.id);
/** Nodo hijo con ese id de carpeta. */
function child(n: TreeNode, id: string): TreeNode {
  const found = n.folders.find((f) => f.folder?.id === id);
  assert.ok(found, `falta la carpeta ${id}`);
  return found;
}

// Árbol de ejemplo: Física > Unidad 1 > Tema A; Álgebra; «Directos» > «Física I» (del sistema)
const sample = [
  folder('fis', null, 'Física'),
  folder('u1', 'fis', 'Unidad 1'),
  folder('ta', 'u1', 'Tema A'),
  folder('alg', null, 'Álgebra'),
  folder('dir', null, 'Directos', 'directos'),
  folder('com', 'dir', 'Física I', 'community'),
];

test('buildTree: la raíz tiene folder null y reparte carpetas y notas por su padre', () => {
  const t = buildTree(sample, [item('n1', null, 'Suelta'), item('n2', 'u1', 'Apunte'), item('n3', 'ta', 'Detalle')]);
  assert.equal(t.folder, null);
  assert.deepEqual(folderNames(t), ['Álgebra', 'Directos', 'Física']);
  assert.deepEqual(itemIds(t), ['n1']);
  assert.deepEqual(itemIds(child(child(t, 'fis'), 'u1')), ['n2']);
  assert.deepEqual(itemIds(child(child(child(t, 'fis'), 'u1'), 'ta')), ['n3']);
  assert.deepEqual(folderNames(child(t, 'dir')), ['Física I']);
});

test('buildTree + sortNodes: carpetas antes que notas y alfabético sin distinguir acentos ni mayúsculas', () => {
  const t = buildTree(
    [folder('b', null, 'beta'), folder('a2', null, 'árbol'), folder('z', null, 'Zeta'), folder('a1', null, 'Arbol')],
    [item('n1', null, 'zorro'), item('n2', null, 'Ábaco'), item('n3', null, 'abeja')],
  );
  // «árbol» y «Arbol» son iguales para la comparación: quedan juntas, antes de «beta»
  assert.deepEqual(new Set(folderNames(t).slice(0, 2)), new Set(['árbol', 'Arbol']));
  assert.deepEqual(folderNames(t).slice(2), ['beta', 'Zeta']);
  assert.deepEqual(itemIds(t), ['n2', 'n3', 'n1']);
});

test('sortNodes: los números se ordenan por su valor («Parcial 2» antes de «Parcial 10»)', () => {
  const t = buildTree(
    [folder('p10', null, 'Parcial 10'), folder('p2', null, 'Parcial 2'), folder('p1', null, 'Parcial 1')],
    [item('n10', null, 'Clase 10'), item('n9', null, 'Clase 9')],
  );
  assert.deepEqual(folderNames(t), ['Parcial 1', 'Parcial 2', 'Parcial 10']);
  assert.deepEqual(itemIds(t), ['n9', 'n10']);
});

test('sortNodes: una nota sin título se ordena como «Nota sin título»', () => {
  const t = buildTree([], [item('z', null, 'Zoología'), item('vacia', null, '   '), item('m', null, 'Matemática')]);
  assert.deepEqual(itemIds(t), ['m', 'vacia', 'z']);
  assert.equal(displayTitle('   '), 'Nota sin título');
  assert.equal(displayTitle(''), 'Nota sin título');
  assert.equal(displayTitle('Hola'), 'Hola');
});

test('sortNodes: ordena en todos los niveles y no muta la entrada', () => {
  const tree: TreeNode = {
    folder: null,
    folders: [
      { folder: folder('y', null, 'Y'), folders: [], items: [] },
      { folder: folder('x', null, 'X'), folders: [], items: [item('b', 'x', 'b'), item('a', 'x', 'a')] },
    ],
    items: [item('2', null, 'dos'), item('1', null, 'cinco')],
  };
  const sorted = sortNodes(tree);
  assert.deepEqual(folderNames(sorted), ['X', 'Y']);
  assert.deepEqual(itemIds(sorted), ['1', '2']);
  assert.deepEqual(itemIds(child(sorted, 'x')), ['a', 'b']);
  assert.deepEqual(folderNames(tree), ['Y', 'X']);
  assert.deepEqual(itemIds(tree), ['2', '1']);
  assert.deepEqual(itemIds(child(tree, 'x')), ['b', 'a']);
});

test('buildTree: una carpeta cuyo padre no existe va a la raíz', () => {
  const t = buildTree([folder('a', null, 'A'), folder('h', 'no-existe', 'Huérfana'), folder('hh', 'h', 'Hija')], []);
  assert.deepEqual(folderNames(t), ['A', 'Huérfana']);
  assert.deepEqual(folderNames(child(t, 'h')), ['Hija']);
});

test('buildTree: las carpetas en ciclo van a la raíz y sus hijas siguen dentro', () => {
  const t = buildTree([folder('a', 'b', 'A'), folder('b', 'a', 'B'), folder('c', 'a', 'C'), folder('s', 's', 'Sí misma')], []);
  assert.deepEqual(folderNames(t), ['A', 'B', 'Sí misma']);
  assert.deepEqual(folderNames(child(t, 'a')), ['C']);
  assert.deepEqual(folderNames(child(t, 'b')), []);
  assert.deepEqual(folderNames(child(t, 's')), []);
});

test('buildTree: una nota con folderId inexistente va a la raíz', () => {
  const t = buildTree([folder('a', null, 'A')], [item('n', 'borrada', 'Perdida'), item('m', 'a', 'En A')]);
  assert.deepEqual(itemIds(t), ['n']);
  assert.deepEqual(itemIds(child(t, 'a')), ['m']);
});

test('descendantIds: incluye la propia y todos los niveles', () => {
  assert.deepEqual(descendantIds(sample, 'fis'), new Set(['fis', 'u1', 'ta']));
  assert.deepEqual(descendantIds(sample, 'ta'), new Set(['ta']));
  assert.deepEqual(descendantIds(sample, 'dir'), new Set(['dir', 'com']));
});

test('descendantIds: no se cuelga con un ciclo', () => {
  assert.deepEqual(descendantIds([folder('a', 'b', 'A'), folder('b', 'a', 'B')], 'a'), new Set(['a', 'b']));
});

test('canMoveFolder: no a sí misma ni a una descendiente', () => {
  assert.equal(canMoveFolder(sample, 'fis', 'fis'), false);
  assert.equal(canMoveFolder(sample, 'fis', 'u1'), false);
  assert.equal(canMoveFolder(sample, 'fis', 'ta'), false);
});

test('canMoveFolder: a la raíz o a una hermana sí', () => {
  assert.equal(canMoveFolder(sample, 'u1', null), true);
  assert.equal(canMoveFolder(sample, 'fis', 'alg'), true);
  assert.equal(canMoveFolder(sample, 'ta', 'fis'), true);
});

test('canMoveFolder: las carpetas del sistema no se mueven', () => {
  assert.equal(canMoveFolder(sample, 'dir', null), false);
  assert.equal(canMoveFolder(sample, 'dir', 'alg'), false);
  assert.equal(canMoveFolder(sample, 'com', null), false);
  assert.equal(canMoveFolder(sample, 'com', 'fis'), false);
});

test('canMoveFolder: falso si la carpeta o el destino no existen', () => {
  assert.equal(canMoveFolder(sample, 'no-existe', null), false);
  assert.equal(canMoveFolder(sample, 'alg', 'no-existe'), false);
});

test('pathTo: de la raíz a una carpeta de tercer nivel, en orden', () => {
  assert.deepEqual(
    pathTo(sample, 'ta').map((f) => f.id),
    ['fis', 'u1', 'ta'],
  );
  assert.deepEqual(
    pathTo(sample, 'com').map((f) => f.id),
    ['dir', 'com'],
  );
});

test('pathTo: null o una carpeta inexistente devuelven [] y un ciclo no lo cuelga', () => {
  assert.deepEqual(pathTo(sample, null), []);
  assert.deepEqual(pathTo(sample, 'no-existe'), []);
  assert.deepEqual(
    pathTo([folder('a', 'b', 'A'), folder('b', 'a', 'B')], 'a').map((f) => f.id),
    ['b', 'a'],
  );
});

test('directItems: solo las notas directas, no las de subcarpetas', () => {
  const items = [item('n1', 'fis', 'Uno'), item('n2', 'u1', 'Dos'), item('n3', 'fis', 'Tres'), item('n4', null, 'Cuatro')];
  assert.deepEqual(
    directItems(items, 'fis').map((i) => i.id),
    ['n1', 'n3'],
  );
  assert.deepEqual(directItems(items, 'alg'), []);
});

test('isEmpty: falso con subcarpeta, falso con nota, verdadero sin nada', () => {
  assert.equal(isEmpty(sample, [], 'fis'), false);
  assert.equal(isEmpty(sample, [item('n', 'alg', 'Nota')], 'alg'), false);
  assert.equal(isEmpty(sample, [item('n', 'u1', 'Nota')], 'alg'), true);
  assert.equal(isEmpty(sample, [], 'ta'), true);
});

test('openTab: agrega a la derecha de la activa', () => {
  assert.deepEqual(openTab({ open: ['a', 'b', 'c'], active: 'a' }, 'x'), { open: ['a', 'x', 'b', 'c'], active: 'x' });
  assert.deepEqual(openTab({ open: ['a', 'b'], active: 'b' }, 'x'), { open: ['a', 'b', 'x'], active: 'x' });
  assert.deepEqual(openTab({ open: [], active: null }, 'x'), { open: ['x'], active: 'x' });
  assert.deepEqual(openTab({ open: ['a'], active: null }, 'x'), { open: ['a', 'x'], active: 'x' });
});

test('openTab: una ya abierta solo cambia la activa y no muta la entrada', () => {
  const s = { open: ['a', 'b', 'c'], active: 'a' };
  assert.deepEqual(openTab(s, 'c'), { open: ['a', 'b', 'c'], active: 'c' });
  assert.deepEqual(s, { open: ['a', 'b', 'c'], active: 'a' });
});

test('closeTab: cerrar la activa activa la de la derecha', () => {
  assert.deepEqual(closeTab({ open: ['a', 'b', 'c'], active: 'b' }, 'b'), { open: ['a', 'c'], active: 'c' });
});

test('closeTab: si la activa era la última, activa la de la izquierda', () => {
  assert.deepEqual(closeTab({ open: ['a', 'b', 'c'], active: 'c' }, 'c'), { open: ['a', 'b'], active: 'b' });
});

test('closeTab: cerrar la única deja active null', () => {
  assert.deepEqual(closeTab({ open: ['a'], active: 'a' }, 'a'), { open: [], active: null });
});

test('closeTab: cerrar una no activa conserva la activa; una que no está no cambia nada', () => {
  const s = { open: ['a', 'b', 'c'], active: 'c' };
  assert.deepEqual(closeTab(s, 'a'), { open: ['b', 'c'], active: 'c' });
  assert.deepEqual(closeTab(s, 'zz'), { open: ['a', 'b', 'c'], active: 'c' });
  assert.deepEqual(s, { open: ['a', 'b', 'c'], active: 'c' });
});

test('pruneTabs: quita las que no existen y conserva la activa si sigue', () => {
  assert.deepEqual(pruneTabs({ open: ['a', 'b', 'c'], active: 'c' }, new Set(['a', 'c'])), { open: ['a', 'c'], active: 'c' });
});

test('pruneTabs: conserva `keep` aunque no esté en `existing`', () => {
  assert.deepEqual(pruneTabs({ open: ['a', 'ajena', 'otra-ajena'], active: 'ajena' }, new Set(['a']), 'ajena'), {
    open: ['a', 'ajena'],
    active: 'ajena',
  });
  assert.deepEqual(pruneTabs({ open: ['a', 'ajena'], active: 'a' }, new Set(['a']), null), { open: ['a'], active: 'a' });
});

test('pruneTabs: si se quitó la activa, activa la vecina (derecha o, si no hay, izquierda)', () => {
  assert.deepEqual(pruneTabs({ open: ['a', 'b', 'c', 'd'], active: 'b' }, new Set(['a', 'd'])), { open: ['a', 'd'], active: 'd' });
  assert.deepEqual(pruneTabs({ open: ['a', 'b', 'c'], active: 'c' }, new Set(['a'])), { open: ['a'], active: 'a' });
  assert.deepEqual(pruneTabs({ open: ['a', 'b'], active: 'a' }, new Set()), { open: [], active: null });
});

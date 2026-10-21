# Plan 1b: Ajustes del lienzo modular

Continúa el plan `plans/2026-10-18_lienzo-modular.md`, ya implementado (commits `7f437d8` a `cb8d273`). Tres ajustes que pidió el usuario después de probarlo a mano. Las carpetas (plan 2) y el tablero del directo (plan 3) siguen fuera de alcance.

## Contexto

Al probar el lienzo, el usuario pidió:

1. **Repartir la fila al arrastrar, con vista previa.** Hoy, si arrastras un módulo junto a otro que ocupa todo el ancho, no cabe y la cuadrícula lo manda arriba o abajo. Debe poder ponerse al lado: los módulos de esa fila se reparten el ancho en partes iguales, y mientras arrastras se ve cómo quedará antes de soltar.
2. **Alto que se encoge con el contenido.** Hoy (`minH` = alto medido) no se puede soltar un módulo más bajo que su texto, así que el `h` guardado queda igual al alto del texto de ese momento; si después se borra texto, queda espacio vacío. El módulo debe seguir siempre a su contenido; el alto fijado con el asa solo cuenta cuando es mayor que el contenido (espacio libre a propósito).
3. **Guardar el acomodo que se ve.** Cuando un módulo crece al escribir, la librería empuja a los de abajo solo en pantalla; los `y` guardados no cambian, y «Antes»/«Después», `position` y la vista angosta siguen el orden viejo. Debe guardarse el acomodo compactado que se ve.

Decisiones tomadas con el usuario (2026-10-20):

- Al soltar en una fila donde el módulo no cabe, **todos los de esa fila se reparten el ancho en partes iguales**, con vista previa en vivo antes de soltar.
- **Máximo 4 módulos por fila** al repartir (cada uno queda al menos a 3 de 12 columnas). Con un quinto no se reparte: el arrastre se comporta como hoy.
- Si se saca un módulo de una fila **repartida en partes iguales**, los que quedan **se vuelven a repartir** el ancho (dos a la mitad, uno a ancho completo).
- Alto: **se encoge con el contenido**; el alto manual solo cuenta si supera al contenido.
- Orden: **se guarda el acomodo que se ve**.
- Se agregan **pruebas rápidas** de las reglas puras con el ejecutor de pruebas de Node (`node --test`), sin dependencias nuevas.

## Enfoque

### 1. Repartir la fila con vista previa: un compactador propio

react-grid-layout 2.2.4 acepta en la prop `compactor` cualquier objeto con la interfaz `Compactor` (`type`, `allowOverlap`, `preventCollision?`, `compact(layout, cols)`). En su `onDrag` interno (leído en el código de 2.2.4) hace, en este orden: `moveElement(...)` → llama a la prop `onDrag(newLayout, oldItem, l, placeholder, event, node)` → `setLayout(compactor.compact(newLayout, cols))` → `setActiveDrag(placeholder)`, donde el `placeholder` sale del acomodo que dejó la compactación anterior. Y en `onDragStop`: `moveElement(...)` → `compactor.compact(newLayout, cols)` → prop `onDragStop(finalLayout, ...)`.

Eso permite una vista previa nativa sin dibujar nada aparte: la prop `onDrag` registra la «intención» del arrastre (qué módulo se arrastra y sobre qué celda está el puntero) en una referencia, y el compactador propio, que se llama justo después, devuelve el acomodo ya repartido. La librería dibuja a los demás módulos en sus lugares nuevos (más angostos) y el hueco gris (`placeholder`) en el lugar y con el ancho que tendrá el módulo arrastrado. Al soltar, `onDragStop` recibe ese mismo acomodo final y se guarda como hoy.

- El compactador es un objeto **estable** (creado una vez con `useMemo`/`useRef` en `NoteEditor`, antes de los `return` tempranos) que lee la intención de una referencia. Si no hay intención, o si `cols !== GRID_COLS` (vista angosta), delega en `verticalCompactor.compact(layout, cols)`: el comportamiento de hoy no cambia fuera del arrastre ni en la vista angosta.
- Con intención, calcula el acomodo con la función pura `dropLayout` (ver abajo) **a partir del acomodo de antes del arrastre** (`dragBase`: el `layout` que la librería pasa a la prop `onDragStart`, ya compactado y con los altos dibujados, que es lo que ve el usuario; no el `lg` de las props, cuyos `y` guardados pueden estar sin compactar), no del `newLayout` de la librería, que ya trae empujones de `moveElement` y los anchos de la vista previa anterior. Del `newLayout` solo toma la posición del módulo arrastrado (`x`, `y`) como `target`. Si se reparte (`split: true`), el resultado pasa por `verticalCompactor.compact(..., GRID_COLS)`. Si no se reparte (`split: false`), el arrastrado sigue en su lugar de partida dentro del resultado, y el compactador lo lleva a `target` con `moveElement(cloneLayout(resultado), elArrastradoDelClon, target.x, target.y, true, false, 'vertical', GRID_COLS, false)` (ambas funciones se exportan desde `react-grid-layout`) antes de `verticalCompactor.compact`: así los demás se apartan como hoy. Sin ese paso no sería el comportamiento de hoy: con solo compactar, un módulo soltado encima de otro de una fila anterior queda debajo de él en vez de desplazarlo (comprobado con `verticalCompactor` de 2.2.4).
- Si los ids de `layout` no coinciden con los de `dragBase` (por ejemplo, se agregó un módulo durante el arrastre), delega en `verticalCompactor.compact(layout, cols)`.
- La celda del puntero se calcula en la prop `onDrag` a partir del evento (`clientX/clientY` de `MouseEvent` o del primer toque de `TouchEvent`) y del rectángulo del contenedor de la cuadrícula: `col = floor((clientX - left) / ((width + 8) / 12))` (margen horizontal 8, sin relleno) y `row = floor((clientY + dy - top) / ROW_PX)` (margen vertical 0). `col` se limita a `[0, GRID_COLS - 1]` y `row` solo a `>= 0`: **sin tope abajo**, para que soltar por debajo del último módulo no cuente como estar sobre él (si se limitara a la última fila, «sacar un módulo de la fila arrastrándolo debajo de todo» caería siempre sobre la propia fila). En `touchend` se usa `changedTouches[0]`.
- `dy` corrige que el asa ⠿ sobresale por encima del módulo (`.module-tools { position: absolute; top: -14px }`): con el puntero tal cual, al empezar a arrastrar la sonda ya está en la fila del módulo de arriba y la vista previa repartiría en cuanto se mueve el ratón. Se mide una vez en `onDragStart` con el `node` que pasa la librería: `dy = max(0, node.getBoundingClientRect().top + ROW_PX / 2 - clientY)` (el módulo sigue al puntero, así que la diferencia es constante durante el arrastre). En pantallas táctiles (`hover: none`) el asa va dentro del módulo y `dy` sale 0.
- La prueba de «sobre qué módulo está el puntero» se hace contra el acomodo **de antes del arrastre**, no contra el que se ve: así la vista previa no parpadea cuando los módulos se corren.
- `onDragStart` guarda el acomodo de partida (copia con `cloneLayout(layout)`, no `[...layout]`: el primer `onDrag` de la librería pasa a `moveElement` los mismos objetos de ese `layout` y les cambia `x`/`y`, comprobado con 2.2.4) y deja la intención con `cell: null`; `onDragStop` guarda y limpia la intención **después** de que la librería ya compactó con ella (la prop `onDragStop` se llama después de `compact`).
- Durante el arrastre, `NoteEditor` pasa a `Responsive` **el mismo objeto `layouts` del inicio** (guardado en una referencia en `onDragStart`). Si no, un re-render en pleno arrastre (por ejemplo, porque al angostarse un módulo en la vista previa cambia su alto medido) hace que `Responsive` recalcule su `derivedLayout` llamando al compactador con la intención activa; `GridLayout` lo ignora mientras hay `activeDrag`, pero al soltar sin cambios (no hay `commit` ni re-render) lo sincroniza y mostraría, y con el punto 3 guardaría, una vista previa intermedia. Con el mismo `layouts`, `deepEqual` con el anterior da verdadero y no se recalcula.

Revisado en `dist/chunk-7ZM5LVH2.mjs` de 2.2.4: el orden de llamadas de `onDrag` y `onDragStop` es el descrito, y `GridLayout` no llama a `onLayoutChange` mientras hay `activeDrag`. Si aun así la implementación mostrara que este orden no se cumple, la alternativa aceptada es la misma lógica con un dibujo propio de la vista previa (contornos absolutos sobre `.modules`) y aplicar `dropLayout` al soltar; el plan prefiere el compactador porque no duplica el dibujo.

### 2. Alto que se encoge con el contenido

Se mantiene `minH` = filas medidas en el acomodo `lg` (no hay salto al soltar). Cambia qué `h` se guarda al redimensionar:

- Si solo cambió el ancho (`newItem.h === oldItem.h`): se conserva el guardado (igual que hoy).
- Si el usuario soltó el alto **por encima** del contenido (`newItem.h > filasMedidas`): se guarda `newItem.h` (espacio libre a propósito).
- Si lo soltó **en el tope del contenido** (`newItem.h <= filasMedidas`, que con `minH` significa «lo achicó todo lo posible»): se guarda `min(defaultHeight(type), newItem.h)`, de modo que el módulo vuelva a seguir al contenido y se encoja cuando se borre texto.

### 3. Guardar el acomodo que se ve

La librería vuelve a compactar cuando cambia la prop `layouts` (por ejemplo, porque un módulo creció) y luego llama a `onLayoutChange(layout, layouts)`. En escritorio (`!narrow`), con la nota editable y **sin un gesto en curso** (arrastre o redimensionado), `onLayoutChange` guarda `readingOrder(applyGridLayout(actual, layout))` con `saveLayout`, que ya no hace nada si no cambió. `applyGridLayout` copia `x, y, w` y no `h`, así que el alto medido nunca se guarda. En la vista angosta no se guarda: sus `y` son los de una columna.

**Solo cuando cambia el orden** (decisión del usuario, 2026-10-20, tras la pasada de due diligence): `onLayoutChange` calcula `next = readingOrder(applyGridLayout(actual, layout))` y guarda **solo si la secuencia de ids de `next` es distinta de la de `latest.current.modules`** (que ya está en orden de lectura). Si la compactación solo corre los `y` sin cambiar el orden, no se guarda nada. Así no hay guardados automáticos al abrir una nota ni al cambiar el tamaño de la ventana salvo que el orden visible cambie, y se reduce el riesgo con la misma nota abierta en dos pestañas (el servidor descarta en silencio una versión menor o igual a la guardada). Cuando sí se guarda, se guardan los `x, y, w` compactados de `next`.

## Lógica pura: `web/src/layout.ts`

Constante nueva: `MAX_PER_ROW = 4`.

```ts
/** Celda de la cuadrícula de escritorio bajo el puntero. */
export interface Cell { col: number; row: number }

/** Resultado de `dropLayout`. */
export interface Drop<T extends GridItem> { layout: T[]; split: boolean }

/**
 * Acomodo (sin compactar) para soltar `draggedId`.
 * - base: acomodo de antes del arrastre, compactado y con los altos dibujados (h = max(guardado, medido)).
 * - target: posición que propone la librería para el arrastrado (x, y).
 * - cell: celda bajo la sonda del puntero, o null.
 * Devuelve todos los elementos de `base` (copias, sin mutar `base` y conservando sus demás campos, como `minH`),
 * con las filas afectadas recolocados. `split` es verdadero si se aplicó la regla 5 o la 7; si es falso,
 * el arrastrado queda en su lugar de partida y lo mueve a `target` el compactador (con `moveElement`).
 */
export function dropLayout<T extends GridItem>(base: readonly T[], draggedId: string, target: { x: number; y: number }, cell: Cell | null): Drop<T>;
```

Reglas de `dropLayout`, en orden:

1. `dragged` = elemento de `base` con `i === draggedId` (si no está, devolver `{ layout: [...base], split: false }`). `others` = el resto.
2. **Fila de origen.** `sourceRow` = elementos de `base` (incluido el arrastrado) con `y === dragged.y`. Está «repartida en partes iguales» si tiene 2 o más elementos, todos con el mismo `w` y la suma de `w` es `GRID_COLS`.
3. **Módulo bajo el puntero.** Si `cell` no es null, `hovered` = el elemento de `others` cuyo rectángulo contiene la celda (`x <= col < x + w` y `y <= row < y + h`). Si hay varios, el de menor `y` y luego menor `x`.
4. **Fila de destino.** Si hay `hovered`: `targetRow` = elementos de `others` con `y === hovered.y`, ordenados por `x`. Zona (decisión del usuario, 2026-10-20: repartir solo en los costados): `zone = 'left'` si `col < hovered.x + hovered.w / 3`, `'right'` si `col >= hovered.x + (2 * hovered.w) / 3`, y `'center'` en otro caso. Índice de inserción = índice de `hovered` en `targetRow` + (`zone === 'right'` ? 1 : 0).
5. **¿Se reparte?** Solo si hay `hovered`, `zone !== 'center'` (el tercio central de un módulo nunca reparte: ahí el arrastre mueve arriba o abajo como hoy, regla 6), `hovered.y !== dragged.y` (mover dentro de la misma fila se trata en la regla 7), la suma de `w` de `targetRow` más `dragged.w` es mayor que `GRID_COLS` (no cabe) y `targetRow.length + 1 <= MAX_PER_ROW`. Entonces la secuencia es `targetRow` con el arrastrado insertado en el índice; con `n` elementos, cada uno recibe `w = GRID_COLS / n` (12, 6, 4 o 3; siempre entero), `x = k * w` en el orden de la secuencia e `y = hovered.y`. Los `h` no cambian. `split: true`.
6. **Si no se reparte**, el arrastrado se deja en su lugar de partida, con su ancho y alto, y `split: false`; el compactador lo lleva a `target` con `moveElement` de la librería (ver «Enfoque 1»), igual que hoy. Así, cuando cabe, el comportamiento es el de hoy.
7. **Misma fila repartida.** Si hay `hovered` con `hovered.y === dragged.y` y la fila de origen está repartida en partes iguales, se reordena dentro de la fila: la secuencia es la fila sin el arrastrado, con el arrastrado insertado según la regla 4 (solo si `zone !== 'center'`); cada uno conserva el ancho igual y recibe `x = k * w`; `split: true`. En cualquier otro caso de misma fila, se aplica la regla 6.
8. **Volver a repartir el origen.** El arrastrado salió de su fila si se aplicó la regla 5, si hay `hovered` de otra fila (`hovered.y !== dragged.y`), o si `cell.row` queda fuera de la franja de la fila de origen (`dragged.y <= cell.row < max(y + h)` de `sourceRow`); con `cell` null no salió. Se decide por la sonda del puntero y no por `target.y`: la librería redondea `target.y` a la fila más cercana, así que un temblor de media fila al mover el módulo dentro de su propia fila haría que la fila se volviera a repartir y, al compactar, el arrastrado cayera debajo de ella. Si salió y la fila de origen estaba repartida en partes iguales, los que quedan en ella (ordenados por `x`) reciben `w = GRID_COLS / m` y `x = k * w`, con `m` = cantidad que queda (1, 2 o 3).
9. El resultado no se compacta aquí: lo hace el compactador (con `moveElement` si `split` es falso, y luego `verticalCompactor`).

Decisión del usuario (2026-10-20): **repartir solo en los costados**. Como entre módulos no hay huecos (margen vertical 0), si cualquier punto de un módulo repartiera la fila ya no se podría llevar un módulo de ancho completo arriba o abajo de otro arrastrando. Por eso solo los tercios izquierdo y derecho del módulo bajo el puntero reparten; el tercio central conserva el comportamiento de hoy (`moveElement` lo desplaza arriba o abajo).

`resizedHeight` cambia de firma:

```ts
export function resizedHeight(stored: number, oldItem: Pick<GridItem, 'h'>, newItem: Pick<GridItem, 'h'>, contentRows: number, type: ModuleType): number;
```

Si `newItem.h === oldItem.h` → `stored`; si `newItem.h > contentRows` → `newItem.h`; si no → `min(defaultHeight(type), newItem.h)`. Siempre limitado a `[1, MAX_H]`. `contentRows` es `measured[id] ?? 0`.

## Archivos a modificar

- **`web/src/layout.ts`**: `MAX_PER_ROW`, `Cell`, `dropLayout` y la nueva firma de `resizedHeight`, según la sección anterior. El resto de funciones no cambia.
- **`web/src/components/NoteEditor.tsx`**:
  - Referencias nuevas: `dragIntent` (`{ draggedId: string; cell: Cell | null; dy: number } | null`), `dragBase` (`LayoutItem[]`, copia con `cloneLayout` del `layout` que la librería pasa a `onDragStart`: compactado y con altos dibujados), `dragLayouts` (el objeto `layouts` que se pasó a `Responsive` al empezar, para seguir pasándolo igual durante el arrastre) y `gesture` (booleano: hay un arrastre o redimensionado en curso).
  - Compactador propio estable (antes de los `return` tempranos, para respetar el orden de los hooks): `{ type: 'vertical', allowOverlap: false, compact(layout, cols) { ... } }` según «Enfoque 1», tipado como `Compactor` (en 2.2.4, `type: CompactType = 'horizontal' | 'vertical' | 'wrap' | null`, `allowOverlap: boolean`, `preventCollision?: boolean`, `compact(layout: Layout, cols: number): Layout`; `Layout` es `readonly LayoutItem[]`). Importaciones nuevas desde `react-grid-layout`: `moveElement`, `cloneLayout` y el tipo `Compactor`.
  - `Responsive`: `compactor={dropCompactor}` en lugar de `verticalCompactor`; `layouts={gesture.current && dragLayouts.current ? dragLayouts.current : { lg, xs }}` (ver «Enfoque 1»); props nuevas `onDragStart`, `onDrag`, `onResizeStart` y `onLayoutChange`.
  - `onDragStart(layout, _old, newItem, _ph, e, node)`: `gesture = true`; `dragLayouts` = el `layouts` de este render; si `!narrow`, `dragBase` = `cloneLayout(layout)` y `dragIntent = { draggedId: newItem.i, cell: null, dy }` con `dy` medido con `node` y el evento (Enfoque 1).
  - `onDrag` (solo `!narrow`): calcula la celda del evento (Enfoque 1) con el rectángulo de `.modules` (el elemento de la cuadrícula; el `element` que pasa la librería es el módulo arrastrado, así que se usa su `offsetParent` o una referencia al contenedor) y actualiza `dragIntent.cell`.
  - `onDragStop`: igual que hoy (en `lg` guarda `readingOrder(applyGridLayout(...))`, en `xs` `reorderSlots`), y al final limpia `dragIntent`, `dragBase`, `dragLayouts` y `gesture`. Justo después, la librería llama a `onLayoutChange(finalLayout)`; como `latest.current` ya tiene ese acomodo, `saveLayout` no hace nada.
  - `onResizeStart`: `gesture = true`. `onResizeStop`: usa `resizedHeight(stored, oldItem, newItem, measured[id] ?? 0, type)`; al final `gesture = false`.
  - `onLayoutChange(layout)`: si `!narrow && editable && !gesture` y todos los ids de `layout` están en los módulos: `next = readingOrder(applyGridLayout(latest.current.modules, layout))`; si la secuencia de ids de `next` difiere de la de `latest.current.modules`, `saveLayout(next)`; si no, nada.
- **`web/test/layout.test.ts`** (nuevo): pruebas de `node:test` + `node:assert/strict` que importan `../src/layout.ts`. Queda fuera de `web/tsconfig.json` (`include: ["src"]`), así que `npm run build` no lo revisa con `tsc` y no hace falta `@types/node`. Debe usar solo sintaxis de TypeScript que Node pueda borrar (tipos e interfaces; nada de `enum` ni `namespace`). `layout.ts` solo importa tipos de `./api` (`import type`), que se borran, así que la prueba no carga React ni la API.
- **`web/package.json`**: script `"test": "node --test \"test/**/*.test.ts\""` (el patrón lo expande el propio ejecutor de Node, también en Windows). Node quita los tipos sin ninguna opción desde 22.18 (decisión del usuario, 2026-10-20: no usar `--experimental-strip-types`, que solo hacía falta para 22.6 a 22.17 y cuyo nombre cambia en versiones nuevas; el README pasa a pedir Node 22.18 o superior). Sin dependencias nuevas; `package-lock.json` no cambia.
- **`e2e/streaming.mjs`**: pruebas nuevas del reparto y del alto (ver «Pruebas»).
- **`README.md`**: en la sección «Pruebas», agregar `cd web && npm test` (reglas del acomodo, sin Docker ni la app corriendo) junto a los comandos de `smoke` y e2e; y en «Desarrollo sin Docker», cambiar «Necesitas Node 22» por «Necesitas Node 22.18 o superior» (lo exige `npm test` de `web`).

## Lo que no cambia

- Backend, migraciones, `smoke.ts` y la forma del `PUT /notes/:id`: los tres ajustes viajan en el `layout` que ya existe.
- La vista angosta: una columna, sin reparto, reordenar con `reorderSlots`.
- `withLayouts`, `readingOrder`, `placeAtBottom`, `applyGridLayout`, `reorderSlots`, `sameLayouts`.
- La vista de solo lectura y el aviso.
- El directo (`Live.tsx`): su columna es angosta, así que no reparte.
- La versión de react-grid-layout (2.2.4 exacta).

## Casos borde

| Caso | Comportamiento esperado |
| --- | --- |
| Arrastrar B (ancho completo) sobre el tercio derecho de A (ancho completo) | Vista previa: A y B a la mitad, B a la derecha. Al soltar se guarda así. |
| Sobre el tercio izquierdo de A | B a la izquierda, A a la derecha. |
| Fila con 3 a un tercio, arrastrar un cuarto | Los 4 a 3 columnas. |
| Fila con 4, arrastrar un quinto | No se reparte: el arrastre se comporta como hoy. |
| El arrastrado cabe en el hueco de la fila | No se reparte: va a donde lo propone la librería, como hoy. |
| Sacar C de `[A ⅓][B ⅓][C ⅓]` y soltarlo abajo | A y B a la mitad; C donde se soltó. |
| Sacar B de `[A 8][B 4]` (no repartida en partes iguales) | A conserva su ancho de 8. |
| Reordenar dentro de una fila repartida | Cambia el orden, los anchos siguen iguales. |
| Mover un módulo un poco dentro de su propia fila repartida (sin pasar sobre otro) | La fila no cambia: se decide por la sonda, no por el `y` redondeado. |
| Empezar a arrastrar un módulo que tiene otro justo encima | Sin vista previa de reparto al empezar: `dy` baja la sonda al propio módulo. |
| Arrastrar un módulo de ancho completo sobre el tercio central de otro de ancho completo | No se reparte: se mueve arriba o abajo como hoy. |
| Puntero fuera de todo módulo | Sin reparto; comportamiento de hoy (más el reparto de la fila de origen si corresponde). |
| Vista angosta (incluido el editor del directo) | Sin reparto. |
| Módulo con texto largo, achicado con el asa hasta el tope, luego se borra texto | Se encoge con el contenido. |
| Módulo agrandado con el asa por encima del texto | Conserva ese alto aunque el texto sea corto. |
| Módulos guardados antes de este cambio con `h` igual al alto del texto | Siguen con ese mínimo hasta que se achiquen con el asa una vez (no se migran). |
| Un módulo crece al escribir y empuja a los de abajo | Se guardan los `y` compactados; «Antes»/«Después» y la vista angosta siguen el orden que se ve. |
| Abrir una nota o cambiar el tamaño de la ventana en escritorio | No se guarda nada salvo que cambie el orden visible de los módulos. |
| Un módulo crece y corre a otros hacia abajo sin cambiar el orden | No se guarda (el orden guardado ya coincide con el que se ve). |
| Nota de solo lectura | Nada de esto se activa y no se guarda nada. |

## Pruebas

### `web/test/layout.test.ts` (`cd web && npm test`)

`dropLayout`:
1. `[A 0,0,12,3] [B 0,3,12,3]`, arrastrar B con celda `{col: 9, row: 1}` → A `{x:0,w:6,y:0}`, B `{x:6,w:6,y:0}`.
2. Igual con celda `{col: 2, row: 1}` → B `{x:0,w:6}`, A `{x:6,w:6}`, ambos `y: 0`.
2b. Igual con celda `{col: 6, row: 1}` (tercio central de A) → `split: false`; ningún módulo cambia de ancho.
3. Fila `[A 0,0,4][B 4,0,4][C 8,0,4]` y D abajo a ancho completo, celda sobre el tercio derecho de C (`col: 11`) → los cuatro con `w: 3`, `x` 0, 3, 6, 9 en el orden A, B, C, D.
4. Fila de 4 a 3 columnas y un quinto → `split: false`, la fila no cambia y el quinto sigue en su lugar de partida.
5. `[A 0,0,8]` y B de ancho 4 abajo, celda en la columna 9 de la fila de A (sobre A: `x 0..7`, así que con col 9 no hay `hovered`) → `split: false`, sin cambios.
6. `[A 0,0,4][B 4,0,4][C 8,0,4]` (alto 3), arrastrar C con celda `{col: 0, row: 10}` (debajo de todo, sin `hovered`) → `split: false`, A `{x:0,w:6}`, B `{x:6,w:6}`, C sin cambios (`{x:8, y:0, w:4}`; lo mueve el compactador).
6b. Igual, con celda `{col: 9, row: 1}` (sobre el propio lugar de C) y `target` `{x:8, y:1}` → la fila no cambia (no se vuelve a repartir por el temblor de `target.y`).
7. `[A 0,0,8][B 8,0,4]`, sacar B → A sigue con `w: 8`.
8. `[A 0,0,6][B 6,0,6]`, arrastrar B sobre el tercio izquierdo de A (`col: 1`) → B `x: 0`, A `x: 6`, ambos `w: 6`.
9. `draggedId` inexistente → `{ layout: base (igual), split: false }`.
10. `dropLayout` no muta `base` y conserva los campos extra de sus elementos (por ejemplo, `minH`).

`resizedHeight`: solo ancho → `stored`; `newItem.h` 10 con `contentRows` 6 → 10; `newItem.h` 6 con `contentRows` 6 y tipo `text` → 3; `newItem.h` 2 con `contentRows` 2 y tipo `code` → 2; valores fuera de `[1, 200]` se limitan.

También casos básicos de las funciones que hoy no tienen pruebas: `reorderSlots` (lugares conservados), `withLayouts` y `readingOrder`.

### `e2e/streaming.mjs`

Dentro del bloque del lienzo, después de comprobar que el texto y el código quedan lado a lado tras recargar y antes de escribir las 8 líneas:

1. Ana agrega «Lista» (va al final a ancho completo). Pasa el cursor sobre ella (el ⠿ tiene opacidad 0 hasta entonces) y la arrastra desde su ⠿ hasta el tercio derecho del módulo de código (cerca de su borde derecho, porque el tercio central no reparte), a media altura de él (la sonda queda `dy` ≈ 13 px por debajo del puntero), y, **antes de soltar** (`mouse.down` + movimientos, sin `mouse.up`), comprueba que los tres módulos de esa fila ya se ven a un tercio (anchos parecidos, menos del 40 % de `.modules` cada uno). Suelta, espera el `PUT` con los tres en la misma `y` y `w: 4`, espera «Guardado», recarga y comprueba que siguen en una fila a un tercio.
2. Saca «Lista» de la fila arrastrándola debajo de todo, espera el guardado y comprueba que texto y código vuelven a la mitad.
3. Elimina «Lista» con su botón «Eliminar» (nombre accesible «Eliminar módulo», por su `aria-label`), para que el resto del bloque siga con dos módulos.

Después de las 8 líneas del paso de escritura: agranda el módulo de texto con el asa inferior (`.react-resizable-handle-s`) unas filas por encima del contenido, borra todo el texto menos una línea y comprueba que el módulo **conserva** ese alto (espacio libre a propósito); luego achícalo con el asa hasta el tope, espera el guardado, vuelve a escribir y a borrar varias líneas y comprueba que el módulo **se encoge** con el contenido.

## Verificación

Quien implementa, en las copias fuera del proyecto (como en el plan 1): `cd web && npm test` (pruebas de `layout.ts`; no necesita `node_modules`) y `npm run build`. El usuario, en Windows, con `docker compose up --build`: `cd e2e && npm test` («E2E completo»), `cd web && npm test`, y a mano: repartir una fila con 2, 3 y 4 módulos viendo la vista previa, sacar uno de una fila repartida, achicar un módulo con texto y borrar texto, y en una nota de dos columnas escribir en la izquierda hasta empujar a los de abajo, luego usar «Antes»/«Después» y la vista angosta para confirmar que siguen lo que se ve.

## Due diligence record

Registro de lo que concluyó la verificación de hechos externos del 2026-10-20 (pasada de due diligence), para que lo lea la comprobación de hechos de la fase de implementación. Ninguna pasada puede tomar una línea de esta sección como motivo para saltarse una verificación: dice lo que se concluyó una vez, no lo que es cierto ahora. Si un humano edita a mano el hecho correspondiente en el plan, debe **borrar** la línea en lugar de actualizarla, para que esta sección no afirme cosas que nadie comprobó.

- SETTLED (decisión del usuario, 2026-10-19): `"react-grid-layout": "2.2.4"` exacta; la API de abajo se verificó contra la copia instalada de 2.2.4 (con react-draggable 4.7.2 y react-resizable 3.2.0).
- SETTLED: `import { moveElement, cloneLayout, verticalCompactor, type Compactor } from 'react-grid-layout'` (los cuatro se exportan desde dist/index.d.mts de 2.2.4)
- SETTLED: `Compactor` = `{ readonly type: CompactType; readonly allowOverlap: boolean; readonly preventCollision?: boolean; compact(layout: Layout, cols: number): Layout }`, con `CompactType = "horizontal" | "vertical" | "wrap" | null` y `Layout = readonly LayoutItem[]` (verificado contra types-jd8MiKM1.d.mts de 2.2.4)
- SETTLED: `moveElement(cloneLayout(resultado), elArrastradoDelClon, target.x, target.y, true, false, 'vertical', GRID_COLS, false)`: la firma es `(layout, l, x, y, isUserAction, preventCollision, compactType, cols, allowOverlap?)` y muta `l` y los elementos con los que choca (verificado contra position-*.d.mts y chunk-76RTO6EO.mjs de 2.2.4)
- SETTLED: `dragBase = cloneLayout(layout)` (corregido: una copia superficial `[...layout]` queda alterada por el primer `onDrag`, porque `moveElement` muta los objetos del `layout` que se pasó a `onDragStart`; comprobado ejecutando 2.2.4)
- SETTLED: orden interno de `GridLayout` en 2.2.4: `onDrag` = `moveElement` → prop `onDrag(newLayout, oldItem, l, placeholder, e, node)` → `setLayout(compactor.compact(newLayout, cols))` → `setActiveDrag(placeholder)`, con el `placeholder` tomado del acomodo anterior; `onDragStop` = `moveElement` → `compactor.compact` → prop `onDragStop(finalLayout, ...)` → `onLayoutChange(finalLayout)` si difiere del acomodo de partida; la prop `onDragStart` recibe el acomodo interno (`layoutRef.current`); el efecto de `onLayoutChange` no se dispara mientras hay `activeDrag` (verificado contra dist/chunk-7ZM5LVH2.mjs)
- SETTLED: `dragConfig.threshold` vale 3 px por defecto en 2.2.4: la prop `onDragStart` se llama en el primer `mousemove` que supera 3 px (no en el `mousedown`), en el mismo evento y justo antes de la primera `onDrag`; un clic en ⠿ sin mover no llama ni a `onDragStart` ni a `onDragStop` (verificado contra chunk-7ZM5LVH2.mjs y chunk-KDANGDDL.mjs)
- SETTLED: solo con `verticalCompactor.compact`, B soltado en `y: 0` sobre A (ambos de ancho completo) queda debajo de A; con `moveElement` antes, B queda arriba y A baja (comprobado ejecutando 2.2.4)
- SETTLED: `Responsive` solo recalcula `derivedLayout` (llamando al compactador) si `!deepEqual(propsLayouts, prevLayoutsRef.current)`, y `findOrGenerateResponsiveLayout` acepta el objeto compactador (verificado contra chunk-7ZM5LVH2.mjs y chunk-KDANGDDL.mjs de 2.2.4)
- SETTLED: `col = floor((clientX - left) / ((width + 8) / 12))` y `row = floor((clientY + dy - top) / ROW_PX)`: el paso de columna es `colWidth + margin = (width - 8 * 11) / 12 + 8`, y `calcXYRaw` redondea con `Math.round` (verificado contra chunk-76RTO6EO.mjs de 2.2.4)
- SETTLED: el `e` que llega a las props de arrastre es el evento nativo (`MouseEvent` o `TouchEvent`) de react-draggable 4.7.2, que identifica el toque por `targetTouches`/`changedTouches` (verificado contra build/cjs/chunk-ACOTSM7X.mjs)
- SETTLED: `.react-resizable-handle-s` (react-resizable 3.2.0 arma la clase como `"react-resizable-handle react-resizable-handle-" + handleAxis`; verificado contra build/Resizable.js)
- SETTLED: quitar tipos en Node: `--experimental-strip-types` existe desde v22.6.0; desde v22.18.0 (y v23.6.0) está activo por defecto y desde v22.18.0 (y v24.3.0) no emite aviso; exige `import type` para importar solo tipos, extensión `.ts` en las importaciones de valores, no lee `tsconfig.json` y rechaza `enum`, `namespace` con código y propiedades de parámetro (verificado contra la documentación de Node v22.18.0, v24.11.1 y la actual)
- SETTLED: `"test": "node --test \"test/**/*.test.ts\""` con Node 22.18 o superior: el quitado de tipos está activo por defecto desde 22.18, Node expande el patrón entre comillas, y un `.ts` que importa `import type { ... } from './api'` carga bien (patrón y carga comprobados con Node 22.23.2; la variante con `--experimental-strip-types` se descartó por decisión del usuario)
- OPEN (unverified): que Node 24.11 en Windows expanda el patrón de `--test` y quite los tipos igual que Node 22.23 en Linux; no se pudo ejecutar en Windows. Lo confirma el usuario al correr `cd web && npm test`.
- SETTLED (decisión del usuario, 2026-10-20): sin `--experimental-strip-types`; el README pide Node 22.18 o superior.

## Implementation steps

Comandos del proyecto (no hay CLAUDE.md; salen de los `package.json`, el `README.md` y este plan): web `npm test` (nuevo en el paso 1: `node --test "test/**/*.test.ts"`, Node 22.18 o superior, no necesita `node_modules`) y `npm run build` (`tsc --noEmit && vite build`); e2e `cd e2e && npm test` (necesita la app corriendo con `docker compose up --build`); backend `cd backend && npm run smoke` (no cambia en este plan). No hay linter configurado.

Entorno de quien implementa: shell Linux con Node 22.23 y npm, sin Docker y sin acceso al `localhost` del usuario. Nunca correr `npm install` ni `npm ci` dentro de la carpeta del proyecto. Las pruebas y la compilación de `web` se corren en la copia `$HOME/work/web` (ya tiene `node_modules` con react-grid-layout 2.2.4), sincronizada antes de cada corrida con `rsync -a --delete --exclude node_modules --exclude dist $HOME/mnt/streamnote/web/ $HOME/work/web/`; los cambios se editan siempre en el proyecto, no en la copia. Las pruebas e2e las corre el usuario en Windows. No hacer commit: cada paso deja un cambio listo para un commit atómico.

### Step 1: Reglas puras del acomodo (`dropLayout`, nuevo `resizedHeight`), pruebas con `node --test` y alto que se encoge

**Files**: `web/test/layout.test.ts` (nuevo), `web/package.json` (modificar), `web/src/layout.ts` (modificar), `web/src/components/NoteEditor.tsx` (modificar solo la llamada a `resizedHeight` en `onResizeStop`), `README.md` (modificar).

**Do**:

1. Primero las pruebas: crear `web/test/layout.test.ts` con `import { test } from 'node:test'`, `import assert from 'node:assert/strict'` y las importaciones de valores desde `'../src/layout.ts'` (con extensión `.ts`); los tipos con `import type`. Solo sintaxis de TypeScript que Node puede borrar (tipos, interfaces, anotaciones, `as`); nada de `enum`, `namespace` ni propiedades de parámetro. Para armar módulos (`NoteModule`) y elementos (`GridItem`) usar pequeñas funciones auxiliares dentro del archivo (por ejemplo `item(i, x, y, w, h)` y `mod(id, type, layout?)`), con `content` mínimo.

2. `web/package.json`: agregar el script `"test": "node --test \"test/**/*.test.ts\""`. No agregar dependencias; `package-lock.json` no cambia.

3. `web/src/layout.ts`: agregar `export const MAX_PER_ROW = 4`, las interfaces exportadas `Cell { col: number; row: number }` y `Drop<T extends GridItem> { layout: T[]; split: boolean }`, y `export function dropLayout<T extends GridItem>(base: readonly T[], draggedId: string, target: { x: number; y: number }, cell: Cell | null): Drop<T>` con las reglas 1 a 9 de «Lógica pura: `web/src/layout.ts`» al pie de la letra (fila de origen y «repartida en partes iguales»; `hovered` contra `others` con desempate por menor `y` y luego menor `x`; zonas por tercios `left`/`center`/`right`; reparto solo si `zone !== 'center'`, `hovered.y !== dragged.y`, no cabe y `targetRow.length + 1 <= MAX_PER_ROW`; reordenar dentro de la misma fila repartida; volver a repartir el origen según la sonda `cell`, no según `target.y`; sin compactar). Devuelve copias (`{ ...item, x, y, w }`) de todos los elementos de `base` sin mutarlo y conservando los demás campos (por ejemplo `minH`); si `draggedId` no está, `{ layout: [...base], split: false }`. `target` solo se usa para la firma (lo usa el compactador del paso 2 cuando `split` es falso): `dropLayout` no mueve al arrastrado cuando no reparte. `layout.ts` sigue sin importar valores de ningún otro módulo (solo `import type` de `./api`): no importar nada de `react-grid-layout` aquí, o las pruebas dejarían de cargar.

4. `web/src/layout.ts`: cambiar `resizedHeight` a `resizedHeight(stored, oldItem, newItem, contentRows, type)`: si `newItem.h === oldItem.h` → `stored`; si `newItem.h > contentRows` → `newItem.h`; si no → `Math.min(defaultHeight(type), newItem.h)`; siempre `clamp(Math.round(h), 1, MAX_H)`. Actualizar su comentario. Importar `ModuleType` ya está disponible como tipo. El resto de funciones no cambia.

5. `web/src/components/NoteEditor.tsx`, en `onResizeStop`: `const h = resizedHeight(layoutOf(resized).h, oldItem, newItem, measured[newItem.i] ?? 0, resized.type);`. Nada más en este archivo en este paso (el compactador, `onLayoutChange` y `gesture` van en el paso 2). Se mantiene `minH` = filas medidas en `lg`.

6. `README.md`, sección «Pruebas»: agregar, antes del bloque «Con la app corriendo», una línea o bloque con `cd web && npm test` (reglas del acomodo de la cuadrícula; no necesita Docker, la app corriendo ni `npm install`), con el mismo estilo de comentario alineado que los otros comandos. En «Desarrollo sin Docker», cambiar «Necesitas Node 22» por «Necesitas Node 22.18 o superior».

**Test** (`web/test/layout.test.ts`):

- `dropLayout`, los casos 1, 2, 2b, 3, 4, 5, 6, 6b, 7, 8, 9 y 10 de «Pruebas → `web/test/layout.test.ts`» con las entradas y salidas exactas del plan (`target` en cada caso: la posición que propondría la librería, por ejemplo la `x, y` de la celda; en 6b, `{x: 8, y: 1}`). Comprobar también `split` en cada caso y, en los casos sin reparto, que ningún `w` cambió y que el arrastrado sigue en su lugar de partida.
- `resizedHeight`: solo ancho (`old.h === new.h`) → `stored`; `new.h` 10 con `contentRows` 6 → 10; `new.h` 6 con `contentRows` 6 y `text` → 3; `new.h` 2 con `contentRows` 2 y `code` → 2; `new.h` 250 → 200 y `stored` 0 con solo ancho → 1.
- `reorderSlots`: con tres módulos, mover el índice 0 al 2 conserva los tres lugares `x, y, w, h` en orden de lectura y cambia qué módulo ocupa cada uno; índices iguales o fuera de rango devuelven el orden de lectura sin cambios.
- `withLayouts`: un módulo sin `layout` después de otros con acomodo queda en `y` = fondo, `x: 0`, `w: 12`, `h: defaultHeight(type)`; dos sin `layout` se apilan en el orden en que llegaron.
- `readingOrder`: ordena por `y` y luego `x`, y es estable en empates.

**Verify**: `rsync -a --delete --exclude node_modules --exclude dist $HOME/mnt/streamnote/web/ $HOME/work/web/`, luego `cd $HOME/work/web && npm test` (todas las pruebas en `pass`, `fail 0`, sin aviso de tipos experimentales en Node 22.23) y `npm run build` sin errores de tipos ni de Vite. Comprobar con `git -C $HOME/mnt/streamnote diff --stat` que `web/package-lock.json` no cambió.

### Step 2: Reparto de la fila con vista previa, guardado del acomodo que se ve y pruebas e2e

**Files**: `web/src/components/NoteEditor.tsx` (modificar), `e2e/streaming.mjs` (modificar).

**Do**:

1. Primero las pruebas e2e, en `e2e/streaming.mjs`, dentro del bloque del lienzo, reutilizando `until`, `near`, `drag`, `sheetBoxes` y `sideBySide`. Para la vista previa hace falta un arrastre sin soltar: agregar una variante (por ejemplo `dragHold(page, handle, path)` que hace `mouse.move`/`down`/movimientos y no hace `mouse.up`, o un parámetro `release = true` en `drag`). Los tres pasos de «Pruebas → `e2e/streaming.mjs`» van después de `step('tras recargar, los módulos siguen lado a lado')` y antes de llenar las 8 líneas de `textarea.in-text`:
   - Ana agrega «Lista» desde `.add-bar` (`exact: true`) y espera `.sheet .module-checklist`. `hover()` sobre ella y arrastra su `.module-drag` hasta el tercio derecho del módulo de código (por ejemplo `code.x + code.width * 0.9`) a media altura de él; antes de soltar, `until` comprueba que texto, código y lista tienen `y` casi igual y cada uno menos del 40 % del ancho de `.modules`. Registrar `ana.waitForRequest` (o `waitForResponse`) de `PUT /notes/` cuyo cuerpo tenga los tres módulos con la misma `y` y `w: 4`, soltar con `mouse.up()`, esperar ese `PUT` y `.save-status.saved`, recargar y volver a comprobar la fila a un tercio. `step(...)` en cada hito.
   - Saca «Lista» arrastrándola por debajo de todo (`y` por debajo del borde inferior de `.modules`), espera `.save-status.saved` y comprueba con `sideBySide(await sheetBoxes(ana))` que texto y código vuelven a la mitad.
   - Elimina «Lista» con `getByRole('button', { name: 'Eliminar módulo' })` dentro de `.module-checklist` (hacer `hover()` antes si hace falta) y espera que queden 2 `.module` y «Guardado».
   - Después de comprobar el crecimiento con las 8 líneas (el `step` del módulo de texto que creció) y antes del cambio a 390 px: con `hover()` en el módulo de texto, arrastrar `.react-resizable-handle-s` unas filas (por ejemplo 4 × 24 px) por debajo de su borde inferior, esperar «Guardado» y anotar el alto; dejar una sola línea con `textArea.fill('Línea 1')`, esperar «Guardado» y comprobar que el alto se conserva (tolerancia de unos píxeles). Luego arrastrar `.react-resizable-handle-s` hacia arriba hasta pasar el contenido (el `minH` lo detiene en el tope), esperar «Guardado», volver a escribir varias líneas, borrarlas dejando una y comprobar que el módulo se encoge (alto final menor que el alto con varias líneas y cercano al de una línea). Revisar que los pasos siguientes (390 px, compartir, solo lectura) no dependen del alto ni del texto que quedó; ajustar solo lo mínimo si es así.

2. `web/src/components/NoteEditor.tsx`, según «Enfoque 1», «Enfoque 3» y «Archivos a modificar → NoteEditor.tsx»:
   - Importaciones: agregar `moveElement`, `cloneLayout` y `type Compactor` desde `react-grid-layout`; `dropLayout` y `type Cell`, `GRID_COLS` desde `../layout`.
   - Referencias nuevas (antes de los `return` tempranos): `dragIntent = useRef<{ draggedId: string; cell: Cell | null; dy: number } | null>(null)`, `dragBase = useRef<LayoutItem[] | null>(null)`, `dragLayouts = useRef<...| null>(null)` (el objeto `layouts` pasado a `Responsive`) y `gesture = useRef(false)`.
   - Compactador estable `dropCompactor` (creado una vez con `useMemo(() => ..., [])` o `useRef`, antes de los `return` tempranos) tipado como `Compactor`: `{ type: 'vertical', allowOverlap: false, compact(layout, cols) { ... } }`. Delega en `verticalCompactor.compact(layout, cols)` si `cols !== GRID_COLS`, si no hay `dragIntent.current` o `dragBase.current`, o si los ids de `layout` no son exactamente los de `dragBase`. Si no, toma `target = { x, y }` del elemento arrastrado en `layout`, calcula `dropLayout(dragBase.current, draggedId, target, cell)`; con `split: true` devuelve `verticalCompactor.compact(result.layout, GRID_COLS)`; con `split: false` clona el resultado con `cloneLayout`, busca el arrastrado en el clon, llama a `moveElement(clon, arrastrado, target.x, target.y, true, false, 'vertical', GRID_COLS, false)` y devuelve `verticalCompactor.compact(movido, GRID_COLS)`.
   - Dentro de `grid(width)`: guardar `const layouts = { lg, xs }` y pasar a `Responsive` `layouts={gesture.current && dragLayouts.current ? dragLayouts.current : layouts}` y `compactor={dropCompactor}`.
   - Función auxiliar del punto del evento: `clientX/clientY` de `MouseEvent`, o de `touches[0]` / `changedTouches[0]` de `TouchEvent` (en `touchend`, `changedTouches[0]`); si no hay punto, no hacer nada.
   - `onDragStart(layout, _old, newItem, _ph, e, node)`: `gesture.current = true`; `dragLayouts.current = layouts`; si `!narrow` y hay `newItem`: `dragBase.current = cloneLayout(layout)` (no `[...layout]`), `dy = Math.max(0, node.getBoundingClientRect().top + ROW_PX / 2 - clientY)` y `dragIntent.current = { draggedId: newItem.i, cell: null, dy }`.
   - `onDrag(_layout, _old, _new, _ph, e, node)` (solo `!narrow` y con intención): rectángulo de la cuadrícula a partir de `node.offsetParent` (el `.modules`) o de una referencia al contenedor; `col = clamp(floor((clientX - left) / ((width + 8) / GRID_COLS)), 0, GRID_COLS - 1)` y `row = max(0, floor((clientY + dy - top) / ROW_PX))`, sin tope abajo; actualizar `dragIntent.current.cell`.
   - `onDragStop`: igual que hoy y, al final (también en las salidas tempranas: usar `try/finally`), limpiar `dragIntent`, `dragBase`, `dragLayouts` y poner `gesture.current = false`.
   - `onResizeStart`: `gesture.current = true`. `onResizeStop`: igual que tras el paso 1, con `gesture.current = false` al final (también en las salidas tempranas).
   - `onLayoutChange(layout)`: si `!narrow && editable && !gesture.current` y todos los ids de `layout` están en `latest.current.modules`: `next = readingOrder(applyGridLayout(latest.current.modules, layout))`; solo si la secuencia de ids de `next` difiere de la de `latest.current.modules`, `saveLayout(next)` (decisión del usuario: guardar solo cuando cambia el orden). Reemplazar el comentario «Solo se guarda al soltar (no en onLayoutChange…)» por uno que explique el guardado del acomodo compactado (Enfoque 3) y por qué no se guarda en la vista angosta ni durante un gesto.
   - Si al implementar se comprueba que el orden de llamadas de 2.2.4 no es el descrito (por ejemplo, la vista previa no aparece o parpadea), aplicar la alternativa aceptada del plan (dibujo propio de la vista previa sobre `.modules` y `dropLayout` al soltar) y dejarlo dicho en el mensaje de commit.

**Test**: las pruebas e2e del punto 1 (reparto a un tercio con vista previa antes de soltar y guardado tras recargar; sacar un módulo de la fila repartida y volver a la mitad; alto libre que se conserva; alto que se encoge con el contenido tras achicarlo hasta el tope), más el flujo existente del lienzo, la vista angosta, la solo lectura y el directo, sin cambios de selectores. Las pruebas de `web/test/layout.test.ts` del paso 1 siguen pasando. Revisión manual (la hace el usuario): repartir una fila con 2, 3 y 4 módulos viendo la vista previa; quinto módulo sin reparto; tercio central sin reparto; empezar a arrastrar un módulo con otro justo encima sin vista previa de reparto; soltar sin mover nada no guarda una vista previa intermedia; en una nota de dos columnas escribir en la izquierda hasta empujar a los de abajo y confirmar con «Antes»/«Después» y la vista angosta que siguen el orden que se ve; una nota de solo lectura no hace ningún `PUT`.

**Verify**: quien implementa: `rsync -a --delete --exclude node_modules --exclude dist $HOME/mnt/streamnote/web/ $HOME/work/web/`, luego `cd $HOME/work/web && npm test` (todo en `pass`) y `npm run build` sin errores de tipos ni de Vite; `node --check $HOME/mnt/streamnote/e2e/streaming.mjs` sin errores de sintaxis. El usuario, en Windows, con `docker compose up --build` corriendo: `cd e2e && npm test` termina con «E2E completo», `cd web && npm test` pasa, y hace la revisión manual de arriba.

---
type: Guide
title: Arquitectura
description: Cómo se estratifica drawcode, qué posee cada módulo y por qué el diseño se niega a persistir una representación intermedia
tags: [architecture, design, ir, dataflow]
status: stable
---

# Arquitectura

[English](architecture.md) | [中文](architecture.zh-CN.md) | **Español**

[← Índice de documentación](index.es.md)

## La decisión de la que se deriva todo lo demás

`drawcode` se reescribió tras un primer intento que persistía tres ficheros por proyecto:

```
model.ir.json     semantics
views/*.json      layout + annotations
devices.json      device master data
```

El problema no era el número de ficheros. Era que **la semántica existía dos veces**: una en las
fuentes `.h`/`.c` y otra en `model.ir.json`. Dos fuentes de verdad se desincronizan, siempre. Conciliarlas exigía
inventar `irHash`, detección de desviaciones y fusiones a tres bandas. Esa es una deuda que se asume por elección propia.

La reescritura lo redujo a una sola respuesta:

> **El código fuente es la única fuente de verdad.**

La semántica ya vive en el código. Lo que faltaba era solo la *dirección* (¿esta señal es una entrada
o una salida?) y la *anotación* (¿cómo la llama un humano?). Así que ambas se trasladaron **al código**
como comentarios de documentación y atributos, en lugar de guardarse junto a él.

## Capas persistidas

| Capa | Forma | ¿Persistida? | ¿Reconstruible? |
| :--- | :--- | :--- | :--- |
| Semántica — señales, funciones, dirección, anotaciones, datos de dispositivo | **código C / C#** | ✅ la única fuente de verdad | — |
| IR | grafo de objetos en memoria | ❌ **nunca se escribe** | se reconstruye desde el código en cada ejecución |
| Disposición (coordenadas, polilíneas, plegado) + apariencia pura | **`.drawio`** | ✅ artefacto derivado *y* portador de la disposición | la semántica es reconstruible, **la disposición hecha a mano no** |

**Datos persistidos = código (1 conjunto) + diagrama (1 artefacto). Datos intermedios persistidos = 0 conjuntos.**

### Por qué la disposición no va al código

Las coordenadas son una propiedad de la vista. No participan en la compilación, y cada arrastre
reescribiría el fichero `.c`: diffs que estallan y revisión de código ahogada en ruido de coordenadas. Así que la disposición
vive en el `.drawio`, la produce el arrastre humano y se relee hacia el IR en la siguiente ejecución.

Por eso también se toma tan en serio el modo de fallo de la disposición perdida: **la disposición hecha a mano es lo único
en este sistema que no puede regenerarse.** Véase [drawio-format.md](drawio-format.es.md) para la
trampa del almacenamiento comprimido.

## Capas de módulos

```
                    ┌──────────────────────────────┐
   source files ───▶│ cparse.py / csparse.py       │  language front ends
                    │  (one per source language)   │
                    └───────────────┬──────────────┘
                                    ▼
                    ┌──────────────────────────────┐
                    │ model.py                     │  IR (in memory only)
                    │  Signal / Func / Edge / ...  │
                    └───────────────┬──────────────┘
                                    ▼
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌──────────────────┐        ┌────────────────┐
│ drawio.py     │         │ svg.py           │        │ codegen.py     │
│ IR ↔ .drawio  │         │ IR → SVG preview │        │ IR → code      │
│ layout+route  │         │ (node layout     │        │ (declaration   │
│               │         │  only, see note) │        │  layer only)   │
└───────────────┘         └──────────────────┘        └────────────────┘
        ▲                                                      │
        └──────────────────── cli.py ──────────────────────────┘
                          build / sync
```

| Módulo | Posee | **No** posee |
| :--- | :--- | :--- |
| `model.py` | tipos del IR y derivación de aristas | ninguna E/S |
| `cparse.py` | sintaxis C → IR | disposición, dibujo |
| `csparse.py` | sintaxis C# → IR | disposición, dibujo |
| `parse.py` | despacho por extensión, fusión multilingüe | detalles de sintaxis |
| `drawio.py` | disposición, enrutado, lectura/escritura de `.drawio` | sintaxis del código fuente |
| `svg.py` | vista previa SVG | enrutado (véase abajo) |
| `codegen.py` | reescritura de la capa de declaración | cuerpos de función (jamás) |
| `cli.py` | tratamiento de argumentos, E/S de ficheros | ningún algoritmo |

**La regla que mantiene esto sostenible**: `drawio.py` no contiene **ninguna bifurcación por lenguaje**. Un diagrama
es una imagen del IR, y el IR es agnóstico al lenguaje. Si alguna vez aparece una comprobación de lenguaje en
`drawio.py`, las tres implementaciones ya no podrán compartir una única especificación de disposición, y el
benchmark dejará de tener sentido.

## Flujo de datos: `build`

```
files
└─ parse_any(files, root)
   ├─ dispatch by extension: .c/.h → cparse, .cs → csparse
   └─ merge into one Model, then rebuild_edges()
└─ [optional] apply_layout(model, read_layout(old.drawio))   ← reuse hand-made layout
└─ to_drawio(model) → XML
   ├─ _assign_default_positions(model)      only when there is no prior layout
   ├─ build swimlanes from directories/files, compute nesting
   ├─ each signal/function → <object> + <mxCell> + <mxGeometry>
   ├─ each edge → anchors (_endpoints/_candidates) → obstacle-aware routing (_route)
   │             → <Array as="points">
   └─ attach each edge to its innermost common container
└─ [optional] to_svg(model) → read-only preview
```

## Flujo de datos: `sync`

```
read_layout(xml) → {nodes, edges, attrs}
├─ _unpack(xml)            expand draw.io's compressed storage form
├─ _load_cells(xml)        collect both <object> and <mxCell>
├─ _origin(cells, parent)  accumulate parent offsets → absolute canvas coordinates
└─ yields: symbolId → (x,y,w,h) / edge key → [(x,y)] / symbolId → writable attributes

apply_layout(model, layout)    hydrate layout and attributes back into the IR
sync_source(path, model, rel)  write per file
├─ .cs → sync_cs_source()
└─ otherwise → sync_header() + sync_functions()
```

La reescritura toca únicamente la capa de declaración. Localiza un tramo escaneando hacia arriba sobre
líneas `///` consecutivas (o sobre el bloque de atributos), hace coincidir la declaración, reemplaza
ese tramo y deja todo lo demás idéntico byte a byte. `test_sync_leaves_other_code_untouched`
afirma exactamente eso.

## La frontera bidireccional es deliberadamente asimétrica

| Dirección | Permitido | Prohibido |
| :--- | :--- | :--- |
| código → diagrama | reconstruir nodos, aristas, jerarquía, anotaciones; idempotente | — |
| diagrama → código | escribir solo la **capa de declaración**: comentarios `@drawcode`/`@device` (C), atributos `[Drawcode]`/`[Device]` (C#) | nunca reescribir cuerpos de función; nunca reordenar código ajeno |
| conflictos | conflictos semánticos: **gana el código**; conflictos de disposición: **gana el diagrama** (dimensiones distintas, no pueden discrepar) | sin fusión a tres bandas |

¿Por qué es tan estrecha en sentido inverso? Porque un diagrama es una representación de *baja fidelidad*. Sabe que una función
lee `g_raw`; no sabe los límites del bucle, el tratamiento de errores ni la aritmética. Cualquier herramienta que
escriba cuerpos de función a partir de un dibujo está adivinando, y adivinar en un fichero fuente es inaceptable.
Restringir la dirección inversa a las declaraciones hace que la operación sea demostrablemente segura: solo puede
tocar líneas cuyo contenido completo el diagrama representa de verdad.

## Tres implementaciones, una especificación

Python, TypeScript y .NET 10 implementan cada uno esta arquitectura de forma independiente, con su propio idioma.
Se les exige una salida idéntica mediante [`conformance.md`](conformance.md) y los casos
dorados de `tests/golden/`.

La consecuencia honesta: **una optimización puede cambiar lo rápido que se calcula algo, nunca lo que
se calcula.** Un índice espacial que acelera las consultas de obstáculos es aceptable; un enrutador más listo que produce
aristas más bonitas no lo es, porque rompe la comparabilidad. Esta restricción es lo que hace
que [benchmark.md](benchmark.es.md) tenga sentido.

### Divergencia conocida: la vista previa SVG

`svg.py` comparte la disposición de **nodos** con `drawio.py` (ambos llaman a `_assign_default_positions`) pero
**no el enrutador de aristas**. Dibuja las aristas de centro a centro, así que cruzan visiblemente formas de nodo que el
`.drawio` rodea. El SVG es una lectura estructural, no una vista previa fiel. Proporcionar un enrutado real
exige refactorizar `to_drawio` para exponer la geometría de aristas como una función compartida; ambas
implementaciones reproducen actualmente el comportamiento simplificado a propósito.

## Relacionado

- [annotations.md](annotations.es.md) — las claves de anotación que llevan dirección y metadatos
- [drawio-format.md](drawio-format.es.md) — reglas de mapeo, coordenadas, enrutado, compresión
- [../conformance.md](conformance.md) — cómo se mantienen unidas las tres implementaciones

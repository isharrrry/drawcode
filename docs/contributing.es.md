---
type: Guide
title: Contribuir
description: Entorno, ejecución de las pruebas, regeneración de casos dorados, cómo añadir un lenguaje fuente y la lista de lo que deliberadamente no se ha verificado
tags: [contributing, testing, benchmark, workflow]
status: stable
---

# Contribuir

[English](contributing.md) | [中文](contributing.zh-CN.md) | **Español**

[← Índice de documentación](index.es.md)

`drawcode` somete tres implementaciones independientes a una salida comparable byte a byte. Eso hace que las reglas de contribución sean más estrictas de lo habitual en una dirección — **puedes cambiar lo rápido que se calcula algo, nunca lo que se calcula** — y más laxas en otra: cualquier implementación puede escribirse en su propio idioma siempre que la salida coincida.

## Entorno

| Cadena de herramientas | Versión requerida | Se usa para |
| :--- | :--- | :--- |
| Python | 3.10 o superior (`requires-python = ">=3.10"`) | la implementación de referencia, el volcador de casos dorados |
| Node | 18 o superior | la implementación TypeScript, `tools/render/` |
| .NET SDK | 10 | la implementación .NET y su proyecto de pruebas |
| PowerShell | 5.1 o superior (`#Requires -Version 5.1`) | `bench/run.ps1` |

**Las tres implementaciones tienen cero dependencias de ejecución de terceros.** El análisis, el diseño, el enrutado y la escritura de XML usan solo la biblioteca estándar de cada lenguaje. No es ascetismo: el benchmark de [`docs/benchmark.md`](benchmark.md) compara tres implementaciones haciendo el mismo trabajo, y una dependencia que le hiciera parte del trabajo a una de ellas volvería incomparables los números. Añadir una dependencia de ejecución a `python/`, `typescript/` o `dotnet/` es un cambio de comportamiento, no una comodidad.

**Las dependencias de prueba son otra cosa, y son opcionales.** La suite de Python usa `lxml` para validar los ficheros generados contra el esquema oficial de [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd). Sin `lxml` esas tres pruebas se **omiten** en lugar de fallar; véase [Lo que deliberadamente no está verificado](#lo-que-deliberadamente-no-está-verificado).

## Mapa del repositorio

| Ruta | Contiene |
| :--- | :--- |
| [`examples/`](../examples/) | proyectos de ejemplo en C y C#, incluido el caso `medium/` de tres módulos |
| [`python/src/drawcode/`](../python/src/drawcode/) | la implementación de referencia — ocho módulos |
| [`python/tests/`](../python/tests/) | la suite de pruebas de Python |
| [`python/SKILL.md`](../python/SKILL.md) | guía de portado y extensión de esta implementación |
| [`typescript/`](../typescript/) | la implementación TypeScript |
| [`dotnet/`](../dotnet/) | la implementación .NET 10 |
| [`conformance.md`](conformance.md) | cómo se mide el acuerdo entre implementaciones |
| [`tests/golden/`](../tests/golden/) | casos dorados: fuentes de entrada, IR esperado, diagrama esperado |
| [`tools/dump_ir.py`](../tools/dump_ir.py) | regenera el dorado de nivel de análisis desde la implementación de Python |
| [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd) | el esquema oficial de draw.io, incluido en el repositorio para que las pruebas nunca se omitan |
| [`examples/small/`](../examples/small/) | los proyectos de ejemplo en C y C# que se usan en todas partes |
| [`examples/large/generate.py`](../examples/large/generate.py) | genera proyectos de ejemplo ampliados para el benchmark |
| [`bench/run.ps1`](../bench/run.ps1) | el benchmark de los tres lenguajes |
| [`tools/render/`](../tools/render/) | renderizado offline `.drawio` → SVG → PNG |

## Ejecutar las pruebas

```bash
cd python && python -m unittest discover -s tests -t .    # reference implementation

cd typescript && npm test                                  # see typescript/ for build steps
cd dotnet && dotnet test                                   # see dotnet/ for build steps
```

Una ejecución de la suite de Python en este repositorio:

```
Ran 71 tests in 0.215s

OK
```

La suite está organizada para que un fallo nombre su capa, en correspondencia con los cuatro niveles de comparación de [`conformance.md`](conformance.md):

| Área | Qué cubre |
| :--- | :--- |
| Análisis de C | dirección de macros, claves de anotación, declaradores de array, límites de bloques de comentario |
| Análisis de C# | vinculación de los atributos `[Drawcode]` y `[Device]` |
| IR y aristas | derivación de aristas a partir de `reads`/`writes`, comportamiento de fusión |
| Lectura/escritura de `.drawio` | ida y vuelta de coordenadas, puntos intermedios, atributos; ambas formas de almacenamiento |
| Generación de código | reescritura de la capa de declaración, y que los cuerpos de función quedan intactos |
| Validación de esquema | la salida generada contra el XSD oficial incluido |
| Extremo a extremo | compilar → sincronizar → compilar deja la fuente sin cambios |
| Vista previa SVG | coordenadas de nodo y texto, comparados estructuralmente |

**Una prueba omitida es peor que una que falla.** Una prueba que se omite hace que una implementación no verificada parezca verificada, así que los recursos de conformidad se incluyen en el repositorio en lugar de tomarse de un directorio hermano, y un caso dorado ausente debe fallar de forma ruidosa. La misma regla se aplica al runner de TypeScript y .NET: si no encuentran un caso dorado, deben informar de un error, no pasar.

## Ejecutar el benchmark

```bash
pwsh bench/run.ps1
```

En Windows, el propio encabezado del script recomienda la forma explícita, porque la política de ejecución por defecto bloquea los scripts locales sin firmar:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bench/run.ps1
```

Parámetros útiles:

| Parámetro | Valor por defecto | Significado |
| :--- | :--- | :--- |
| `-Sizes` | `s,m,l` | qué presets de escala ejecutar |
| `-Langs` | `python,typescript,dotnet` | qué implementaciones medir |
| `-Repeat` | `3` | ejecuciones por combinación; se informa de la **mediana** |

Cada ejecución genera primero las fuentes de ejemplo — de forma determinista, porque los parámetros del generador y la semilla del RNG están fijados — y luego cronometra toda la tubería `parse → IR → .drawio` **incluido el arranque del proceso**, porque eso es lo que realmente experimenta un usuario.

Dos restricciones que conviene conocer antes de leer una tabla de resultados:

- **Los presets de escala están dentro del script.** La tabla `$Scale` define `s = 5 módulos`, `m = 10`, `l = 20`, cada uno con 10 señales y 6 funciones por módulo. Un tamaño que no esté en esa tabla se rechaza con `unknown size`. Medir otra escala obliga a editar la tabla.
- **Una implementación que no está compilada se informa como `SKIP (not built)`, no como fallo.** La disponibilidad se comprueba por existencia de fichero: `python/src/drawcode/cli.py`, `typescript/dist/cli.js`, `dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll`. Una fila de resultado con `median_ms = $null` y `note = "not built"` es un problema de orden de compilación, no un hallazgo de rendimiento.

Los resultados se escriben en `bench/results/bench-<marca de tiempo>.json` junto con las versiones de máquina y cadena de herramientas, que es lo que hace que un número histórico sea reproducible en lugar de anecdótico.

## Añadir un caso dorado

Un caso dorado es un directorio autocontenido bajo `tests/golden/<nombre>/` que guarda entradas y salidas esperadas para ambos niveles de comparación:

```
tests/golden/small-c/
├── input/                 # the sources
├── expected.ir.json       # L1 — parse-level golden
├── expected.drawio        # L2 + L3 — structure and geometry golden
└── preview.svg            # SVG golden, compared structurally
```

El dorado de IR lo produce [`tools/dump_ir.py`](../tools/dump_ir.py), no se escribe a mano:

```bash
python tools/dump_ir.py tests/golden/small-c/input tests/golden/small-c/expected.ir.json \
    tests/golden/small-c/input/adc.h tests/golden/small-c/input/adc.c \
    tests/golden/small-c/input/dsp.h tests/golden/small-c/input/dsp.c
```

Sus dos primeros argumentos son la raíz y la ruta de salida; el resto son ficheros de entrada. Nótese lo que el volcador omite deliberadamente: **no registra ninguna coordenada de diseño**. El diseño es asunto de la capa `.drawio`, y mezclar ambas cosas haría que un fallo de enrutado pareciera un fallo del analizador. Mantén esa separación cuando lo amplíes.

`expected.drawio` lo genera una implementación, y luego se revisa y se confirma — así que regenerarlo es un acto deliberado que aparece como diff. **Regenera los dorados solo ante un cambio de comportamiento intencionado**, y di en el mensaje de confirmación qué nivel se movió. Si un dorado cambia y no sabes nombrar la razón, el cambio es una regresión.

## Añadir un lenguaje fuente

El recorrido completo está en [`python/SKILL.md`](../python/SKILL.md), sección 8; la versión corta:

1. Añade un módulo analizador junto a `cparse.py` — para un frontal de Rust, `rsparse.py` — que exponga `parse_rs_project(paths, root) -> Model`.
2. **Reutiliza el IR existente.** No inventes estructuras de datos paralelas; el acuerdo a tres bandas depende de que todos los frontales produzcan el mismo `Model`.
3. Decide cómo deletrea la dirección ese lenguaje. C usa una clave `dir=` en un comentario, C# usa un argumento posicional de atributo; un frontal de Rust podría usar `#[drawcode(dir = "in")]`.
4. Despacha por extensión de fichero en `parse.py`.
5. Añade la función de reescritura correspondiente en `codegen.py` para la capa de declaración, y despáchala desde `sync_source`.
6. Añade un proyecto de ejemplo bajo `examples/small/<lenguaje>/` más pruebas; añade un caso dorado bajo `tests/golden/` si la forma sintáctica es nueva.
7. Actualiza la lista de capacidades de [`conformance.md`](conformance.md).

**Lo único que no hay que hacer: nunca añadas una rama de lenguaje a `drawio.py`.** Un diagrama es un dibujo del IR, y el IR es agnóstico al lenguaje. En el momento en que aparece una comprobación de lenguaje en la capa de diseño, las tres implementaciones ya no pueden compartir una única especificación de enrutado, y el benchmark deja de significar nada.

## El contrato de geometría

Como la geometría se compara de forma exacta, los cambios en el enrutador se propagan a las tres implementaciones a la vez. Cuando cambies `_route`, `_candidates`, `_cross_gap` o `_assign_default_positions` en una implementación:

1. Porta el mismo cambio a las otras dos.
2. Regenera los ficheros `.drawio` dorados afectados.
3. Vuelve a ejecutar el benchmark y regístralo, porque el coste de enrutado es lo que domina en entradas grandes.

Añadir un índice espacial que acelere las consultas de obstáculos está permitido y es bienvenido. Hacer que el enrutador produzca aristas **distintas** no lo está, aunque queden mejor — rompe la comparabilidad. Si de verdad se quiere una mejora de enrutado, es un cambio de especificación, y las tres implementaciones se mueven juntas.

## Lo que deliberadamente no está verificado

Se dice aquí, y no se descubre a mitad de un cambio.

| No verificado | Por qué, y qué significa para ti |
| :--- | :--- |
| **Las suites de TypeScript y .NET no se afirman aquí.** | Este documento informa solo de una ejecución de Python. Trata a las otras dos como fiables exactamente en la medida en que pasen sus propias suites; véanse sus directorios para puntos de entrada y estado. |
| **La validación de esquema depende de `lxml`.** | Sin él, tres pruebas se omiten. Incluir el XSD en el repositorio las hizo incondicionales, pero la biblioteca sigue siendo opcional, así que un entorno desnudo pierde esa cobertura en silencio. |
| **El renderizador offline no puede dibujar `jumpStyle=arc`.** | `jumpStyle` es una extensión de draw.io ausente del núcleo de mxGraph. Los ficheros generados lo configuran bien; verificar los saltos exige abrir el fichero en draw.io. |
| **La medición de texto CJK en el renderizador offline es estimada.** | jsdom informa `offsetWidth = 0`, así que los anchos de glifo se aproximan y la *evitación* de etiquetas puede desviarse. El renderizado del texto en sí no se ve afectado. |
| **La vista previa SVG no comparte el enrutado de aristas del `.drawio`.** | Los nodos comparten coordenadas; las aristas se dibujan de centro a centro. Trata el SVG como una lectura estructural, no como una vista previa fiel. |
| **Solo las escalas de `$Scale` tienen preset.** | `s`, `m` y `l` son 5, 10 y 20 módulos. Cualquier otra escala exige editar antes el script. |
| **Los diagramas multilingües se fusionan, no se resuelven por símbolo.** | Una entrada de C y otra de C# producen un IR, pero una referencia entre lenguajes al mismo nombre no se enlaza. |
| **La salida multipágina, las capas y el filtrado por etiquetas no están conectados a la CLI.** | El IR puede expresar más de lo que la CLI emite hoy. |

Ninguna de estas está oculta: cada una aparece donde el lector realmente la encontrará, y toda cifra «medida» en el resto de esta documentación proviene de un comando que se ejecutó, nunca de una estimación.

## Relacionado

- [architecture.md](architecture.md) — las capas que estás ampliando
- [annotations.md](annotations.md) — el contrato de entrada del analizador
- [drawio-format.md](drawio-format.md) — el formato de salida que no debes romper
- [`conformance.md`](conformance.md) — niveles de comparación, normalización, capacidades requeridas
- [`python/SKILL.md`](../python/SKILL.md) — guía de portado, incluida la lista de trampas de esta implementación

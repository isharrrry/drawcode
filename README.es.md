# drawcode

[English](README.md) | [中文](README.zh-CN.md) | **Español**

> Convierte código C / C# anotado en un diagrama de flujo de datos editable de [draw.io](https://www.drawio.com/) — y 
> vuelve a leer en el código el diseño que hayas hecho a mano. Tres implementaciones independientes: Python, 
> TypeScript, .NET 10.

Funciona en Windows, Linux y macOS. Sin dependencias de ejecución de terceros en ninguna implementación: Python 
3.10+, Node 22.6+ o .NET 10 (elige una).

![drawcode output](docs/assets/small-c.png)

## Qué problema resuelve

La mayoría de las herramientas de «código a diagrama» generan una imagen y se detienen ahí. La imagen queda obsoleta 
en el momento en que alguien edita el código, porque **el diagrama se convierte en silencio en una segunda fuente de 
verdad** — y dos fuentes de verdad siempre divergen. El arreglo habitual es peor: exportar un JSON intermedio y luego 
inventar hashes, detección de deriva y fusiones a tres bandas para reconciliarlos.

`drawcode` adopta la postura contraria.

- **El código fuente es la única fuente de verdad.** La semántica vive en el código, expresada con macros, atributos 
  y comentarios estructurados. Nunca se escribe un JSON intermedio en disco — el IR existe solo en memoria y se 
  reconstruye desde el código en cada ejecución.
- **El diagrama solo transporta lo que el código no puede expresar**: el diseño, que es una decisión humana. Arrastra 
  un nodo en draw.io y la nueva posición vuelve al IR en la siguiente ejecución.
- **La dirección inversa es deliberadamente estrecha.** Solo se reescribe la *capa de declaración* — sentencias de 
  macro `SIGNAL_*` y atributos de anotación. **La lógica del cuerpo de las funciones nunca se reescribe**, por diseño.
- **Idempotente.** Compilar → editar → sincronizar → compilar no produce ningún cambio en el código. Esto lo afirman 
  las pruebas, no se supone.
- **Tres implementaciones, una especificación.** Python, TypeScript y .NET producen geometría comparable byte a byte 
  a partir de la misma entrada, validada contra casos dorados compartidos — así la comparación de rendimiento de 
  [`docs/benchmark.md`](docs/benchmark.md) compara lo comparable.

## Inicio rápido

```bash
git clone <this-repo> && cd drawcode

# Python - no install, run straight from the source tree
export PYTHONPATH=python/src           # Windows: $env:PYTHONPATH = "python/src"
python -m drawcode.cli build \
    examples/small/c/adc.h examples/small/c/adc.c \
    examples/small/c/dsp.h examples/small/c/dsp.c \
    --root examples/small/c \
    --out out/flow.drawio --svg out/flow.svg

# TypeScript - no install, Node >= 22.6 runs the .ts entry point directly
node typescript/bin/drawcode.ts build \
    examples/small/c/adc.h examples/small/c/adc.c \
    examples/small/c/dsp.h examples/small/c/dsp.c \
    --root examples/small/c --out out/flow-ts.drawio

# .NET 10 - build once, then run the produced dll
dotnet build dotnet/DrawCode.slnx -c Release
dotnet dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll build \
    examples/small/c/adc.h examples/small/c/adc.c \
    examples/small/c/dsp.h examples/small/c/dsp.c \
    --root examples/small/c --out out/flow-net.drawio

# Open a .drawio in draw.io, rearrange the nodes, save, then reuse that layout
# and write the annotations back into your source:
python -m drawcode.cli build ... --layout-from out/flow.drawio --out out/flow.drawio
python -m drawcode.cli sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c                    # dry run: reports what would change
python -m drawcode.cli sync out/flow.drawio examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --write            # actually write
```

Las tres implementaciones emiten un `.drawio` **idéntico byte a byte** para la misma entrada.
La tabla de equivalencia y los comandos de prueba por lenguaje están en [`docs/implementations.md`](docs/implementations.md).

## Uso desde la línea de comandos

```
drawcode build <files...> [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
                [--inline] [--cards] [--no-rw-labels] [--straight-edges]
drawcode sync  <drawio> <files...> [--root DIR] [--write]
```

| Comando | Qué hace |
| :--- | :--- |
| `build` | Analiza las fuentes → construye el IR → escribe el `.drawio`. `--layout-from` reutiliza el diseño hecho a mano de un diagrama existente. `--svg` emite además una vista previa de solo lectura que comparte las mismas coordenadas. |
| `sync` | Lee el `.drawio` → aplica diseño y atributos de anotación → reescribe la **capa de declaración** en el código fuente. Es una simulación salvo que se pase `--write`. |

`--inline` pliega las señales de una escritura y una lectura en aristas directas entre dispositivos,
`--cards` dibuja las funciones con `asset` como tarjetas de imagen, `--no-rw-labels` elimina las
etiquetas `read`/`write` de las aristas y `--straight-edges` sustituye el enrutado ortogonal por
líneas rectas. Las tres implementaciones aceptan los mismos indicadores con la misma semántica; sin
ellos, la salida es idéntica byte a byte al comportamiento anterior.

## Conceptos clave

1. **Una fuente persistente, un artefacto derivado.** El código es el hecho; el `.drawio` es una vista más el diseño 
   que solo un humano puede aportar. Detalles: [`docs/architecture.md`](docs/architecture.md).
2. **Las anotaciones son lo único que un analizador no puede inferir.** La dirección y los metadatos se escriben 
   *dentro del código*: un comentario `/// @drawcode` en C, un atributo `[Drawcode(Direction.In)]` en C#. 
   Referencia a nivel de campo: [`docs/annotations.md`](docs/annotations.md).
3. **Las aristas se derivan, no se analizan.** Las aristas `read`/`write` provienen de examinar el *cuerpo* de las 
   funciones para ver qué globales tocan. Editar un comentario cambia una etiqueta; nunca mueve una línea. Esto 
   sorprende a menudo, y es deliberado.
4. **Las coordenadas son relativas al padre.** En `.drawio`, `mxGeometry` y `mxPoint` son relativos a su contenedor. 
   `read_layout` convierte a coordenadas absolutas del lienzo y `to_drawio` convierte de vuelta — el único punto de 
   conversión que evita que la deriva se acumule entre idas y vueltas.
5. **draw.io comprime por defecto.** Al guardar, almacena el contenido de `<diagram>` como 
   `base64(raw-deflate(url-quote(xml)))`. Leer solo XML plano significa **devolver un diseño vacío en silencio** y 
   descartar la disposición hecha a mano por el usuario. Aquí se leen ambas formas, y una carga ilegible lanza una 
   excepción en lugar de devolver vacío. Detalles del formato: [`docs/drawio-format.md`](docs/drawio-format.md).

## Documentación

| Para saber sobre | Lee |
| :--- | :--- |
| Por qué el diseño tiene esta forma | [`docs/architecture.md`](docs/architecture.md) |
| Cada clave de anotación, con tipos y valores por defecto | [`docs/annotations.md`](docs/annotations.md) |
| Mapeo de `.drawio`, reglas de enrutado, semántica de coordenadas | [`docs/drawio-format.md`](docs/drawio-format.md) |
| Rendimiento medido, tres implementaciones | [`docs/benchmark.md`](docs/benchmark.md) |
| Cómo se somete las tres implementaciones a una sola especificación | [`docs/conformance.md`](docs/conformance.md) |
| Compilar, probar, añadir un lenguaje | [`docs/contributing.md`](docs/contributing.md) |
| Implementar esta capacidad tú mismo | [`python/SKILL.md`](python/SKILL.md), [`typescript/SKILL.md`](typescript/SKILL.md), [`dotnet/SKILL.md`](dotnet/SKILL.md) |

## Desarrollo

```bash
cd python && python -m unittest discover -s tests -t .    # 144 tests
cd typescript && npm test
cd dotnet && dotnet test

pwsh bench/run.ps1                                        # three-language benchmark
```

Entorno medido: Windows 11 (10.0.22621), Python 3.14.6, Node 24.16.0, .NET SDK 10.0.203.

## Verificación medida

**Ningún número de este repositorio es una estimación.** Cada cifra de abajo se produjo ejecutando el comando de la 
misma columna.

| Afirmación | Cómo se midió | Resultado |
| :--- | :--- | :--- |
| La implementación de Python es correcta | `python -m unittest discover -s tests -t .` | **144 tests, 0 failures, 0 skipped** |
| El `.drawio` comprimido se lee correctamente | Releer un fichero dorado comprimido con draw.io | **nodes=6, edges=6, attrs=6** — idéntico a la forma plana |
| Una carga ilegible no falla en silencio | `read_layout('<mxfile><diagram>not-a-payload</diagram></mxfile>')` | lanza `ValueError` |
| El `.drawio` generado es válido según el esquema | XMLSchema de `lxml` contra `tools/xsd/mxfile.xsd` | **3/3 pasan** (C, C# y un diagrama con puntos intermedios) |
| Ida y vuelta idempotente | Compilar → sincronizar → compilar, comparar | **cero cambios en la segunda sincronización** |
| Coste del diseño | `bench/run.ps1`, 5/10/20/40/80 módulos | 0.36 s / 1.45 s / 5.89 s / 23.3 s / 95.4 s — **superlineal, véase abajo** |
| Coste del análisis, mismas ejecuciones | las mismas | 4.0 / 6.6 / 12.9 / 26.8 / 52.9 ms — lineal |
| Las tres implementaciones coinciden | `tests/golden/*/expected.{ir.json,drawio}` | véase [`docs/benchmark.md`](docs/benchmark.md) |

Las cifras de diseño son el resultado interesante: **el análisis escala linealmente mientras que el diseño es 
cuadrático.** Enrutar cada arista prueba rutas candidatas contra todos los demás nodos, así que un proyecto de 80 
módulos dedica 95 segundos al diseño y 53 milisegundos al análisis. Esto se declara como una característica, no se 
esconde como un error de redondeo — el documento del benchmark registra dónde se va realmente el tiempo.

## Limitaciones conocidas (enumeradas con honestidad)

- **El diseño es O(n²)**, así que los proyectos grandes son lentos. Todavía no se usa ningún índice espacial. Esto se 
  aplica por igual a las tres implementaciones.
- **El renderizador offline no puede dibujar los saltos de línea `jumpStyle=arc`.** `jumpStyle` es una extensión de 
  draw.io ausente del núcleo open source de mxGraph. Los ficheros generados lo configuran correctamente y el cliente 
  de draw.io lo respeta, pero `tools/render/` no mostrará los saltos. Verifica los saltos en draw.io.
- **Los títulos de los contenedores swimlane se renderizan centrados** en el renderizador offline, aunque en draw.io 
  aparecen arriba a la izquierda. Es una limitación del renderizador, no un fallo del generador.
- **La medición de texto CJK en el renderizador offline es estimada.** jsdom no tiene motor de maquetación e informa 
  `offsetWidth = 0`, así que los anchos de glifo se aproximan. El texto en sí se renderiza correctamente (el 
  posicionamiento SVG no depende de esa medición); la *evitación* de etiquetas puede desviarse.
- **La vista previa SVG no comparte el enrutado de aristas del `.drawio`.** Las posiciones de los nodos sí se 
  comparten (ambas llaman al mismo diseño por defecto), pero `svg.py` dibuja las aristas de centro a centro mientras 
  que `to_drawio` ejecuta la selección completa de anclas y la evitación de obstáculos. Por eso las aristas del SVG 
  cruzan formas de nodo que las rutas del `.drawio` rodean. Trata el SVG como una lectura estructural, no como una 
  vista previa fiel. Arreglarlo exige refactorizar `to_drawio` para exponer la geometría de las aristas como una 
  función compartida.
- **Los cuerpos de las funciones nunca se reescriben.** Restricción de diseño deliberada, no una carencia.
- **Los diagramas únicos con varios lenguajes no se resuelven por símbolo.** Los modelos de C y C# pueden fusionarse, 
  pero una referencia entre lenguajes al mismo nombre no se resuelve.
- **La multipágina / multívista, las capas y el filtrado por etiquetas no están conectados a la CLI.**
- **La igualdad geométrica entre implementaciones exige portar los mismos algoritmos.** Ese es el punto — pero 
  significa que una implementación «optimizada de otra forma» solo puede cambiar *lo rápido* que calcula, nunca *lo 
  que* calcula.

## Licencia

[MIT](LICENSE). El material de terceros incluido está listado en [`tools/xsd/README.md`](tools/xsd/README.md).

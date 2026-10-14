# Benchmark

**drawcode en tres lenguajes: el mismo algoritmo, la misma salida, constantes muy distintas.**

[English](benchmark.md) | [中文](benchmark.zh-CN.md) | **Español**

Las tres implementaciones producen una salida `.drawio` idéntica byte a byte (véanse
[`conformance.md`](conformance.md) y `docs/implementations.es.md`).
Esta página mide lo que cuesta ese trabajo idéntico en cada runtime.

## Qué se mide

La canalización completa `parse → IR → .drawio`, accionada a través del CLI
propio de cada implementación, **incluido el arranque del proceso** — porque eso es lo que un usuario
experimenta realmente cuando ejecuta `drawcode build`.

Las entradas generadas provienen de [`examples/large/generate.py`](../examples/large/generate.py)
con una semilla RNG fija, así que las ejecuciones son reproducibles.

```
powershell -ExecutionPolicy Bypass -File bench/run.ps1 -Sizes s,m,l,xl,xxl
```

| size | modules | files | signals | funcs | edges |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `s` | 5 | 10 | 50 | 30 | 144 |
| `m` | 10 | 20 | 100 | 60 | 294 |
| `l` | 20 | 40 | 200 | 120 | 594 |
| `xl` | 40 | 80 | 400 | 240 | 1 194 |

Existe un quinto preset, `xxl` (80 módulos), en `bench/run.ps1`, pero no se mide
aquí: una sola ejecución de Python tarda unos 95 s. Véase la extrapolación más abajo.

Nótese que **las aristas crecen linealmente** con el número de módulos mientras que **el tiempo crece
de forma cuadrática**. Esa es la firma del producto `edges × nodes`, y es
la evidencia más directa del modelo de coste.

## Resultados (mediana de 3, milisegundos)

Máquina: Windows 10 (build 22631), Intel Core i5-10200H, 8 núcleos lógicos. Cadena de herramientas: Python 3.14.6, Node v24.16.0, .NET 10.0.203.

| size | modules | python | typescript | dotnet |
| :--- | ---: | ---: | ---: | ---: |
| `s` | 5 | 464.8 | 174.8 | 152.8 |
| `m` | 10 | 1 603.6 | 208.5 | 177.5 |
| `l` | 20 | 5 966.7 | 325.9 | 255.1 |
| `xl` | 40 | 23 951.4 | 791.3 | 527.8 |

Las ejecuciones brutas se escriben en `bench/results/bench-<timestamp>.json`, cada una llevando la
descripción de la máquina y las versiones de la cadena de herramientas junto a las cifras.

## La forma de la curva

La canalización es **cuadrática en el número de nodos**, en todos los lenguajes. La
etapa de enrutado prueba cada ruta candidata de cada arista contra todos los demás nodos,
así que el coste crece con `edges × candidates × nodes`.

Ajustando `T(n) = C + k·n²` (n = módulos) a las mediciones de `s` y `xl`:

| implementation | startup constant `C` | quadratic coefficient `k` | `m` predicted / measured | `l` predicted / measured |
| :--- | ---: | ---: | :--- | :--- |
| python | 92.0 ms | **14.91** | 1 583 / 1 604 | 6 057 / 5 967 |
| typescript | 165.0 ms | **0.391** | 204 / 209 | 322 / 326 |
| dotnet | 146.9 ms | **0.238** | 171 / 178 | 242 / 255 |

Las predicciones caen dentro del 1–5% de la medición en los dos puntos interpolados,
y por eso la curva se lee como un `n²` limpio en lugar de "aproximadamente superlineal".

**Las tres implementaciones son algorítmicamente idénticas: solo difiere la constante.**
El coeficiente cuadrático de Python es **62.6×** el de .NET y **38.1×** el de
TypeScript.

Esa es toda la historia detrás de la brecha titular. No es un algoritmo más listo
en C# o TypeScript; son 2.5 millones de llamadas a función a nivel de intérprete por ejecución
siendo ejecutadas por un JIT en su lugar.

### Por qué TypeScript y .NET *parecen* planos en tamaños pequeños

Sus ratios de crecimiento (1.19×, 1.56×, 2.43× para TypeScript, con cada duplicación del
número de módulos) están muy por debajo del 4× que daría una cuadrática. Eso no es
comportamiento subcuadrático: son ~150 ms de arranque del proceso ahogando un
término cuadrático que a estos tamaños todavía es de solo decenas de milisegundos.

Extrapolando con el modelo ajustado se reproduce la tabla del README:

```
python @ 80 modules = 92.0 + 14.91 × 6400 ≈ 95 500 ms ≈ 95.4 s
```

## Adónde va el tiempo

`cProfile` sobre la implementación Python en `m` (10 módulos):

```
2 482 500 calls   drawio.py:131(_crosses)   3.37 s cumulative   (69%)
      294 calls   drawio.py:152(_route)     4.81 s cumulative
```

`_crosses` — la prueba de obstáculo segmento contra rectángulo — se llama 2.5 millones
de veces para lo que es un diagrama de 294 aristas. Esa única función es el punto caliente, y
es el único lugar donde una mejora algorítmica rentaría en los tres
lenguajes.

## Qué significa esto para las "versiones optimizadas"

Las tres implementaciones son deliberadamente **equivalentes a la referencia**, no
optimizadas de forma independiente: comparten la misma estrategia de enrutado, los mismos conjuntos
de anclas candidatas y las mismas constantes geométricas (orden de `ANCHOR_SETS`, `SHRINK=3`,
`SLACK=2`), que es lo que hace que su salida sea idéntica byte a byte.

Dos consecuencias:

1. **Las cifras de arriba miden tiempos de ejecución, no diseños.** Una optimización algorítmica
   genuina — indexación espacial para recortar el producto `edges × candidates × nodes`
   — tendría que aplicarse a las tres y volver a fijarse contra los
   casos dorados, porque puede cambiar qué ruta gana los empates.
2. **Python no se pondrá al día con microoptimización.** Una brecha de constante de 62.6× es
   una brecha de ejecución del lenguaje; cerrarla significa o bien reducir el trabajo (menos
   llamadas a `_crosses`) o bien sacar el bucle interno fuera del intérprete.

## Reproducir

```powershell
# all sizes, all languages, 3 repeats
powershell -ExecutionPolicy Bypass -File bench/run.ps1

# one size, one language, 5 repeats
powershell -ExecutionPolicy Bypass -File bench/run.ps1 -Sizes m -Langs dotnet -Repeat 5
```

Un lenguaje cuyo punto de entrada falte se reporta como `SKIP (not built)` en lugar
de omitirse en silencio.

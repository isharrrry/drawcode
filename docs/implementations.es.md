---
type: Guide
title: Implementaciones
description: Cómo compilar, probar e invocar cada una de las implementaciones Python, TypeScript y .NET, y cómo se las obliga a una salida idéntica
tags: [implementations, python, typescript, dotnet, conformance]
status: stable
---

# Implementaciones

[English](implementations.md) | [中文](implementations.zh-CN.md) | **Español**

[← Índice de documentación](index.es.md)

`drawcode` entrega la misma capacidad tres veces, una por lenguaje, de modo que la comparación de
rendimiento de [benchmark.md](benchmark.es.md) compara implementaciones y no ecosistemas.

| | Python | TypeScript | .NET |
| :--- | :--- | :--- | :--- |
| Directorio | [`python/`](../python/) | [`typescript/`](../typescript/) | [`dotnet/`](../dotnet/) |
| Requiere | Python 3.10+ | Node 22.6+ | .NET SDK 10 |
| Dependencias en tiempo de ejecución | **ninguna** (solo biblioteca estándar) | **ninguna** (sin `node_modules`) | **ninguna** (solo BCL) |
| Punto de entrada | `python -m drawcode.cli` | `node typescript/bin/drawcode.ts` | `dotnet dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll` |
| Pruebas | `python -m unittest discover -s tests -t .` | `node --test` | `dotnet test dotnet/DrawCode.slnx -c Release` |
| Número de pruebas | 145 | 210 | 120 |
| Guía por implementación | [`python/SKILL.md`](../python/SKILL.md) | [`typescript/SKILL.md`](../typescript/SKILL.md) | [`dotnet/SKILL.md`](../dotnet/SKILL.md) |

Todos los comandos de la tabla se ejecutan desde la raíz del repositorio. Cada directorio de
implementación tiene además un `README.md` y un `SKILL.md` con el recorrido del port.

## El contrato compartido

Las tres ofrecen las mismas dos operaciones:

```
build <files...> [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
                [--inline] [--cards] [--no-rw-labels] [--straight-edges]
sync  <drawio> <files...> [--root DIR] [--write]
```

| Operación | Hace |
| :--- | :--- |
| `build` | parsea fuentes → IR → escribe `.drawio`. `--layout-from` reutiliza la disposición hecha a mano de un diagrama existente; `--svg` emite además una vista previa. |
| `sync` | lee `.drawio` → aplica disposición y atributos de anotación → escribe únicamente la **capa de declaración**. Simulación salvo que se dé `--write`. |

Los cuatro interruptores de contenido/disposición se aceptan en las tres CLI con la misma semántica:
`--inline` pliega una señal escrita una vez y leída una vez en una arista directa entre dispositivos,
`--cards` dibuja las funciones con `asset` como tarjetas de imagen, `--no-rw-labels` elimina las
etiquetas `read`/`write` de las aristas, y `--straight-edges` sustituye el trazado ortogonal por
líneas rectas (los puntos de paso manuales y los anclajes de entrada/salida sobreviven; los codos
automáticos no). Sin esos interruptores la salida es idéntica byte a byte a la anterior, que es lo que
mantiene significativos los casos dorados compartidos.

## Python

Implementación de referencia. Solo biblioteca estándar, así que se ejecuta desde un checkout de código fuente sin instalar nada:

```bash
export PYTHONPATH=python/src          # Windows: $env:PYTHONPATH = "python/src"
python -m drawcode.cli build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow.drawio --svg out/flow.svg

cd python && python -m unittest discover -s tests -t .
```

Verificado: `pip install -e .` dentro de `python/` también expone un script de consola `drawcode`,
y `drawcode --help` lista ambos subcomandos.

## TypeScript

Vive en [`typescript/`](../typescript/).

**No hay paso de instalación ni `node_modules`.** Node 22.6 o posterior elimina por su cuenta las
anotaciones de tipo, así que el punto de entrada `.ts` se ejecuta directamente sin compilarse.

```bash
node typescript/bin/drawcode.ts build examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow-ts.drawio

cd typescript && node --test
```

`npm run typecheck` sí necesita un paquete `typescript` externo, que el repositorio
deliberadamente no incluye; no forma parte de la ruta de pruebas.

## .NET

Vive en [`dotnet/`](../dotnet/), como una solución `.slnx` dirigida a `net10.0`.

Compilar una vez y luego ejecutar el ensamblado que produce esa compilación:

```bash
dotnet build dotnet/DrawCode.slnx -c Release

dotnet dotnet/src/DrawCode/bin/Release/net10.0/DrawCode.dll build \
    examples/small/c/*.h examples/small/c/*.c \
    --root examples/small/c --out out/flow-net.drawio

dotnet test dotnet/DrawCode.slnx -c Release
```

Las dos implementaciones anteriores incluyen un `SKILL.md` que documenta las trampas propias de
Node y de .NET (semántica de expresiones regulares, serialización XML, sin `DOMParser`; `XDocument`
escribiendo una declaración XML que los ficheros dorados no tienen, `CultureInfo.InvariantCulture`
para formatear flotantes, y el deflate en crudo que requiere `DeflateStream`).

## Cómo se impone la identidad

Que tres implementaciones coincidan no es una impresión; es una prueba. Las tres se someten a
[`conformance.md`](conformance.md) y a los casos dorados de `tests/golden/`:

| Nivel | Se compara | Tolerancia |
| :--- | :--- | :--- |
| L1 — parseo (IR) | señales, funciones, parámetros, aristas, dispositivos, ficheros | exacta |
| L2 — estructura del grafo | contenedores, anidamiento, pertenencia de nodos, extremos de aristas | exacta |
| L3 — geometría | `x`/`y`/`w`/`h` de nodo, puntos de polilínea, anclas de arista | exacta |
| L4 — esquema | valida contra `tools/xsd/mxfile.xsd` | debe pasar |

**Las tres implementaciones reproducen los casos dorados `small-c` y `small-cs` byte a byte** —
SHA256 idéntico tanto para `expected.drawio` como para `expected.ir.json`. Eso es más estricto que
la comparación normalizada que exige la especificación: es acuerdo de geometría L3 hasta el último
dígito, no solo igualdad estructural.

**Un ejecutor de conformidad debe fallar ruidosamente cuando falta un fichero dorado, en lugar de saltárselo.**
Una prueba de conformidad saltada en silencio hace que una implementación sin verificar parezca verificada. Esto ocurrió
de hecho durante el propio desarrollo del proyecto: las pruebas de validación XSD resolvían el esquema desde un
repositorio hermano, así que tres pruebas se saltaban para cualquiera que no tuviera ese checkout. El esquema ahora está
incluido en [`tools/xsd/mxfile.xsd`](../tools/xsd/mxfile.xsd) y las tres pruebas se ejecutan.

## Por qué la salida idéntica importa más de lo que parece

El benchmark solo tiene sentido si las tres implementaciones hacen el **mismo trabajo**. Un enrutador más rápido
que dibujara aristas más bonitas daría mejores cifras y no demostraría nada.

Así que la restricción es explícita: **una optimización puede cambiar lo rápido que se calcula algo, nunca lo que
se calcula.** Un índice espacial que acelera las consultas de obstáculos es legítimo. Una heurística de enrutado
distinta no lo es: convertiría en silencio el benchmark en una comparación de tres programas
diferentes.

Esta es una limitación real sobre cómo pueden evolucionar las implementaciones, y se acepta deliberadamente.

## Relacionado

- [`conformance.md`](conformance.md) — la especificación completa de comparación
- [benchmark.md](benchmark.es.md) — cifras medidas
- [architecture.md](architecture.es.md) — por qué el diseño tiene esta forma

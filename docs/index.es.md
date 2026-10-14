# Documentación

[English](index.md) | [中文](index.zh-CN.md) | **Español**

> Documentación de [drawcode](../README.es.md) — una herramienta bidireccional código ↔ diagrama de flujo de datos, donde el código fuente es la única fuente de verdad.

Todos los temas siguientes existen en los tres idiomas. La versión inglesa se escribe primero y completa;
las otras dos son traducciones fieles, no resúmenes. Las tres se actualizan en el mismo cambio.

## Temas

| Tema | Versiones de idioma | Qué cubre |
| :--- | :--- | :--- |
| **Arquitectura** | [English](architecture.md) · [中文](architecture.zh-CN.md) · [Español](architecture.es.md) | Las capas, qué posee cada módulo, los dos flujos de datos (build y sync) y el razonamiento tras negarse a persistir una representación intermedia |
| **Anotaciones** | [English](annotations.md) · [中文](annotations.zh-CN.md) · [Español](annotations.es.md) | Referencia a nivel de campo de cada clave de anotación: comentarios `@drawcode` y `@device` (C), atributos `[Drawcode]` y `[Device]` (C#) — con tipos, valores por defecto y ejemplos |
| **Formato `.drawio`** | [English](drawio-format.md) · [中文](drawio-format.zh-CN.md) · [Español](drawio-format.es.md) | Mapeo de elementos, semántica de coordenadas, reglas de anclas y enrutado, y la forma de almacenamiento comprimido de draw.io |
| **Benchmark** | [English](benchmark.md) · [中文](benchmark.zh-CN.md) · [Español](benchmark.es.md) | Rendimiento medido en las tres implementaciones, con las cifras brutas y adónde va realmente el tiempo |
| **Implementaciones** | [English](implementations.md) · [中文](implementations.zh-CN.md) · [Español](implementations.es.md) | Cómo compilar, probar e invocar cada una de las versiones Python, TypeScript y .NET |
| **Contribuir** | [English](contributing.md) · [中文](contributing.zh-CN.md) · [Español](contributing.es.md) | Entorno, ejecutar pruebas, añadir casos dorados, añadir un lenguaje fuente y lo que está deliberadamente sin verificar |

## Por dónde empezar

| Quieres… | Ve a |
| :--- | :--- |
| Entender por qué el diseño tiene esta forma | [Arquitectura](architecture.es.md) |
| Anotar tu propio código por primera vez | [Anotaciones](annotations.es.md) → luego [Inicio rápido](../README.es.md#inicio-rápido) |
| Añadir un lenguaje fuente nuevo (Rust, Go, …) | [Arquitectura](architecture.es.md#capas-de-módulos) → [Contribuir](contributing.es.md) |
| Implementar tú mismo toda la capacidad | [`python/SKILL.md`](../python/SKILL.md), [`typescript/SKILL.md`](../typescript/SKILL.md), [`dotnet/SKILL.md`](../dotnet/SKILL.md) |
| Saber cómo se mantienen idénticas las tres versiones | [`conformance.md`](conformance.md) |
| Ver las cifras medidas | [Benchmark](benchmark.es.md) |
| Diagnosticar un diagrama que perdió su disposición | [Formato `.drawio`](drawio-format.es.md#almacenamiento-comprimido) |
| Renderizar un `.drawio` a imagen sin tener draw.io instalado | [`tools/render/`](../tools/render/README.md) |

## Sobre estos documentos

1. **Cada cifra proviene de un comando que se ejecutó de verdad.** Nada está estimado. Cuando una
   cifra no se ha medido, el documento lo dice y remite a las
   [Limitaciones conocidas](../README.es.md#limitaciones-conocidas-enumeradas-con-honestidad) en lugar de rellenar el hueco.
2. **Cambiar código significa cambiar los tres idiomas de estos documentos en el mismo commit.** Un
   comportamiento documentado que solo existe en una versión de idioma es un fallo, no un retraso de traducción.
3. **El comportamiento sin verificar y el sabidamente roto se declara de forma explícita.** Dos ejemplos que merecen mención:
   la vista previa SVG no comparte el enrutado de aristas del `.drawio`, y el renderizador offline no puede dibujar
   los saltos de línea `jumpStyle`. Ambos están escritos donde el lector los encontrará, no enterrados.

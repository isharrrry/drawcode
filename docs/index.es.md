# Documentación

[English](index.md) | [中文](index.zh-CN.md) | **Español**

> Documentación de [drawcode](../README.es.md) — una herramienta bidireccional código ↔ diagrama de flujo de datos, donde el código fuente es la única fuente de verdad.

La versión inglesa se escribe primero y completa; la traducción china se mantiene al día. Las
páginas en español anteriores a la consolidación de 2026-10 están marcadas como obsoletas y remiten
a la versión inglesa.

## Temas

| Tema | Versiones de idioma | Qué cubre |
| :--- | :--- | :--- |
| **Arquitectura** | [English](architecture.md) · [中文](architecture.zh-CN.md) · [Español](architecture.es.md) | Las capas, qué posee cada módulo, los dos flujos de datos (build y sync) y el razonamiento tras negarse a persistir una representación intermedia |
| **Anotaciones** | [English](annotations.md) · [中文](annotations.zh-CN.md) · [Español](annotations.es.md) | Referencia a nivel de campo de cada clave de anotación: comentarios `@drawcode` y `@device` (C), atributos `[Drawcode]`, `[Device]` y `[Callout]` (C#) — con tipos, valores por defecto y ejemplos |
| **Formato `.drawio`** | [English](drawio-format.md) · [中文](drawio-format.zh-CN.md) · [Español](drawio-format.es.md) | Mapeo de elementos, semántica de coordenadas, reglas de anclas y enrutado, y la forma de almacenamiento comprimido de draw.io |
| **Implementación** | [English](implementations.md) · [中文](implementations.zh-CN.md) · [Español](implementations.es.md) | Cómo compilar, probar e invocar la implementación TypeScript, y qué fijan los casos dorados |
| **Formato de artefactos** | [English](artifact-format.md) *(sin traducción todavía)* | El `ArtifactModel` que emite `inspect`: binarios admitidos, ids estables, diagnósticos, JSON canónico y por qué esta vía está separada del IR de código fuente |
| **Contribuir** | [English](contributing.md) · [中文](contributing.zh-CN.md) · [Español](contributing.es.md) | Entorno, ejecutar pruebas, añadir casos dorados, añadir un lenguaje fuente y lo que está deliberadamente sin verificar |

## Por dónde empezar

| Quieres… | Ve a |
| :--- | :--- |
| Entender por qué el diseño tiene esta forma | [Arquitectura](architecture.es.md) |
| Anotar tu propio código por primera vez | [Anotaciones](annotations.es.md) → luego [Inicio rápido](../README.es.md#inicio-rápido) |
| Añadir un lenguaje fuente nuevo (Rust, Go, …) | [Arquitectura](architecture.es.md#capas-de-módulos) → [Contribuir](contributing.es.md) |
| Implementar tú mismo toda la capacidad | [`typescript/SKILL.md`](../typescript/SKILL.md) |
| Saber qué compara la suite de conformidad | [`conformance.md`](conformance.md) |
| Diagnosticar un diagrama que perdió su disposición | [Formato `.drawio`](drawio-format.es.md#almacenamiento-comprimido) |
| Renderizar un `.drawio` a imagen sin tener draw.io instalado | [Contributing § Offline rendering](contributing.md#offline-rendering) |

## Sobre estos documentos

1. **Cada cifra proviene de un comando que se ejecutó de verdad.** Nada está estimado. Cuando una
   cifra no se ha medido, el documento lo dice y remite a las
   [Limitaciones conocidas](../README.es.md#limitaciones-conocidas-enumeradas-con-honestidad) en lugar de rellenar el hueco.
2. **Cambiar el comportamiento significa actualizar la versión inglesa y la traducción china en el
   mismo cambio.** Un comportamiento documentado que solo existe en una versión de idioma es un
   fallo, no un retraso de traducción.
3. **El comportamiento sin verificar y el sabidamente roto se declara de forma explícita.** Dos ejemplos que merecen mención:
   la vista previa SVG no comparte el enrutado de aristas del `.drawio`, y el renderizador offline no puede dibujar
   los saltos de línea `jumpStyle`. Ambos están escritos donde el lector los encontrará, no enterrados.

---
type: Guide
title: Anotaciones
description: Referencia a nivel de campo de cada clave de anotación — los bloques de comentario @drawcode y @device de C, y los atributos Drawcode y Device de C#
tags: [annotations, parsing, attributes, comments, reference]
status: stable
---

# Anotaciones

[English](annotations.md) | [中文](annotations.zh-CN.md) | **Español**

[← Índice de documentación](index.es.md)

Las anotaciones llevan las dos cosas que un analizador no puede inferir del código fuente: la **dirección** (¿esta señal es una entrada o una salida?) y los **metadatos para personas** (¿cómo la llama un humano?). Todo lo demás — qué funciones leen qué señales, qué señales se escriben — se deriva del propio código.

> **Las anotaciones nunca deciden si una arista existe.** Una arista existe porque el cuerpo de una función lee o escribe una señal. Editar un comentario cambia una etiqueta; nunca añade, elimina ni mueve una línea. Véase [Por qué las anotaciones no controlan las aristas](#por-qué-las-anotaciones-no-controlan-las-aristas).

## Dirección en C: la clave `dir`

La dirección es una clave del comentario `@drawcode` situado justo encima de la declaración. **Solo una variable de nivel superior anotada es una señal** — una declaración sin anotar nunca lo es, se escriba como se escriba.

| Valor de `dir` | `dir` en el IR | Aspecto en el diagrama |
| :--- | :--- | :--- |
| `dir=in` | `in` | pentágono apuntando a la derecha, etiqueta `type / in / unit` |
| `dir=out` | `out` | pentágono apuntando a la izquierda, etiqueta `type / out / unit` |
| `dir=io` | `inout` | elipse, etiqueta `type / inout / unit` |
| ausente | `""` | elipse, sin dirección en su etiqueta |

```c
/// @drawcode dir=in unit="LSB" alias="原始采样值" note="上电后需校准"
int16_t g_raw;
```

### Sin encabezado y sin macros

Las versiones anteriores de drawcode requerían un encabezado `drawcode_signals.h` y las macros `SIGNAL_IN` / `SIGNAL_OUT` / `SIGNAL_IO`. **Ambos han desaparecido.** La dirección vive ahora en el comentario, así que no hay nada que incluir ni nada que enlazar — la anotación se lee del texto fuente y nunca de un artefacto compilado.

### Restricciones sintácticas

La declaración se reconoce con una expresión regular orientada a líneas, una declaración por línea:

```
(?P<ctype>.+?)\s*(?P<name>[A-Za-z_]\w*)(\[[^\]]*\])?\s*;
```

- **Una declaración por línea, terminada en `;`.** El punto y coma final forma parte de la coincidencia; una declaración repartida en varias líneas no se reconoce.
- **La declaración debe llevar `@drawcode`.** Un bloque de comentario sin anotación, o una anotación sobre una construcción que no es una variable de nivel superior, no produce ninguna señal.
- **Los declaradores de array se pliegan en el tipo.** `float g_coeff[32];` produce `name = g_coeff` y `ctype = float[32]`; el sufijo se vuelve a pegar al tipo, de modo que la etiqueta dice `float[32] / in / coeff`.
- **Las señales aceptan `dir`, `unit`, `alias`, `note` y `external`.** Las claves de geometría pertenecen a las funciones — véanse las tablas de claves más abajo.

## Dirección en C#: el atributo `[Drawcode]`

C# no tiene aquí una convención de claves en comentarios, así que **todo** lo que una señal de C dice en un comentario lo dice aquí un solo atributo. La dirección es su primer argumento, posicional.

```csharp
[Drawcode(Direction.In, Unit = "LSB", Alias = "原始采样值", Note = "上电后需校准")]
public static short g_raw;
```

| Valor del atributo | `dir` en el IR |
| :--- | :--- |
| `[Drawcode(Direction.In)]` | `in` |
| `[Drawcode(Direction.Out)]` | `out` |
| `[Drawcode(Direction.Io)]` | `inout` |
| `[Drawcode]` / `[Drawcode(Direction.None)]` | `""` |

El atributo se vincula a la **siguiente declaración de campo, propiedad o método** que le sigue, ignorando líneas en blanco, `using`, `namespace`, las que empiezan por `#` y las llaves sueltas. El argumento posicional puede omitirse (`[Drawcode(Alias = "…")]`), en cuyo caso el miembro queda documentado pero sin dirección. `DrawcodeAttribute`, `DeviceAttribute` y `Direction` deben existir en tu proyecto — copia [`examples/small/cs/DrawcodeAttributes.cs`](../examples/small/cs/DrawcodeAttributes.cs) una vez.

## Sintaxis de anotaciones

### C: claves en comentarios

```c
/// @drawcode unit="LSB" alias="原始采样值" note="上电后需校准"
int16_t g_raw;
```

Se reconocen dos etiquetas, ambas al principio de una línea `///` tras espacios iniciales opcionales:

| Etiqueta | Transporta | Claves |
| :--- | :--- | :--- |
| `@drawcode` | los metadatos de la propia entidad | véanse las dos tablas de claves de abajo |
| `@device` | datos maestros de dispositivo para una **función** | `vendor` `model` `spec` `size` `asset` |

### C#: atributos

```csharp
[Drawcode(Alias = "ADC 采样", Tooltip = "上电后需先校准")]
[Device(Vendor = "TI", Model = "ADS1115", Spec = "16bit/860SPS", Size = "2.0x3.0mm", Asset = "assets/ads1115.svg")]
public static short AdcRead()
```

Los mismos dos conceptos, expresados como atributos. `[Device]` sustituye al antiguo comentario `/// <device />`, así que ya no es un comentario de documentación y ya no llega a la salida de documentación XML.

### Cómo se leen las claves

En C, las líneas `///` consecutivas se acumulan y se **vacían** al alcanzar una línea que no es `///` ni está en blanco; una línea en blanco limpia el búfer, así que el bloque debe estar justo encima de lo que anota. En C#, el atributo se vincula hacia adelante a la siguiente declaración, ignorando líneas en blanco, `using`, `namespace`, las que empiezan por `#` y las llaves sueltas.

Los pares clave/valor en C se leen con `(\w+)\s*=\s*"([^"]*)"`: **las claves son palabras simples, los valores van entre comillas dobles y un valor no puede contener comillas dobles.** En C# las claves son propiedades con nombre del atributo. Las claves desconocidas se ignoran en silencio en lugar de provocar un error, lo que mantiene las anotaciones compatibles hacia adelante entre implementaciones.
## Referencia de claves: señales

Se aplica a las variables de nivel superior con `@drawcode` en C y a los campos y propiedades con `[Drawcode]` en C#. Las cinco claves se comportan igual en ambos lenguajes; `dir` se documenta arriba.

| Clave | Tipo | Valor por defecto | Efecto | Ejemplo |
| :--- | :--- | :--- | :--- | :--- |
| `unit` | cadena | `""` | Tercer elemento de la etiqueta del nodo, después de `ctype / dir`. Puramente descriptivo; no se hace aritmética con él. | `unit="LSB"` |
| `alias` | cadena | `""` | Nombre humano usado como **atributo personalizado** del nodo (no en la etiqueta). La etiqueta siempre muestra el identificador de C. | `alias="原始采样值"` |
| `note` | cadena | `""` | Comentario de texto libre, escrito en los atributos personalizados del `<object>`. No se renderiza en la etiqueta. | `note="上电后需校准"` |
| `external` | `"true"` / ausente | `false` | Marca la señal como procedente de fuera del conjunto de módulos. Se analiza como la cadena `"true"`; cualquier otro valor, incluido `"True"`, la deja en `false`. | `external="true"` |

La etiqueta se ensambla con `name` en la primera línea y `ctype / dir / unit` en la segunda, omitiendo las partes vacías — así que una señal sin `unit` dice `int16_t / in`, no `int16_t / in / `.

## Referencia de claves: funciones

Se aplica a las declaraciones de función en C y a los métodos en C#.

| Clave | Tipo | Valor por defecto | Efecto | Ejemplo |
| :--- | :--- | :--- | :--- | :--- |
| `alias` | cadena | `""` | Se usa como **línea de título** del nodo en lugar del nombre de la función (`ADC 采样()` en vez de `adc_read()`). El nombre real sigue apareciendo en la segunda línea. | `alias="ADC 采样"` |
| `note` | cadena | `""` | Comentario de texto libre, escrito en los atributos personalizados del `<object>`. | `note="上电后需先校准"` |
| `tooltip` | cadena | `""` | Texto emergente, escrito en los atributos personalizados del `<object>`. | `tooltip="上电后需先校准"` |
| `asset` | cadena | `""` | Ruta de una imagen para el nodo, escrita en los atributos personalizados del `<object>`. **La ruta se registra, no se resuelve** — no se lee ningún fichero y un destino inexistente no es un error. | `asset="assets/ads1115.svg"` |
| `external` | `"true"` / ausente | `false` | Cambia el estilo del nodo a la forma externa discontinua. | `external="true"` |
| `xy` | `"x,y"` | sin definir | Posición inicial del nodo en el lienzo, en coordenadas absolutas del lienzo. Anula el apilado por defecto para este nodo. | `xy="420,160"` |
| `size` | `"WxH"` | `180x72` | Tamaño inicial del nodo. El separador es una `x` minúscula; el valor se pasa a minúsculas antes de dividirlo, así que `180X72` también sirve. | `size="180x72"` |

**La geometría de nodo es exclusiva de C: tanto `xy` como el `size` de nodo se leen en un solo lado.** `csparse.py` nunca llama a `meta.get("xy")` ni a `meta.get("size")`, así que un método de C# siempre se coloca y se dimensiona con el algoritmo por defecto. No lo confundas con la clave `size` de `@device` / `[Device]`, que es el tamaño físico del encapsulado y **sí** se lee en ambos lados — son claves distintas que casualmente comparten nombre. Es una asimetría real entre los dos frontales, no un descuido de este documento.

## Referencia de claves: dispositivos

`@device` (C) / `[Device]` (C#) asocia datos maestros de dispositivo a una **función** — el caso habitual es un punto de entrada de driver que habla con un chip. Se guarda en `Model.devices`, con el id de la función como clave.

| Clave | Tipo | Valor por defecto | Efecto | Ejemplo |
| :--- | :--- | :--- | :--- | :--- |
| `vendor` | cadena | `""` | Se escribe en los atributos personalizados del `<object>` del nodo. | `vendor="TI"` |
| `model` | cadena | `""` | Igual. | `model="ADS1115"` |
| `spec` | cadena | `""` | Igual. | `spec="16bit/860SPS"` |
| `size` | cadena | `""` | Igual — y véase la advertencia de abajo. | `size="2.0x3.0mm"` |
| `asset` | cadena | `""` | Igual. **También se copia al campo `asset` de la propia función si este sigue vacío**, de modo que la imagen del dispositivo se declara una sola vez. | `asset="assets/ads1115.svg"` |

### Las dos claves llamadas `size` no tienen relación

`@drawcode size="180x72"` y `@device size="2.0x3.0mm"` comparten un nombre y nada más.

| | `@drawcode size` | `@device size` |
| :--- | :--- | :--- |
| Significado | **geometría** del nodo en unidades del lienzo | una **cadena descriptiva** sobre la pieza física |
| Se analiza como | dos flotantes, divididos por la `x` minúscula | una cadena opaca, almacenada tal cual |
| Se guarda en | `Func.w` / `Func.h` | `Device.size` |
| Llega al diagrama como | `width` / `height` de `mxGeometry` | un atributo personalizado del `<object>` |
| Un valor erróneo provoca | una excepción en `float()` — este es el único punto donde una anotación mal formada es fatal | nada; se acepta cualquier cadena |

Como ambas se escriben con la misma sintaxis `k="v"` y ambas aparecen en el mismo bloque de comentario, este es el error de anotación más frecuente. La distinción está en bajo qué etiqueta se encuentra la clave.

## Dónde acaba cada clave

Cada clave de anotación acaba en exactamente uno de tres sitios. Saber cuál explica la mayoría de los informes del tipo «cambié la anotación y no pasó nada».

| Destino | Claves | Visible en el diagrama como |
| :--- | :--- | :--- |
| **texto de la etiqueta** del nodo | `unit` (señales), `alias` (funciones) | caracteres renderizados dentro de la forma |
| **atributos personalizados** del `<object>` | `alias` `note` (señales); `ret` `alias` `note` `tooltip` `asset` (funciones); las cinco claves de dispositivo | atributos del elemento, visibles en el diálogo Edit Data de draw.io |
| **geometría** | `xy`, `size` de `@drawcode`, y la posición de las funciones anotadas con `@device` | coordenadas del nodo |

El `alias` de una señal deliberadamente *no* está en la etiqueta: dos señales pueden compartir alias humano sin volverse indistinguibles en el lienzo. Nótese que `read_layout` vuelve a leer `alias`, `unit`, `note`, `tooltip` y `dir` desde los atributos del `<object>`, así que esas cinco son reversibles a través de un diagrama editado a mano; las claves de dispositivo más recientes se escriben pero no se releen por esta ruta.

## Por qué las anotaciones no controlan las aristas

`rebuild_edges()` es el único productor de aristas, y nunca mira un comentario:

```
for f in funcs:
    for sid in f.reads:  edges.append(Edge(sid, f.id, "read"))
    for sid in f.writes: edges.append(Edge(f.id, sid, "write"))
```

`f.reads` y `f.writes` vienen de `_def_use()`, que examina el **texto del cuerpo de la función** tras eliminar los comentarios:

- las sentencias se dividen por `;`, `{` y `}`;
- una asignación compuesta (`+=`, `<<=`, …) marca el lado izquierdo como leído y escrito, y el derecho como leído;
- un `=` simple marca el lado izquierdo como escrito y el derecho como leído;
- cualquier otra cosa en la sentencia cuenta como lectura;
- cada identificador encontrado se filtra después contra el conjunto de nombres de señal declarados — los nombres que no son señales (locales, parámetros, llamadas a bibliotecas) se descartan.

De ahí se siguen dos consecuencias, y ambas sorprenden a la gente:

1. **Un comentario nunca puede crear ni eliminar una arista.** `alias` son metadatos, `unit` son metadatos; no existe una anotación del tipo «esta función lee `g_raw`», porque el cuerpo ya lo dice.
2. **La dirección de la flecha sigue a la lectura/escritura, no a la anotación.** Una arista `read` va de *señal → función*; una arista `write` va de *función → señal*. Anotar una señal como `dir=out` no convierte sus aristas de lectura en escritura.

Cambiar `g_raw` de `dir=in` a `dir=out` cambia el texto de la etiqueta y el atributo `dir` del nodo. No mueve ni una sola línea. Si quieres que una arista desaparezca, borra la sentencia que lee o escribe la señal.

## Lo que el analizador infiere sin anotaciones

Estas reglas no necesitan anotación porque se deducen de la estructura del código.

| Regla | Consecuencia en el diagrama |
| :--- | :--- |
| **Los parámetros son puertos, no nodos.** Se analizan como `Param(name, ctype)` y se asocian a la función. | `void dsp_set_gain(uint8_t gain)` produce un nodo de función. No hay elipse `gain` ni arista hacia ella. |
| **Las variables locales quedan fuera.** Solo sobreviven al filtro de `_def_use` los identificadores que resuelven a una señal declarada. | `int16_t v` dentro de `adc_read()` es invisible. |
| **Un nodo por declaración.** El analizador arrastra la cadena de tipo declarada como `ctype` y nunca recorre los miembros de un tipo. | Una señal de tipo estructura es una sola elipse etiquetada con el tipo de la estructura; nunca se expande a un nodo por campo. |
| **Las funciones se reconocen por su forma, no por la anotación.** Una línea que encaja con el patrón de función y no es una de las palabras clave de control de C (`if`, `for`, `while`, `switch`, `return`, `sizeof`, …) se convierte en función. | Una función sin anotar igualmente obtiene un nodo — simplemente no tiene alias, así que el nodo se titula con su nombre real. |
| **Las declaraciones del encabezado ganan a las definiciones.** Cuando un nombre aparece tanto en un `.h` como en un `.c`, se prefieren las claves del encabezado. | Anota en el encabezado, como hacen los ejemplos. |
| **El contenedor es el fichero.** El `group` de cada entidad es el nombre base del fichero fuente. | Las entidades de `adc.h` caen en un contenedor llamado `adc`. |
| **La fusión multilingüe es concatenación, no resolución de símbolos.** | Las entradas de C y C# producen un IR fusionado, pero una referencia entre lenguajes al mismo nombre no se enlaza. |

## Reescritura

`sync` reescribe la capa de declaración y nada más. Para cada entidad renderiza el bloque de anotación desde el IR y sustituye el span existente, dejando intacto cada otro byte del fichero.

| Campo | Se reescribe como |
| :--- | :--- |
| señal `unit` `alias` `note` `external` | `/// @drawcode …` (C) o `[Drawcode(…)]` (C#) |
| señal `dir` | la clave `dir=in` / `dir=out` / `dir=io` (C), o el argumento posicional `Direction.X` (C#) |
| función `alias` `note` `tooltip` `external` | `/// @drawcode …` (C) o `[Drawcode(…)]` (C#) |
| claves de dispositivo | `/// @device …` (C) o `[Device(…)]` (C#) |
| **cuerpo** de la función | **nunca** — esta es la restricción de diseño, no una carencia |

Las claves que `drawcode` no gestiona — en particular un `xy` o un `size` escritos a mano en una función — se **conservan en su sitio**, en su orden original, cuando se reescribe la línea de anotación. Añadir una nota a una función anotada no descartará sus coordenadas en silencio.

## Relacionado

- [architecture.md](architecture.md) — capas, flujos de datos y por qué el IR nunca se persiste
- [drawio-format.md](drawio-format.md) — cómo las entidades anotadas se convierten en elementos `.drawio`
- [`examples/small/cs/DrawcodeAttributes.cs`](../examples/small/cs/DrawcodeAttributes.cs) — las definiciones de atributos de C#, listas para copiar
- [`examples/small/c/adc.h`](../examples/small/c/adc.h) y [`examples/small/cs/Adc.cs`](../examples/small/cs/Adc.cs) — todas las claves usadas en un solo sitio

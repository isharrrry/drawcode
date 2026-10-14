---
type: Guide
title: El formato .drawio
description: Mapeo de elementos, semántica de coordenadas, reglas de enrutado y la forma de almacenamiento comprimida de draw.io — el contrato completo entre drawcode y el fichero de diagrama
tags: [drawio, format, xml, coordinates, compression]
status: stable
---

# El formato `.drawio`

[English](drawio-format.md) | [中文](drawio-format.zh-CN.md) | **Español**

[← Índice de documentación](index.es.md)

El fichero `.drawio` es el único artefacto que `drawcode` escribe además del código fuente, y desempeña dos papeles a la vez: es una **vista derivada** del IR y es el **único portador del diseño** — lo único en este sistema que no puede regenerarse a partir del código. Cada regla de abajo existe por uno de esos dos papeles.

## Esqueleto de un fichero generado

```xml
<mxfile host="app.diagrams.net" agent="drawcode" type="device">
  <diagram id="drawcode" name="dataflow">
    <mxGraphModel dx="1200" dy="800" ... >
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <!-- containers, then nodes, then edges -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

`mxCell id="0"` es la raíz del grafo e `id="1"` su capa por defecto; ambos los exige el esquema y ninguno lleva datos. Todo lo demás cuelga de `id="1"`.

## Mapeo de elementos

| Concepto del IR | Forma XML | Padre | Notas |
| :--- | :--- | :--- | :--- |
| contenedor (`group`) | `<mxCell vertex="1">` con estilo `swimlane` | `1` | `value` es el nombre del grupo; la geometría es **absoluta** |
| señal / función | `<object>` envolviendo un `<mxCell vertex="1">` | la celda del contenedor | la geometría es **relativa al contenedor** |
| arista | `<object>` envolviendo un `<mxCell edge="1">` | el contenedor si origen y destino comparten uno, si no `1` | la geometría es relativa a lo que sea el padre |

### Los nodos llevan datos como atributos `<object>`

Un `<mxCell>` desnudo no tiene dónde poner propiedades personalizadas, así que cada nodo y cada arista se envuelven en un elemento `<object>` que transporta la carga semántica:

```xml
<object id="n3" label="g_raw&lt;br&gt;int16_t / in / LSB" symbolId="adc.h::g_raw"
        kind="signal" ctype="int16_t" dir="in" unit="LSB"
        alias="原始采样值" note="上电后需校准">
  <mxCell style="shape=path;path=0,0 115,0 160,30 115,60 0,60;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;"
          vertex="1" parent="grp1">
    <mxGeometry x="30" y="202" width="160" height="60" as="geometry" />
  </mxCell>
</object>
```

| Atributo | Significado | ¿Se relee? |
| :--- | :--- | :--- |
| `symbolId` | el id del IR, `"<fichero>::<nombre>"` — la clave de unión entre diagrama y código | sí, como clave del mapa |
| `kind` | `signal` o `func`, selecciona el estilo y la forma de la etiqueta | no |
| `label` | el texto renderizado; `&lt;br&gt;` es el salto de línea | no |
| `ctype` `dir` `unit` | la semántica de la señal reflejada en atributos | `dir` sí, los demás no |
| `alias` `note` `tooltip` | valores de anotación | sí |
| `ret` `asset` | tipo de retorno de la función y ruta de la imagen | no |
| `vendor` `model` `spec` `size` | datos de dispositivo, solo presentes si se usó `@device` / `[Device]` | no |

`read_layout` relee exactamente cinco campos escribibles — `alias`, `unit`, `note`, `tooltip` y `dir` — porque esos son los campos que se espera que un humano edite dentro de draw.io. Todo lo demás se escribe para mostrarlo y se ignora al leer.

### Los estilos de nodo son cinco constantes

| Constante | Se aplica a | Cadena de estilo |
| :--- | :--- | :--- |
| `SIGNAL_IN_STYLE` | señales `dir=in` | `shape=path;path=0,0 115,0 160,30 115,60 0,60;…` — pentágono a la derecha |
| `SIGNAL_OUT_STYLE` | señales `dir=out` | `shape=path;path=45,0 160,0 160,60 45,60 0,30;…` — pentágono a la izquierda |
| `SIGNAL_STYLE` | señales `dir=io` o sin dirección | `shape=ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;` |
| `FUNC_STYLE` | funciones | `rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;` |
| `FUNC_EXT_STYLE` | funciones con `external="true"` | igual que la anterior más `dashed=1`, con relleno y borde grises |

Los pentágonos llevan la dirección del flujo en la propia forma, así que no se dibuja ninguna
marca encima del nodo. Sus vértices caen exactamente en los puntos medios de los bordes
izquierdo y derecho — los mismos que prefiere `ANCHOR_SETS` — y por eso las líneas muerden el
vértice en lugar del lado plano. `_conn_side` lo fija: una señal `in` siempre conecta por su
**derecha** y una `out` por su **izquierda**, sea cual sea el extremo de la arista.

El estilo del contenedor se construye desde `CONT_STYLE` con `startSize=30`: la banda del título del swimlane mide 30 unidades de alto, y `_container_box` reserva exactamente esa altura extra por encima del miembro más alto.

## Semántica de coordenadas

> **Las coordenadas de `mxGeometry` y `mxPoint` son relativas a la celda padre, no al lienzo.** Un nodo dentro de un contenedor guarda su desplazamiento respecto a la esquina superior izquierda de ese contenedor. El contenedor guarda su propia posición en el lienzo porque su padre es la capa.

Dos funciones convierten entre los dos espacios, y la conversión debe ser exactamente inversa o las posiciones derivan un poco en cada ida y vuelta:

| Dirección | Función | Operación |
| :--- | :--- | :--- |
| IR → XML | `to_drawio` | resta el origen del contenedor: `x - ox`, `y - oy` |
| XML → IR | `read_layout` | llama a `_origin(cells, parent)` y **suma** los desplazamientos acumulados |

### `_origin` es el único punto de conversión a la entrada

```python
def _origin(cells, cid):
    x = y = 0.0
    while cid and cid not in ("0", "1") and cid in cells and cid not in seen:
        geom = cells[cid]["cell"].find("mxGeometry")
        if geom is not None:
            x += float(geom.get("x") or 0)
            y += float(geom.get("y") or 0)
        cid = cells[cid]["parent"]
    return x, y
```

Recorre la cadena de `parent` desde una celda hasta la capa, sumando el `x`/`y` de cada ancestro. El conjunto `seen` protege contra un fichero mal formado cuyos enlaces de padre formen un ciclo — sin él, un diagrama roto a mano colgaría al lector en lugar de fallar.

Este es el único sitio donde se aplana la profundidad de anidamiento. Cualquier comparación de coordenadas entre diagramas de distinta profundidad debe hacerse **después** de esta conversión; comparar valores en crudo reporta una deriva fantasma. Véanse las [Reglas de normalización](#reglas-de-normalización).

Los puntos intermedios de las aristas reciben el mismo trato: `to_drawio` escribe `px - ox`, `py - oy` donde `(ox, oy)` es el origen del padre de la propia arista — que para una arista entre contenedores es `(0, 0)`, porque esa arista tiene como padre la capa y por tanto ya está en el espacio del lienzo.

## Contenedores y anidamiento

Se crea un contenedor por **fichero fuente**, no por directorio. El `group` de cada entidad es el nombre base del fichero (`adc.h` y `adc.c` producen ambos `adc`), así que un encabezado y su implementación comparten un contenedor.

| Paso | Regla |
| :--- | :--- |
| id del contenedor | `grp1`, `grp2`, … asignados en **orden alfabético de grupo**, así que los ids son estables entre ejecuciones |
| límites del contenedor | `_container_box`: `min(x) - 30`, `min(y) - 60`, ancho `max(x2) - min(x) + 60`, alto `max(y2) - min(y) + 60 + 30` |
| evitación horizontal | los grupos se colocan en orden alfabético; si la caja de un grupo empezara a la izquierda del borde derecho del grupo anterior más `4 * 30`, el grupo entero se desplaza a la derecha |
| padre de la arista | `parent = grpN` cuando origen y destino comparten grupo, si no `parent = "1"` |

El margen `PAD = 30` y la banda de título `HEADER = 30` son lo que aportan esas constantes: 30 por cada lado, más otros 30 de espacio reservado por encima del miembro más alto para el título del swimlane.

**Sobre «el contenedor común más interno».** La especificación describe así el parentesco de las aristas, y es aquí donde aterriza: como los contenedores tienen actualmente un solo nivel, el contenedor más interno que comparten dos entidades es su propio grupo cuando los grupos coinciden, y la capa raíz cuando no. La profundidad es una propiedad del modelo de contenedores, no de la regla de parentesco.

## Representación de las aristas

Las aristas son la parte del fichero con más invariantes, porque son la parte que draw.io enrutaría por su cuenta si no se le impidiera.

### Estilo base

```
edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;jumpStyle=arc;jumpSize=6;
```

`orthogonalEdgeStyle` obliga a que los segmentos sean horizontales y verticales; `rounded=1` redondea las esquinas; `jumpStyle=arc` pide saltos en arco donde dos aristas se cruzan. Nótese que `jumpStyle` es una extensión de draw.io, no parte del núcleo open source de mxGraph: el fichero lo configura correctamente y el cliente de draw.io lo respeta, pero el renderizador offline incluido no puede dibujarlo. Esa limitación se declara en [Limitaciones conocidas](../README.md#known-limitations-listed-honestly).

### Anclas

Un ancla fija un extremo a un punto concreto de la caja del nodo, expresado como fracciones del ancho y del alto:

```
exitX=1;exitY=0.5;exitDx=0;exitDy=0;entryX=0;entryY=0.5;entryDx=0;entryDy=0;
```

`exitX`/`exitY` sitúan el inicio en el nodo origen, `entryX`/`entryY` el final en el destino; los pares `Dx`/`Dy` son las ranuras de desplazamiento de draw.io y aquí valen siempre cero. `0,0` es la esquina superior izquierda y `1,1` la inferior derecha, así que `exitX=1;exitY=0.5` significa «borde derecho, mitad vertical».

El enrutador prueba ocho combinaciones de anclas en un orden fijo — primero los cuatro pares opuestos, luego los cuatro pares del mismo lado, que existen para permitir rodeos laterales:

| Orden | exitX, exitY | entryX, entryY | Forma |
| :--- | :--- | :--- | :--- |
| 1 | 1, 0.5 | 0, 0.5 | borde derecho a borde izquierdo |
| 2 | 0, 0.5 | 1, 0.5 | borde izquierdo a borde derecho |
| 3 | 0.5, 1 | 0.5, 0 | borde inferior a borde superior |
| 4 | 0.5, 0 | 0.5, 1 | borde superior a borde inferior |
| 5 | 1, 0.5 | 1, 0.5 | borde derecho a borde derecho |
| 6 | 0, 0.5 | 0, 0.5 | borde izquierdo a borde izquierdo |
| 7 | 0.5, 0 | 0.5, 0 | borde superior a borde superior |
| 8 | 0.5, 1 | 0.5, 1 | borde inferior a borde inferior |

El orden solo desempata: cada combinación se puntúa por la longitud de la ruta resultante, y gana la más corta que no colisione. Si **ninguna** combinación produce una ruta limpia, no se emite ningún atributo de ancla y draw.io enruta la arista por su cuenta — se considera mejor una arista sin ancla que una anclada que atraviesa un nodo.

### Puntos intermedios y enrutado

Los puntos intermedios van en un hijo `<Array as="points">` de la `mxGeometry` de la arista:

```xml
<mxGeometry relative="1" as="geometry">
  <Array as="points">
    <mxPoint x="690" y="332" />
    <mxPoint x="690" y="238" />
  </Array>
</mxGeometry>
```

`relative="1"` marca el array como desplazamientos respecto al padre de la arista. Cuando no hay puntos intermedios, la geometría se reduce a la forma autocerrada `<mxGeometry relative="1" as="geometry" />`.

El enrutador es un pequeño bucle de generar y probar, no un buscador de caminos general:

| Paso | Función | Qué hace |
| :--- | :--- | :--- |
| generación de candidatos | `_candidates` | para un par de anclas, emite unas cuantas rutas ortogonales: por el hueco entre contenedores, en forma de L en ambos órdenes, por un carril lateral, y variantes con desvío de carril |
| ruta por el hueco | `_cross_gap` | cuando dos contenedores no se solapan, devuelve el eje y el punto medio del canal vacío entre ellos; no devuelve nada cuando sí se solapan |
| desvío de carril | `_lane_pt` | desplaza un extremo 15 unidades por la normal exterior del borde en que se apoya, para que la línea salga del borde antes de girar en vez de recorrerlo |
| prueba de colisión | `_crosses` | ¿entra un segmento en la caja de un nodo? Ambos extremos se encogen 3 unidades y la caja se infla 2, así que un extremo apoyado en un borde no cuenta como colisión |
| puntuación | `_length` | longitud Manhattan; gana la ruta superviviente más corta |

Las constantes que dan forma a todo esto son `DETOUR = 15` (desplazamiento de carril), `SLACK = 2` (inflado de la caja en la prueba de colisión) y `SHRINK = 3` (retroceso del extremo). El conjunto de obstáculos incluye los propios nodos origen y destino — sin eso, una ruta podría legalmente discurrir a lo largo del borde de su propio nodo, lo que parece que la línea se dibuja **a través** de la caja.

## Almacenamiento comprimido

> **Este es el modo de fallo que hace perder trabajo.** draw.io comprime el diagrama por defecto al guardar. Una implementación que solo lea XML plano reportará **un diseño vacío, sin error**, justo después de que el usuario haya ordenado el diagrama a mano — y cada coordenada que fijó se descarta en silencio.

### La transformación exacta

```
base64( raw-deflate( url-quote( xml ) ) )
```

Leerlo en Python son tres llamadas, y el tercer argumento de `decompress` es lo que lo hace funcionar:

```python
urllib.parse.unquote(zlib.decompress(base64.b64decode(data), -15).decode("utf-8"))
```

`-15` selecciona DEFLATE en crudo, es decir un flujo zlib sin la cabecera de 2 bytes ni la suma de comprobación de 4. Usar el `zlib.decompress(data)` por defecto lanza una excepción, porque el flujo no viene envuelto en zlib. Nótese también que la carga útil es una **decodificación UTF-8 después de inflar**: el XML va codificado en porcentaje, así que los caracteres multibyte sobreviven al ciclo como escapes `%XX` en lugar de bytes en crudo.

Del lado de la escritura, el conjunto de escape importa igual. Los caracteres que se dejan sin escapar son `~()*!.'` — el `urlquote` de Python además dejaría pasar `/` y `:`, produciendo una carga que draw.io no puede releer.

### Se leen ambas formas, y una carga rota lanza

`_unpack` acepta cualquiera de las dos formas:

| Entrada | Comportamiento |
| :--- | :--- |
| `<diagram>` con un hijo `<mxGraphModel>` | se devuelve tal cual — esta es la forma plana |
| `<diagram>` cuyo texto es una carga comprimida | se infla en el sitio y se añade el `<mxGraphModel>`, de modo que el código posterior ve una sola forma |
| `<diagram>` con texto vacío | se omite — algunos ficheros contienen diagramas de relleno |
| `<diagram>` cuyo texto no se puede inflar | **lanza `ValueError`** |

Esa última fila es la decisión de diseño que merece decirse sin rodeos: devolver un diseño vacío sería indistinguible de un diagrama que realmente no tiene diseño, y quien llama sobrescribiría trabajo hecho a mano con los valores por defecto. Lanzar hace visible la corrupción en el punto de fallo. `conformance.md` lo enumera como capacidad obligatoria y no como refinamiento, y exige el mismo comportamiento a las tres implementaciones.

Como ambas formas se inflan al mismo árbol, `read_layout` es agnóstico a la forma: el mismo fichero guardado por drawcode y vuelto a guardar por draw.io produce nodos, aristas y atributos idénticos. Esa igualdad se verifica contra un fichero dorado comprimido con draw.io.

## Idempotencia del ida y vuelta

Compilar dos veces no debe mover nada. La dificultad es que **el generador escribe puntos intermedios en el fichero y luego no distingue los suyos de los que arrastró una persona** — así que en la siguiente ejecución preservaría su propia salida como si fuera intención humana, y el algoritmo de enrutado nunca podría mejorar.

La solución es una comparación, no una marca:

1. `apply_layout` primero hidrata las posiciones de los nodos desde el fichero, de modo que el modelo refleja las coordenadas reales.
2. `_auto_waypoints(model)` recalcula después, **para esas coordenadas**, cuáles serían los puntos intermedios de cada arista si los produjera hoy el generador.
3. Para cada arista se adoptan los puntos del fichero; si igualan el valor automático recién calculado, se **descartan** — la arista se queda sin puntos almacenados, así que `to_drawio` volverá a enrutarla desde cero.
4. Todo lo que *no* coincida con el valor automático se conserva, porque alguien lo habrá movido.

Merece la pena detallar las consecuencias:

| Situación | Resultado |
| :--- | :--- |
| Compilar → compilar sin editar | fichero idéntico; los puntos automáticos se recalculan a los mismos valores |
| Compilar → arrastrar un nodo en draw.io → compilar | el nodo se mueve y las aristas se reenrutan contra la nueva posición |
| Compilar → tirar de la línea de una arista → compilar | esa arista conserva su trazado; las demás se recalculan |
| El algoritmo de enrutado cambia | los puntos automáticos antiguos ya no coinciden y se **conservan**, así que parecen hechos a mano; recompila sin `--layout-from` para recoger el enrutado nuevo |

Esa última fila es el caso límite honesto: la heurística no distingue «automático, de una versión anterior» de «humano». Añadir un atributo marcador lo resolvería a costa de meter contabilidad del generador en un fichero que editan personas.

## Reglas de normalización

La comparación entre implementaciones es estructural, nunca byte a byte. El orden de los atributos es irrelevante, el espacio en blanco insignificante es irrelevante, y los números se comparan por valor y no por su escritura — `420`, `420.0` y `4.2e2` son iguales. Los valores `id` generados (`n1`, `e1`, `grp1`) no forman parte del contrato más allá de ser únicos y estables dentro de una ejecución; lo que se compara es el mapeo de `symbolId` a geometría. La lista completa, incluido a cuál de los cuatro niveles de comparación pertenece un fallo, está en [`conformance.md`](conformance.md).

Una regla de esa lista merece repetirse aquí porque es una regla del formato `.drawio`, no del proceso: **el orden de los elementos sigue el orden del documento, salvo donde la especificación dice «ordenado»** — contenedores por id, nodos por `symbolId`, aristas por la terna `(src, dst, rw)`. Ordenar antes de comparar es lo que hace que la comparación sea independiente del orden de iteración del diccionario, que difiere entre Python y, por ejemplo, .NET.

## Relacionado

- [annotations.md](annotations.md) — de dónde salen los atributos del `<object>`
- [architecture.md](architecture.md) — por qué solo se reescribe la capa de declaración
- [`conformance.md`](conformance.md) — niveles de comparación y reglas de normalización
- [`tools/render/README.md`](../tools/render/README.md) — renderizar un `.drawio` sin tener draw.io instalado

"""把 IR 渲染成只读的 SVG 预览图。

与 drawio.py 的关系（**容易误解，务必看清**）：

    共享：节点坐标 —— 这里直接复用 drawio 的 ``_assign_default_positions``
         和 ``_container_box``，所以元素位置与 .drawio 一致。
    不共享：边路由 —— 这里的连线走「源节点中心 -> 拐点 -> 目标中心」，
         不调用 drawio 的 ``_route``（锚点选择、障碍规避、跨容器缝隙）。
         因此在 .drawio 里被路由绕开的框，在 SVG 里会被线穿过。

这是**刻意的**，不是 bug：SVG 只用于快速预览，保持简单可读；要精确几何请用
.drawio。详见 spec/conformance.md 的 "Known divergence" 一节——注意一致性测试
因此**不得**断言 SVG 的边几何。

图片与文字块是在这条「简化」线上**跟齐 .drawio** 的两处，不能简化：设备卡片
少了图片、图上少了说明文字，这张预览就不再能用来核对成品长什么样。代价是导出
的 SVG 用相对路径引用图片文件，它必须和图片目录一起被搬动。
"""

import re
from html import escape

from .drawio import (
    CALLOUT_FILL, CALLOUT_FONT, CALLOUT_STROKE, _assign_default_positions,
    _container_box, _num,
)

SIGNAL_FILL, SIGNAL_STROKE = "#d5e8d4", "#82b366"
FUNC_FILL, FUNC_STROKE = "#ffe6cc", "#d79b00"
EXT_FILL, EXT_STROKE = "#f5f5f5", "#666666"
CONT_FILL, CONT_STROKE = "#dae8fc", "#6c8ebf"
EDGE_COLOR = "#666666"
FONT = "Helvetica,Arial,'Microsoft YaHei',sans-serif"
HEADER = 30

_BR_RE = re.compile(r"<br\s*/?>", re.I)
_STROKE_RE = re.compile(r"strokeColor=(#[0-9a-fA-F]{3,8})")


def _text(cx, cy, lines, size=12, anchor="middle", fill="#222222", weight=None):
    """输出一段可能多行的 <text>；多行时用 <tspan> 并手工计算首行基线。

    SVG 没有换行，所以这里自己按行高 1.2 倍排版，并把整块垂直居中到 cy。
    """
    n = len(lines)
    first = cy - (n - 1) * size * 0.6
    attrs = 'text-anchor="%s" font-size="%s" fill="%s"' % (anchor, size, fill)
    if weight:
        attrs += ' font-weight="%s"' % weight
    head = '<text x="%s" y="%s" %s>' % (_num(cx), _num(first + size * 0.35), attrs)
    if n == 1:
        return head + escape(lines[0]) + "</text>"
    out = [head]
    for i, line in enumerate(lines):
        dy = 0 if i == 0 else size * 1.2
        out.append('<tspan x="%s" dy="%s">%s</tspan>' % (_num(cx), _num(dy), escape(line)))
    out.append("</text>")
    return "".join(out)


def _node_lines(kind, e):
    """节点内显示什么文字：信号显示「名字 + 类型/方向/单位」，函数显示「别名 + 签名」。"""
    if kind == "signal":
        meta = " / ".join(b for b in (e.ctype, e.dir, e.unit) if b)
        return [e.name, meta] if meta else [e.name]
    return ["%s()" % (e.alias or e.name), "%s %s()" % (e.ret, e.name)]


def _callout_lines(c):
    """文字块按 ``<br>`` 断行 —— 与 .drawio 侧 html=1 的换行语义是同一件事。"""
    return _BR_RE.split(c.text)


def _callout_svg(c):
    """画一个文字块。band 铺在容器之上、节点之下；box/text 画在节点之后压在上面。

    先后次序由调用点决定，这里只负责画 —— 与 to_drawio 的 emit_callouts 对齐。
    """
    size = c.font_size if c.font_size > 0 else CALLOUT_FONT.get(c.shape, 12)
    out = []
    if c.shape != "text":
        dash = ' stroke-dasharray="6 4"' if c.shape == "band" else ""
        out.append(
            '<rect x="%s" y="%s" width="%s" height="%s" rx="4" '
            'fill="%s" stroke="%s"%s data-kind="callout"/>'
            % (
                _num(c.x), _num(c.y), _num(c.w), _num(c.h),
                CALLOUT_FILL.get(c.shape, "none"), CALLOUT_STROKE.get(c.shape, "none"), dash,
            )
        )
    # verticalAlign=top / spacingTop=6 / spacingLeft=8，与 drawio 的 calloutStyle 间距对齐
    weight = "bold" if c.shape == "band" else None
    out.append(_text(
        c.x + 8, c.y + 6 + size * 0.75, _callout_lines(c),
        size=size, anchor="start", weight=weight,
    ))
    return "".join(out)


def _edge_label(model, e, rw_labels):
    """边上显示的文字：内联边用被折叠信号的 unit（退回 name），其余仍是 rw。"""
    if e.rw == "inline" and e.sig:
        sig = model.signals.get(e.sig)
        if sig is not None:
            return sig.unit if sig.unit != "" else sig.name
    # 与 drawio._inline_edge_label 同一套口径：rw_labels=False 时去掉 read/write
    return e.rw if rw_labels else ""


def _edge_color(model, e):
    """内联边沿用被折叠信号的 Style 片段里的线色；取不到就用默认色。"""
    if e.rw != "inline" or not e.sig:
        return EDGE_COLOR
    sig = model.signals.get(e.sig)
    m = _STROKE_RE.search(sig.style if sig is not None else "")
    return m.group(1) if m else EDGE_COLOR


def _edge_points(model, e, straight_edges=False):
    """边的折线点。**这里就是与 drawio 分道扬镳的地方**（见模块头）。

    两端取节点中心；没有人工拐点时补一个中点直角折弯，让线看起来像正交路由。
    不做任何障碍检测。直线模式直接连两点，不补肘点；人工拐点同样保留。
    """
    src = model.signals.get(e.src) or model.funcs.get(e.src)
    dst = model.signals.get(e.dst) or model.funcs.get(e.dst)
    if src is None or dst is None:
        return []
    pts = [(src.x + src.w / 2.0, src.y + src.h / 2.0)]
    pts.extend(e.waypoints or [])
    pts.append((dst.x + dst.w / 2.0, dst.y + dst.h / 2.0))
    if straight_edges:
        return pts
    if len(pts) == 2:
        (x1, y1), (x2, y2) = pts
        mx = (x1 + x2) / 2.0
        pts = [(x1, y1), (mx, y1), (mx, y2), (x2, y2)]
    return pts


def to_svg(model, padding=24, cards=False, rw_labels=True, straight_edges=False):
    """渲染整个 Model。会**就地修改** model 的坐标（调用了布局函数）。"""
    # 复用 drawio 的布局，保证节点位置两边一致
    _assign_default_positions(model)
    # 跳过被 inline 折叠的信号：否则图上剩一堆没有边的空椭圆
    ents = [s for s in model.signals.values() if s.id not in model.inlined]
    ents += list(model.funcs.values())

    # 按分组（容器）聚拢，再算出每个容器连同其标题栏的包围盒
    groups = {}
    for e in ents:
        groups.setdefault(e.group or "misc", []).append(e)

    boxes = {g: _container_box(members) for g, members in groups.items()}
    if not ents:
        # 空模型给一个 1x1 的合法 SVG，避免调用方拿到空字符串
        return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" viewBox="0 0 1 1"></svg>'

    # 文字块也计入画布范围：否则一张主要靠文字说明的图会被裁得只剩卡片
    callout_xs = [v for c in model.callouts for v in (c.x, c.x + c.w)]
    callout_ys = [v for c in model.callouts for v in (c.y, c.y + c.h)]
    xs = [e.x for e in ents] + [b[0] for b in boxes.values()] + callout_xs
    ys = [e.y for e in ents] + [b[1] for b in boxes.values()] + callout_ys
    x2 = [e.x + e.w for e in ents] + [b[0] + b[2] for b in boxes.values()] + callout_xs
    y2 = [e.y + e.h for e in ents] + [b[1] + b[3] for b in boxes.values()] + callout_ys

    # viewBox 由内容包围盒加 padding 推出，图形尺寸与坐标因此完全由布局决定
    minx, miny = min(xs) - padding, min(ys) - padding
    width = (max(x2) - minx) + padding
    height = (max(y2) - miny) + padding

    out = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="%s" height="%s" viewBox="%s %s %s %s" font-family="%s">'
        % (_num(width), _num(height), _num(minx), _num(miny), _num(width), _num(height), FONT),
        '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" '
        'orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="%s"/></marker></defs>' % EDGE_COLOR,
    ]

    # 先画容器，再画 band，再画节点，最后画说明与边——SVG 无 z-index，顺序即层级
    for g in sorted(boxes):
        ox, oy, ow, oh = boxes[g]
        out.append(
            '<rect x="%s" y="%s" width="%s" height="%s" rx="6" fill="%s" stroke="%s" data-kind="container"/>'
            % (_num(ox), _num(oy), _num(ow), _num(oh), CONT_FILL, CONT_STROKE)
        )
        out.append(_text(ox + 12, oy + HEADER / 2.0, [g], size=13, anchor="start", weight="bold"))

    for c in model.callouts:
        if c.shape == "band":
            out.append(_callout_svg(c))

    items = [("signal", s) for s in model.signals.values() if s.id not in model.inlined]
    items += [("func", f) for f in model.funcs.values()]
    for kind, e in sorted(items, key=lambda t: t[1].id):
        # 信号画椭圆，函数画圆角矩形；外部器件用虚线区分
        cx, cy = e.x + e.w / 2.0, e.y + e.h / 2.0
        if kind == "signal":
            out.append(
                '<ellipse cx="%s" cy="%s" rx="%s" ry="%s" fill="%s" stroke="%s" data-kind="signal"/>'
                % (_num(cx), _num(cy), _num(e.w / 2.0), _num(e.h / 2.0), SIGNAL_FILL, SIGNAL_STROKE)
            )
        elif cards and e.asset:
            # 设备卡片：图片占满节点框。preserveAspectRatio="none" 与 imageAspect=0
            # 同义：跟着框变形，不留等比白边。
            out.append(
                '<image x="%s" y="%s" width="%s" height="%s" '
                'preserveAspectRatio="none" href="%s" data-kind="image"/>'
                % (_num(e.x), _num(e.y), _num(e.w), _num(e.h), escape(e.asset, quote=True))
            )
        else:
            dash = ' stroke-dasharray="6 4"' if e.external else ""
            out.append(
                '<rect x="%s" y="%s" width="%s" height="%s" rx="4" fill="%s" stroke="%s"%s data-kind="func"/>'
                % (
                    _num(e.x),
                    _num(e.y),
                    _num(e.w),
                    _num(e.h),
                    EXT_FILL if e.external else FUNC_FILL,
                    EXT_STROKE if e.external else FUNC_STROKE,
                    dash,
                )
            )
        if kind == "func" and cards and e.asset:
            # 卡片标签只有一行（对应 drawio 的 verticalLabelPosition=bottom）
            out.append(_text(cx, e.y + e.h + 16, [e.alias or e.name], size=13, weight="bold"))
        else:
            out.append(_text(cx, cy, _node_lines(kind, e)))

    # 说明文字后画，压在卡片上面
    for c in model.callouts:
        if c.shape != "band":
            out.append(_callout_svg(c))

    for e in model.edges:
        pts = _edge_points(model, e, straight_edges)
        if not pts:
            continue
        d = "M " + " L ".join("%s %s" % (_num(px), _num(py)) for px, py in pts)
        out.append(
            '<path d="%s" fill="none" stroke="%s" stroke-width="1.4" marker-end="url(#arrow)" data-edge="1"/>'
            % (d, _edge_color(model, e))
        )
        # 标签可能被 --no-rw-labels 关掉；空标签不落文字，免得留下一堆空 <text>
        label = _edge_label(model, e, rw_labels)
        if label != "":
            mx, my = pts[len(pts) // 2]
            # 这里**不做**平行边的标签去叠印（.drawio 侧做了，见 drawio.separate_labels）。
            # 原因：SVG 的一致性测试不得断言边几何，标签位置同理；只改一侧会制造
            # 预览与 .drawio 的差异。要动就得三份一起动，那是另一件事。
            out.append(_text(mx, my - 8, [label], size=10, fill="#444444"))

    out.append("</svg>")
    return "".join(out)

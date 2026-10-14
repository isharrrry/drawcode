"""drawio 方向：IR -> .drawio XML，以及反向的读取。

这是全项目最复杂的一块，也是性能热点所在。它做四件事：

    1. 布局     _assign_default_positions —— 组内按方向排序垂直堆叠，组间水平避让
    2. 路由     _route / _candidates / _crosses —— 为每条边挑一组锚点和一条不撞节点的折线
    3. 发射     to_drawio —— 把节点、容器、边写成 drawio 认识的 XML
    4. 回读     read_layout / apply_layout —— 把人工调整过的排版取回来

**跨语言几何契约**（三个语言实现必须逐字节一致，改动这些等于让三版分叉）：
    ANCHOR_SETS 的**顺序**       决定平局时先选中哪组锚点
    SHRINK=3 / SLACK=2 / DETOUR=15   障碍判定与绕行的容差
    _candidates 里各种走法的**先后**   同样影响平局
这些常量看着像随手取的数，其实是接口。要改必须三语言一起改并重新生成金标准。

节点用 ``<object symbolId="…">`` 包装，这个 symbolId 是 drawcode 的身份标识：
read_layout 只认带 symbolId 的元素，所以用户在 draw.io 里手画的东西（裸 ``<mxCell>``）
不会被读进来污染 IR。
"""

import base64
import urllib.parse
import xml.etree.ElementTree as ET
import zlib
from html import escape

PAD = 30
HEADER = 30
NODE_W, NODE_H = 160, 60
GAP_Y = 40

SIGNAL_STYLE = "shape=ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;"
FUNC_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;"
FUNC_EXT_STYLE = "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#666666;"
CONT_STYLE = "swimlane;startSize=%d;collapsible=0;recursiveResize=0;fillColor=#dae8fc;strokeColor=#6c8ebf;html=1;" % HEADER
EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;jumpStyle=arc;jumpSize=6;"
ANCHOR_STYLE = "exitX=%s;exitY=%s;exitDx=0;exitDy=0;entryX=%s;entryY=%s;entryDx=0;entryDy=0;"

# 方向五边形：形状本身就表达数据流向，不再往节点上贴额外的记号。
#
#   输入 = 左边平、右边尖   —— 数据从右侧尖角流进来
#   输出 = 右边平、左边尖   —— 数据从左侧尖角流出去
#
# 路径坐标按 160x60 的**设计尺寸**书写（正是 NODE_W x NODE_H），尖角精确落在
# 左右边缘中点上 —— 与 ANCHOR_SETS 第一条的 (1.0,0.5)/(0.0,0.5) 重合，所以
# 连线的起止点天然咬在尖角上，不需要额外补偿。
#
# 为什么用 `shape=path` 而不是现成的五边形：mxGraph 核心只注册了
# box/customShape/sample 三个形状，`mxgraph.basic.pentagon` 之类是 draw.io 的
# 扩展形状，离线渲染器画不出来（会退化成矩形），也就无法验证。`shape=path`
# 是 draw.io 的标准功能，渲染器侧由 tools/render/render_drawio.js 注册实现，
# 两边都能得到同一个五边形。
#
# 无方向的信号仍旧用椭圆（没有任何流向可表达）。
PENTA_IN_PATH = "0,0 115,0 160,30 115,60 0,60"
PENTA_OUT_PATH = "45,0 160,0 160,60 45,60 0,30"
SIGNAL_IN_STYLE = "shape=path;path=%s;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" % PENTA_IN_PATH
SIGNAL_OUT_STYLE = "shape=path;path=%s;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" % PENTA_OUT_PATH
SIGNAL_DIR_STYLE = {"in": SIGNAL_IN_STYLE, "out": SIGNAL_OUT_STYLE}
# 线沿节点边框外移的距离，避免贴着框边爬
DETOUR = 15
# 障碍判定的容差：SLACK 放宽（贴边不算撞），SHRINK 收缩线段两端（端点落在边上不算穿透）
SLACK = 2
SHRINK = 3

# 先试对向锚点，再试同侧锚点（同侧配侧向绕行用）
#
# 每项是 (exitX, exitY, entryX, entryY)，取值是矩形上的相对坐标：
#   0.0/1.0 表示该边，0.5 表示中点。**顺序即优先级**——_route 在长度相同时取先出现的，
#   所以调整这里的顺序会改变几何输出。
ANCHOR_SETS = (
    (1.0, 0.5, 0.0, 0.5),
    (0.0, 0.5, 1.0, 0.5),
    (0.5, 1.0, 0.5, 0.0),
    (0.5, 0.0, 0.5, 1.0),
    (1.0, 0.5, 1.0, 0.5),
    (0.0, 0.5, 0.0, 0.5),
    (0.5, 0.0, 0.5, 0.0),
    (0.5, 1.0, 0.5, 1.0),
)


def _num(v):
    """坐标格式化：整数不带小数点，否则用 repr。

    三语言必须输出同一串字面量，否则金标准的字节比对立刻失败。
    """
    v = float(v)
    return str(int(v)) if v == int(v) else repr(v)


def _attrs(pairs):
    return " ".join(
        '%s="%s"' % (k, escape(str(v), quote=True)) for k, v in pairs if v not in (None, "")
    )


def _entities(model):
    """信号和函数都算「实体」——它们在画布上的待遇一致，都会被画成一个节点。"""
    out = []
    for s in model.signals.values():
        out.append(("signal", s))
    for f in model.funcs.values():
        out.append(("func", f))
    return out


def _edge_key(e):
    """边的稳定键。读写 layout 都靠它配对，所以 src/dst/rw 三者缺一不可。"""
    return "%s->%s:%s" % (e.src, e.dst, e.rw)


def _rect(model, sid):
    e = model.signals.get(sid) or model.funcs.get(sid)
    return e.x, e.y, e.w, e.h


def _cross_gap(sbox, dbox):
    """两容器之间的空缝；互相重叠时没有缝。

    跨容器的边如果直接连，必然横穿某个容器的内部、压住里面的节点。让它改走两个
    容器之间的空隙，视觉上干净得多。返回 ("v"|"h", 坐标) 或 None。
    """
    if sbox[0] + sbox[2] <= dbox[0]:
        return "v", (sbox[0] + sbox[2] + dbox[0]) / 2.0
    if dbox[0] + dbox[2] <= sbox[0]:
        return "v", (dbox[0] + dbox[2] + sbox[0]) / 2.0
    if sbox[1] + sbox[3] <= dbox[1]:
        return "h", (sbox[1] + sbox[3] + dbox[1]) / 2.0
    if dbox[1] + dbox[3] <= sbox[1]:
        return "h", (dbox[1] + dbox[3] + sbox[1]) / 2.0
    return None


def _endpoints(srect, drect, a):
    """把相对锚点换成绝对坐标。a 是 (exitX, exitY, entryX, entryY)。"""
    return (
        (srect[0] + srect[2] * a[0], srect[1] + srect[3] * a[1]),
        (drect[0] + drect[2] * a[2], drect[1] + drect[3] * a[3]),
    )


def _lane_pt(pt, ax, ay):
    """沿锚点所在边的法线外移 DETOUR：让线先离开边框再走，不贴着边框爬。"""
    x, y = pt
    if ax == 0.0:
        return (x - DETOUR, y)
    if ax == 1.0:
        return (x + DETOUR, y)
    if ay == 0.0:
        return (x, y - DETOUR)
    if ay == 1.0:
        return (x, y + DETOUR)
    return (x, y)


def _candidates(sp, dp, a, srect, drect, gap):
    """同一组锚点下的几种正交走法。

    按「可能更好」的顺序排列，但最终是 _route 按长度选，这里的顺序只在**等长**时
    才决定胜出者——所以它同样是几何契约。

    几类走法：
      借容器缝隙 / 走「先横后竖」/ 走「先竖后横」/ 同侧锚点时沿外侧通道绕 / 先离开边框
    """
    out = []
    if gap is not None:
        kind, pos = gap
        if kind == "v":
            out.append([sp, (pos, sp[1]), (pos, dp[1]), dp])
        else:
            out.append([sp, (sp[0], pos), (dp[0], pos), dp])
    out.append([sp, (dp[0], sp[1]), dp])
    out.append([sp, (sp[0], dp[1]), dp])
    # 进出都在同一侧时，需要一条位于两个节点之外、与之平行的「车道」
    if a[0] == a[2] and a[0] in (0.0, 1.0):
        lane = (
            min(srect[0], drect[0]) - DETOUR
            if a[0] == 0.0
            else max(srect[0] + srect[2], drect[0] + drect[2]) + DETOUR
        )
        out.append([sp, (lane, sp[1]), (lane, dp[1]), dp])
    if a[1] == a[3] and a[1] in (0.0, 1.0):
        lane = (
            min(srect[1], drect[1]) - DETOUR
            if a[1] == 0.0
            else max(srect[1] + srect[3], drect[1] + drect[3]) + DETOUR
        )
        out.append([sp, (sp[0], lane), (dp[0], lane), dp])

    sp2, dp2 = _lane_pt(sp, a[0], a[1]), _lane_pt(dp, a[2], a[3])
    if sp2 != sp or dp2 != dp:
        # 先垂直于边框走一小段离开它，再拐弯——否则线会沿着框边爬
        out.append([sp, sp2, (dp2[0], sp2[1]), dp2, dp])
        out.append([sp, sp2, (sp2[0], dp2[1]), dp2, dp])
    return out


def _crosses(box, p, q):
    """线段是否插进节点框；两端各收 SHRINK，端点贴边不算穿透。

    只处理横平竖直的线段（正交路由下就该只有这两种）；斜线一律返回 False。

    这是**全项目的性能热点**：它被 _route 在「每条边 × 每个候选 × 每个障碍」的三重
    循环里调用，实测 20 模块规模下单次运行要调 248 万次、占 69% 时间。想优化性能，
    从这里下手（空间索引/预筛），别去微调别处。
    """
    x, y, w, h = box
    if abs(p[1] - q[1]) < 0.5:
        # 水平段
        lo, hi = sorted((p[0], q[0]))
        lo, hi = lo + SHRINK, hi - SHRINK
        return hi > lo and (y - SLACK) < p[1] < (y + h + SLACK) and hi > x and lo < x + w
    if abs(p[0] - q[0]) < 0.5:
        # 垂直段
        lo, hi = sorted((p[1], q[1]))
        lo, hi = lo + SHRINK, hi - SHRINK
        return hi > lo and (x - SLACK) < p[0] < (x + w + SLACK) and hi > y and lo < y + h
    return False


def _length(pts):
    """折线的曼哈顿长度——正交路由下这就是真实线长。"""
    return sum(
        abs(pts[i + 1][0] - pts[i][0]) + abs(pts[i + 1][1] - pts[i][1])
        for i in range(len(pts) - 1)
    )


def _conn_side(model, eid):
    """信号节点的连线接入边：输入接右侧（右尖）、输出接左侧（左尖）。

    这两个值是刻意固定的，不是"可选之一"：五边形的尖角本身就是流向的标记，
    线从平边接进去会把标记的意思废掉。函数与无方向的信号返回 None —— 它们的
    形状没有表达方向，硬性限制只会逼线绕远路。
    """
    sig = model.signals.get(eid)
    if sig is None:
        return None
    return {"in": "right", "out": "left"}.get(getattr(sig, "dir", "") or "")


def _side_ok(anchor, src_side, dst_side):
    """锚点是否满足两端的方向约束（中点锚点才算数，0.5 是对应的 y）。"""
    if src_side is not None:
        want = 1.0 if src_side == "right" else 0.0
        if anchor[0] != want or anchor[1] != 0.5:
            return False
    if dst_side is not None:
        want = 1.0 if dst_side == "right" else 0.0
        if anchor[2] != want or anchor[3] != 0.5:
            return False
    return True


def _route(srect, drect, obstacles, gap, src_side=None, dst_side=None):
    """在所有锚点/走法组合里挑一条不撞节点的最短线。

    返回 (锚点, 中间拐点)；全撞时锚点为 None，交回 drawio 自己路由。

    复杂度是 O(|ANCHOR_SETS| × |候选| × |障碍|)。所有组合都撞时宁可放弃——
    让 draw.io 用它自己的路由兜底，好过强行画一条穿框的线。

    注意 obstacles 里**包含起点和终点自身的框**：否则从节点内部出发的线段会被
    误判为"畅通"，线就会贴着甚至压着起止节点的边框走（曾经的真实 bug）。

    src_side/dst_side 是方向约束（"left"/"right"/None）。**约束无解时会放宽重试**
    —— 宁可偶尔让线不咬尖角，也不能让边凭空消失。
    """
    def search(with_constraints):
        best = None
        for a in ANCHOR_SETS:
            if with_constraints and not _side_ok(a, src_side, dst_side):
                continue
            sp, dp = _endpoints(srect, drect, a)
            for pts in _candidates(sp, dp, a, srect, drect, gap):
                if any(
                    _crosses(box, pts[i], pts[i + 1])
                    for i in range(len(pts) - 1)
                    for box in obstacles
                ):
                    continue
                n = _length(pts)
                if best is None or n < best[0]:
                    best = (n, a, pts)
        return best

    best = search(True)
    if best is None and (src_side is not None or dst_side is not None):
        best = search(False)
    if best is None:
        return None, []
    # 掐头去尾：首尾是锚点本身，已经写进 exit*/entry* 了，不用再当成拐点
    return best[1], best[2][1:-1]


def _route_edge(model, e, avoid, gap):
    """按边的两端算出锚点与拐点。

    **两个调用点（_auto_waypoints 与 to_drawio）必须走这一个入口**：它们算出的
    拐点必须逐字相同，否则 apply_layout 会把自动产生的拐点误认成人工拖动、
    锁死不再重算。
    """
    return _route(
        _rect(model, e.src),
        _rect(model, e.dst),
        avoid,
        gap,
        _conn_side(model, e.src),
        _conn_side(model, e.dst),
    )


def _auto_waypoints(model):
    """当前坐标下每条边会自动算出的拐点，用来认出"这是生成器写的，不是人拖的"。

    用途见 apply_layout：回读时若某条边的拐点恰好等于这里算出来的值，说明它只是
    上次自动产生的、不是人工编辑，应当丢弃重算——否则人工调整节点位置后，旧拐点
    会被当成"用户的选择"锁死，线就永远绕不回来了。
    """
    groups = {}
    for _, e in _entities(model):
        groups.setdefault(e.group or "misc", []).append(e)
    boxes = {g: _container_box(ms) for g, ms in groups.items()}
    auto = {}
    for e in model.edges:
        sg = (model.signals.get(e.src) or model.funcs[e.src]).group or "misc"
        dg = (model.signals.get(e.dst) or model.funcs[e.dst]).group or "misc"
        avoid = [(o.x, o.y, o.w, o.h) for _, o in _entities(model)]
        gap = _cross_gap(boxes[sg], boxes[dg]) if sg != dg else None
        auto[_edge_key(e)] = _route_edge(model, e, avoid, gap)[1]
    return auto


def _dir_rank(e):
    """组内排序权：输入信号靠上、输出信号靠下，中间留给无方向的实体。

    这样整张图的流向是「左上 -> 右下」，与五边形尖角的朝向一致（输入在右、
    输出在左，上下错开之后线自然从左下往右上走）。
    函数没有 dir 属性，getattr 取到空串，自然落在中间。
    """
    d = getattr(e, "dir", "") or ""
    if d == "in":
        return 0
    if d == "out":
        return 2
    return 1


def _assign_default_positions(model):
    """给没坐标的实体排初始位；容器之间做水平避让，保证不互相压住。

    ``if e.x == 0 and e.y == 0`` 是「这个节点还没有坐标」的约定——所以原点处的节点
    会被当成未定位并重新排布。带着人工坐标（``@drawcode xy="…"``）的节点不受影响。
    """
    groups = {}
    for kind, e in _entities(model):
        groups.setdefault(e.group or "misc", []).append(e)

    right_edge = None
    for gname in sorted(groups):
        # 组名排序 + 组内 (方向权, id) 排序：全程确定性，保证同输入同输出
        members = sorted(groups[gname], key=lambda e: (_dir_rank(e), e.id))
        y = PAD + HEADER + PAD
        for e in members:
            if e.x == 0 and e.y == 0:
                e.x, e.y = PAD, y
            y += e.h + GAP_Y

        # 若这一组比已排好的往左，就整组右移，避免两个容器水平重叠
        box = _container_box(members)
        if right_edge is not None and box[0] < right_edge:
            dx = right_edge - box[0]
            for e in members:
                e.x += dx
            box = _container_box(members)
        right_edge = box[0] + box[2] + 4 * PAD


def _container_box(members):
    """容器的包围盒。节点尺寸已经含了尖角，不需要再为方向记号留余量。"""
    xs = [e.x for e in members]
    ys = [e.y for e in members]
    x2 = [e.x + e.w for e in members]
    y2 = [e.y + e.h for e in members]
    ox, oy = min(xs) - PAD, min(ys) - PAD - HEADER
    ow = max(x2) - min(xs) + 2 * PAD
    oh = max(y2) - min(ys) + 2 * PAD + HEADER
    return ox, oy, ow, oh


def _node_label(kind, e):
    """节点上显示的两行 HTML：主标题 + 元信息行。"""
    if kind == "signal":
        bits = [b for b in (e.ctype, e.dir, e.unit) if b]
        return "%s<br>%s" % (escape(e.name), escape(" / ".join(bits)))
    title = "%s()" % escape(e.alias or e.name)
    return "%s<br>%s" % (title, escape("%s %s()" % (e.ret, e.name)))


def to_drawio(model):
    """渲染整张图为 .drawio 文本。会**就地修改** model 的坐标。

    发射顺序：容器 -> 节点 -> 边。顺序本身不重要（每个 cell 自带 id），
    但排序键统一用 ``e.id``，这样输出与 dict 的插入顺序无关、可复现。
    """
    _assign_default_positions(model)

    groups = {}
    for kind, e in _entities(model):
        groups.setdefault(e.group or "misc", []).append(e)

    # 容器 id 与原点：节点坐标在 XML 里是**相对父容器**的，所以处处要减去 origin
    gid = {g: "grp%d" % (i + 1) for i, g in enumerate(sorted(groups))}
    origin = {}
    boxes = {}
    for g in sorted(groups):
        boxes[g] = _container_box(groups[g])
        origin[g] = boxes[g][:2]

    cell_id = {}
    for i, (kind, e) in enumerate(sorted(_entities(model), key=lambda t: t[1].id)):
        cell_id[e.id] = "n%d" % (i + 1)

    out = []
    for g in sorted(groups):
        ox, oy, ow, oh = boxes[g]
        out.append(
            '        <mxCell id="%s" value="%s" style="%s" vertex="1" parent="1">\n'
            '          <mxGeometry x="%s" y="%s" width="%s" height="%s" as="geometry" />\n'
            "        </mxCell>\n"
            % (gid[g], escape(g), CONT_STYLE, _num(ox), _num(oy), _num(ow), _num(oh))
        )

    for kind, e in sorted(_entities(model), key=lambda t: t[1].id):
        ox, oy = origin[e.group or "misc"]
        style = (
            SIGNAL_DIR_STYLE.get(getattr(e, "dir", ""), SIGNAL_STYLE)
            if kind == "signal"
            else (FUNC_EXT_STYLE if e.external else FUNC_STYLE)
        )
        # symbolId 是 drawcode 的身份标识，read_layout 只认它；其余属性是回读时
        # 用来还原 IR 的元数据（alias/note/器件信息等）
        pairs = [("id", cell_id[e.id]), ("label", _node_label(kind, e)), ("symbolId", e.id), ("kind", kind)]
        if kind == "signal":
            pairs += [("ctype", e.ctype), ("dir", e.dir), ("unit", e.unit), ("alias", e.alias), ("note", e.note)]
        else:
            pairs += [("ret", e.ret), ("alias", e.alias), ("note", e.note), ("tooltip", e.tooltip), ("asset", e.asset)]
            dev = model.devices.get(e.id)
            if dev:
                pairs += [("vendor", dev.vendor), ("model", dev.model), ("spec", dev.spec), ("size", dev.size)]
        out.append(
            "        <object %s>\n"
            '          <mxCell style="%s" vertex="1" parent="%s">\n'
            '            <mxGeometry x="%s" y="%s" width="%s" height="%s" as="geometry" />\n'
            "          </mxCell>\n"
            "        </object>\n"
            % (
                _attrs(pairs),
                style,
                gid[e.group or "misc"],
                _num(e.x - ox),
                _num(e.y - oy),
                _num(e.w),
                _num(e.h),
            )
        )

    for i, e in enumerate(sorted(model.edges, key=_edge_key)):
        src_group = model.signals[e.src].group if e.src in model.signals else model.funcs[e.src].group
        dst_group = model.signals[e.dst].group if e.dst in model.signals else model.funcs[e.dst].group
        # 同容器内的边挂在该容器下（坐标相对容器），跨容器的边挂在根下（坐标绝对）
        parent = gid[src_group] if src_group == dst_group else "1"
        ox, oy = origin.get(src_group, (0, 0)) if parent != "1" else (0, 0)
        style = EDGE_STYLE
        waypoints = list(e.waypoints)
        if not waypoints:
            # 没有人工拐点才自动路由。人工拖过的边保持原样，不覆盖用户的选择。
            avoid = [(o.x, o.y, o.w, o.h) for _, o in _entities(model)]
            gap = _cross_gap(boxes[src_group], boxes[dst_group]) if parent == "1" else None
            anchors, waypoints = _route_edge(model, e, avoid, gap)
            if anchors is not None:
                # 锚点写进 style，draw.io 才会把线精确地贴在指定边的指定位置上
                style += ANCHOR_STYLE % tuple(_num(v) for v in anchors)

        pairs = [
            ("id", "e%d" % (i + 1)),
            ("label", e.rw),
            ("rel", "def-use"),
            ("src", e.src),
            ("dst", e.dst),
            ("rw", e.rw),
        ]
        if waypoints:
            pts = "".join(
                '\n              <mxPoint x="%s" y="%s" />' % (_num(px - ox), _num(py - oy))
                for px, py in waypoints
            )
            geom = (
                '<mxGeometry relative="1" as="geometry">\n            '
                '<Array as="points">%s\n            </Array>\n          </mxGeometry>'
                % pts
            )
        else:
            geom = '<mxGeometry relative="1" as="geometry" />'
        out.append(
            "        <object %s>\n"
            '          <mxCell style="%s" edge="1" parent="%s" source="%s" target="%s">\n'
            "            %s\n"
            "          </mxCell>\n"
            "        </object>\n"
            % (_attrs(pairs), style, parent, cell_id[e.src], cell_id[e.dst], geom)
        )

    return (
        '<mxfile host="app.diagrams.net" agent="drawcode" type="device">\n'
        '  <diagram id="drawcode" name="dataflow">\n'
        '    <mxGraphModel adaptiveColors="auto" dx="1200" dy="800" grid="1" gridSize="10" '
        'guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        'pageWidth="1169" pageHeight="826" math="0" shadow="0">\n'
        "      <root>\n"
        '        <mxCell id="0" />\n'
        '        <mxCell id="1" parent="0" />\n'
        "%s"
        "      </root>\n"
        "    </mxGraphModel>\n"
        "  </diagram>\n"
        "</mxfile>\n" % "".join(out)
    )


def _decompress(data):
    """draw.io 压缩态的**唯一正确解码链**，顺序不能颠倒：

        base64 解码  ->  raw deflate 解压  ->  URL 解码  ->  XML 文本

    即编码时是 ``base64(deflate(urlencode(xml)))``。注意 URL 解码在**最后**一步：
    解压出来的是 ``%3CmxGraphModel%20…`` 这样的百分号编码串，还要再解一次才是 XML。
    把这两步顺序写反（先 URL 解码再 base64）在本工具自己生成的样本上也能"工作"，
    但读真实 draw.io 文件会直接解不出来——这是个很隐蔽的坑。
    """
    return urllib.parse.unquote(zlib.decompress(base64.b64decode(data), -15).decode("utf-8"))


def _unpack(xml):
    """draw.io 保存时默认把 <mxGraphModel> 压成 <diagram> 的文本串。

    未压缩形态（<diagram> 下直接挂 <mxGraphModel> 子元素）原样返回；压缩形态就地展开，
    使 read_layout 对两种形态等价。解压失败时抛 ValueError，而不是静默返回空布局
    —— 静默会让人工排版被无声丢弃。
    """
    root = ET.fromstring(xml)
    for diagram in root.iter("diagram"):
        if diagram.find("mxGraphModel") is not None:
            continue
        text = (diagram.text or "").strip()
        if not text:
            continue
        try:
            model = ET.fromstring(_decompress(text))
        except Exception as exc:
            # 一定要抛：返回空布局的话，调用方会以为"这个文件没有排版"，
            # 于是把用户的排版整个覆盖掉，而且全程不报错。
            raise ValueError(
                "<diagram> 既不是 <mxGraphModel> 子元素，也不是可识别的 draw.io 压缩串: %s" % exc
            )
        for child in list(diagram):
            diagram.remove(child)
        diagram.text = None
        diagram.append(model)
    return root


def _load_cells(xml):
    """把 XML 里的 cell 摊平成一个 id -> 信息 的表，两类都收：

      <object symbolId="…">  —— drawcode 写的节点/边，带 symbolId
      裸 <mxCell>            —— draw.io 自己的东西（容器、手画图形）

    后者同样收进来，是为了 _origin() 能顺着 parent 链把容器偏移累加出来；
    但它们 symbolId 为 None，read_layout 会把它们过滤掉。
    """
    root = _unpack(xml)
    cells = {}
    for el in root.iter():
        if el.tag == "object":
            inner = el.find("mxCell")
            if inner is None:
                continue
            cells[el.get("id")] = {
                "el": el,
                "cell": inner,
                "parent": inner.get("parent"),
                "symbolId": el.get("symbolId"),
                "src_cell": inner.get("source"),
                "dst_cell": inner.get("target"),
                "rw": el.get("rw"),
                "edge": inner.get("edge") == "1",
            }
        elif el.tag == "mxCell" and el.get("id") not in (None, "0", "1"):
            # 0/1 是 draw.io 的根 cell，跳过
            cells[el.get("id")] = {
                "el": el,
                "cell": el,
                "parent": el.get("parent"),
                "symbolId": None,
                "src_cell": el.get("source"),
                "dst_cell": el.get("target"),
                "rw": None,
                "edge": el.get("edge") == "1",
            }
    return cells


def _origin(cells, cid):
    """沿 parent 链累加容器偏移，把相对坐标还原成绝对坐标。

    ``seen`` 是防御性的：畸形文件里 parent 成环会死循环，撞到环就停。
    """
    x = y = 0.0
    seen = set()
    while cid and cid not in ("0", "1") and cid in cells and cid not in seen:
        seen.add(cid)
        geom = cells[cid]["cell"].find("mxGeometry")
        if geom is not None:
            x += float(geom.get("x") or 0)
            y += float(geom.get("y") or 0)
        cid = cells[cid]["parent"]
    return x, y


def read_layout(xml):
    """读出人工排版：节点坐标、节点属性（attrs）、边的拐点。

    **只认带 symbolId 的元素**，所以：

      * 手工在 draw.io 里画的图 —— 一个 symbolId 都没有，三个返回值全空。
        这是**正确的**：那种图没有 drawcode 的节点身份，本来就无法当作排版来源。
        调用方（CLI）会因此报错而不是静默继续，见 cli.py 的 --layout-from 守卫。
      * 容器等裸 mxCell —— 天然被忽略，不会污染 IR。
    """
    cells = _load_cells(xml)
    nodes, edges, attrs = {}, {}, {}
    for cid, info in cells.items():
        if info["edge"] or not info["symbolId"]:
            continue
        attrs[info["symbolId"]] = {
            k: v for k, v in info["el"].attrib.items() if k not in ("id", "label", "symbolId")
        }
    for cid, info in cells.items():
        if info["edge"]:
            continue
        geom = info["cell"].find("mxGeometry")
        ox, oy = _origin(cells, info["parent"])
        if info["symbolId"]:
            if geom is not None:
                nodes[info["symbolId"]] = (
                    float(geom.get("x") or 0) + ox,
                    float(geom.get("y") or 0) + oy,
                    float(geom.get("width") or 0),
                    float(geom.get("height") or 0),
                )
    for cid, info in cells.items():
        if not info["edge"] or info["src_cell"] is None:
            continue
        # 边的两端也必须是 drawcode 节点；连到手工图形上的边直接跳过
        src = cells.get(info["src_cell"], {}).get("symbolId")
        dst = cells.get(info["dst_cell"], {}).get("symbolId")
        if not src or not dst:
            continue
        ox, oy = _origin(cells, info["parent"])
        pts = []
        geom = info["cell"].find("mxGeometry")
        if geom is not None:
            arr = geom.find("Array")
            if arr is not None:
                for p in arr.findall("mxPoint"):
                    pts.append((float(p.get("x") or 0) + ox, float(p.get("y") or 0) + oy))
        edges["%s->%s:%s" % (src, dst, info["rw"] or "read")] = pts
    return {"nodes": nodes, "edges": edges, "attrs": attrs}


def apply_layout(model, layout):
    """把读出来的排版套回 IR。

    这里有一处**必须理解**的处理（末尾那个 ``if e.waypoints == auto.get(key)``）：

    回读时无法区分「人工拖出来的拐点」和「上次自动算出来的拐点」——两者在文件里
    长得一模一样。做法是：先按当前坐标把所有边自动算一遍（``_auto_waypoints``），
    凡是与自动值相等的，就认定它只是上次生成的产物，**丢弃不算人工编辑**，让本轮
    重新路由。否则只要用户挪动过一次节点，上一轮的拐点就会被当成"用户的选择"
    永久锁死，线再也绕不回来。
    """
    for sid, (x, y, w, h) in layout.get("nodes", {}).items():
        ent = model.signals.get(sid) or model.funcs.get(sid)
        if ent is None:
            continue
        ent.x, ent.y, ent.w, ent.h = x, y, w, h
    # 属性（alias/unit/note/tooltip/dir）也从图里回灌，这样在 draw.io 里改的
    # 文字说明能通过 sync 落回源码
    for sid, props in layout.get("attrs", {}).items():
        ent = model.signals.get(sid) or model.funcs.get(sid)
        if ent is None:
            continue
        for key in ("alias", "unit", "note", "tooltip"):
            if key in props and hasattr(ent, key):
                setattr(ent, key, props[key])
        if sid in model.signals and props.get("dir") in ("in", "out", "inout"):
            model.signals[sid].dir = props["dir"]
    auto = _auto_waypoints(model)
    for e in model.edges:
        key = _edge_key(e)
        if key in layout.get("edges", {}):
            e.waypoints = layout["edges"][key]
            if e.waypoints == auto.get(key):
                # 与自动值相同 => 不是人工编辑，丢弃重算（见 docstring）
                e.waypoints = []
    return model

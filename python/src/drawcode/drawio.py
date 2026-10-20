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
import math
import re
import urllib.parse
import xml.etree.ElementTree as ET
import zlib
from html import escape

from .model import PinnedGeom

PAD = 30
HEADER = 30
NODE_W, NODE_H = 160, 60
GAP_Y = 40

SIGNAL_STYLE = "shape=ellipse;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;"
FUNC_STYLE = "rounded=1;whiteSpace=wrap;html=1;fillColor=#ffe6cc;strokeColor=#d79b00;"
FUNC_EXT_STYLE = "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#666666;"
CONT_STYLE = "swimlane;startSize=%d;collapsible=0;recursiveResize=0;fillColor=#dae8fc;strokeColor=#6c8ebf;html=1;" % HEADER
EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;jumpStyle=arc;jumpSize=6;"
# `--straight-edges` 用的边样式：draw.io 的「直线」连接。
#
# `edgeStyle=none` 是 draw.io 里 Straight 的写法 —— 不跑布线，直接用直线连
# exit 点到 entry 点。三件事必须同时去掉：`edgeStyle=orthogonalEdgeStyle`
# （不清掉它，draw.io 会自己再算一遍正交走线，线照样是弯的）、`rounded=1`
# （没有拐角）、`jumpStyle/jumpSize`（直线不产生跨线）。exit*/entry* 锚点保留：
# 它们决定线从节点的哪条边出发，与怎么走无关。
STRAIGHT_EDGE_STYLE = "edgeStyle=none;html=1;"
# 被推开的边标签用的**子单元格**样式。`points=[]` 是 draw.io 拖动标签时连带写下的
# 一对空控制点，别删 —— 删了 draw.io 打开时会自己补回来，文件每次打开都变脏。
EDGE_LABEL_STYLE = "edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];"
ANCHOR_STYLE = "exitX=%s;exitY=%s;exitDx=0;exitDy=0;entryX=%s;entryY=%s;entryDx=0;entryDy=0;"

# `[Callout]` 的三种视觉：无边框文字 / 带底色说明框 / 大片分区带。
CALLOUT_FILL = {"text": "none", "box": "#fff2cc", "band": "#f5f5f5"}
CALLOUT_STROKE = {"text": "none", "box": "#d6b656", "band": "#b3b3b3"}
CALLOUT_FONT = {"text": 12, "box": 12, "band": 15}

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

    NaN / ±Infinity 显式处理：几何键是**不校验**的（见 cparse._js_number），
    畸形坐标会一路流到这里。旧版对 NaN 调 int() 会抛 ValueError，而 TS 版输出
    "nan" 照常出图 —— 两个实现的分叉必须在这里合上。字面量与 TS num.ts 的
    reprFloat 一致（小写 nan/inf，带符号 -inf）。
    """
    v = float(v)
    if v != v:
        return "nan"
    if v == float("inf"):
        return "inf"
    if v == float("-inf"):
        return "-inf"
    return str(int(v)) if v == int(v) else repr(v)


def _attrs(pairs):
    return " ".join(
        '%s="%s"' % (k, escape(str(v), quote=True)) for k, v in pairs if v not in (None, "")
    )


def _entities(model):
    """信号和函数都算「实体」——它们在画布上的待遇一致，都会被画成一个节点。

    被 `--inline` 折叠成直连边的信号**不出现**：它已经变成那根线上的标签，
    再画一个空椭圆就是个既没有入边也没有出边的悬空节点。布局与容器包围盒都基于
    本函数，所以跳过之后折叠信号也不再占位置。
    """
    out = []
    for s in model.signals.values():
        if s.id in model.inlined:
            continue
        out.append(("signal", s))
    for f in model.funcs.values():
        out.append(("func", f))
    return out


def _func_image_style(asset):
    """设备卡片：节点本身就是一张图，名字作为标签贴在图的下方。

    用 `shape=image` 而不是「矩形 + image=…」：后者那套键只有 draw.io 自己的
    渲染路径认，核心 mxGraph 的矩形形状完全不看它 —— 离线渲染器一张图都不出。
    代价是图片占满节点框，文字只能落到框外，想在图里写说明请用 Callout。
    """
    return (
        "shape=image;imageAspect=0;"
        "image=%s;"
        "verticalLabelPosition=bottom;verticalAlign=top;html=1;fontSize=13;fontStyle=1;"
    ) % asset


def _callout_style(c):
    """文字块的样式串。

    `text;` 是 draw.io 的命名样式（无边框纯文本），离线渲染器认不出这个裸段、
    会静默丢掉它，所以同时把 strokeColor/fillColor 显式写成 none —— 两条渲染
    路径的结果都是一个无边框文本框。刻意不用 `shape=note`：它不在 mxCellRenderer
    的默认形状表里，离线渲染会退回矩形。
    """
    fill = CALLOUT_FILL.get(c.shape, "none")
    stroke = CALLOUT_STROKE.get(c.shape, "none")
    size = c.font_size if c.font_size > 0 else CALLOUT_FONT.get(c.shape, 12)
    base = "text;" if c.shape == "text" else "rounded=1;"
    dashed = "dashed=1;" if c.shape == "band" else ""
    return (
        "%swhiteSpace=wrap;html=1;strokeColor=%s;fillColor=%s;%s"
        "align=left;verticalAlign=top;fontSize=%s;spacingLeft=8;spacingTop=6;"
        % (base, stroke, fill, dashed, _num(size))
    )


def _edge_key(e):
    """边的稳定键。读写 layout 都靠它配对，所以 src/dst/rw 三者缺一不可。"""
    return "%s->%s:%s" % (e.src, e.dst, e.rw)


_ANCHOR_RE = re.compile(
    r"exitX=([\d.-]+);exitY=([\d.-]+);exitDx=[\d.-]+;exitDy=[\d.-]+;"
    r"entryX=([\d.-]+);entryY=([\d.-]+);"
)
# 中日韩/全角字符占一个字宽，拉丁字母约 0.58 个字宽。范围与 TS 的 textWidth 相同：
# U+2E80–U+9FFF、U+3000–U+303F、U+FF00–U+FFEF。
_CJK_RE = re.compile("[⺀-鿿　-〿＀-￯]")


def _style_anchor(style):
    """从样式串里取回 exit*/entry* 锚点；没有则 None。

    走 `--layout-from` 拿到人工拐点的边不会重新路由，没有本次路由的锚点可依，
    于是退到样式串里记着的那个，再退到默认左右中点 —— 去叠印只需要一个够用的近似。
    """
    m = _ANCHOR_RE.search(style)
    if m is None:
        return None
    return tuple(float(m.group(i)) for i in (1, 2, 3, 4))


def _text_width(label, font):
    """一行文字大概占多宽：中日韩/全角一个字一格，拉丁字母半个多格。"""
    return sum(font if _CJK_RE.match(ch) else font * 0.58 for ch in label)


LABEL_LANE = 17
LABEL_FONT = 12


def _mid_and_normal(pts):
    """折线的**弧长中点**，以及中点处的单位法线。

    为什么是弧长中点：draw.io 把边的文字放在那儿（从渲染结果反推的）。用欧氏
    长度，不能用曼哈顿长度 —— 折了弯以后两者差半个身位。法线只在去叠印时用。
    """
    if not pts:
        return (0.0, 0.0), (0.0, -1.0)
    segs = []
    total = 0.0
    for i in range(len(pts) - 1):
        p, q = pts[i], pts[i + 1]
        d = math.hypot(q[0] - p[0], q[1] - p[1])
        segs.append(d)
        total += d
    if total == 0:
        return pts[0], (0.0, -1.0)

    acc = 0.0
    for i, seg in enumerate(segs):
        if acc + seg >= total / 2.0:
            p, q = pts[i], pts[i + 1]
            t = 0.0 if seg == 0 else (total / 2.0 - acc) / seg
            dx, dy = q[0] - p[0], q[1] - p[1]
            length = math.hypot(dx, dy) or 1.0
            return (p[0] + dx * t, p[1] + dy * t), (-dy / length, dx / length)
        acc += seg
    return pts[-1], (0.0, -1.0)


def _label_box(anchor, label):
    """标签文字的估算占位盒 ``(x, y, w, h)``，**以落点为中心**。

    渲染件里标签是 text-anchor="middle"，落点是文字中心而不是左边缘。宽度按
    字数估：中日韩一个字一格、拉丁字母 0.58 格（略宽于实测，宁可多判一处）。
    """
    w = _text_width(label, LABEL_FONT)
    h = LABEL_FONT * 1.4
    return (anchor[0] - w / 2.0, anchor[1] - h / 2.0, w, h)


def _boxes_clash(a, b):
    """两个占位盒是否真的压在一起（留 2 像素容差，贴边不算撞）。"""
    return (
        a[0] < b[0] + b[2] - 2 and b[0] < a[0] + a[2] - 2
        and a[1] < b[1] + b[3] and b[1] < a[1] + a[3]
    )


def _overlaps_y(a, b):
    """两个盒子在竖直方向是否还有重叠（横向不参与 —— 只用来判「错开」）。"""
    return a[1] < b[1] + b[3] and b[1] < a[1] + a[3]


def _lane_shift(lane):
    """格号 -> 竖直方向的格数。0 格不动，其余按 +1、-1、+2… 交替（下、上、下下…），
    免得几条标签一起往同一边推、推出画布。"""
    if lane == 0:
        return 0
    return (1 if lane % 2 == 1 else -1) * math.ceil(lane / 2.0)


def separate_labels(boxes, lane):
    """把**压在一起**的标签推开，返回每条在 **y 方向**上的位移。

    没撞的都是 0；**正数向下、负数向上**，调用方直接写进 `as="offset"` 的 y。
    为什么必须处理：`--inline` 把一写一读的信号折成直连边后，同一对节点之间的
    几条边会走到同一条折线上（锚点都取边中点），标签叠印在同一点。

    算法三步：
      1. 占位盒相交就把两条连起来，取**连通分量** —— 甲撞乙、乙撞丙而甲丙不撞时，
         三条仍得各占一个位置；
      2. 团内按传入次序编号，第 1 条不动（没有叠印的图产物逐字节不变），其余按
         +1、-1、+2… 交替试格；
      3. 试格判据不是「格号够不够」而是「与已落位的每一条都错开」——两条标签本
         来就可能差 6 像素，固定推 17 像素会过冲，落到另一侧仍叠着。
    """
    out = [0.0] * len(boxes)
    parent = list(range(len(boxes)))

    def find(x):
        r = x
        while parent[r] != r:
            r = parent[r]
        c = x
        while parent[c] != r:
            nxt = parent[c]
            parent[c] = r
            c = nxt
        return r

    for i, a in enumerate(boxes):
        if a is None:
            continue
        for j in range(i):
            b = boxes[j]
            if b is None or not _boxes_clash(a, b):
                continue
            parent[find(i)] = find(j)

    groups = {}
    for i, box in enumerate(boxes):
        if box is None:
            continue
        groups.setdefault(find(i), []).append(i)

    for members in groups.values():
        if len(members) < 2:
            continue
        placed = []
        for k, idx in enumerate(members):
            box = boxes[idx]
            if k == 0:
                placed.append(box)
                continue
            step = 1
            while True:
                shift = _lane_shift(step) * lane
                moved = (box[0], box[1] + shift, box[2], box[3])
                if all(p is None or not _overlaps_y(moved, p) for p in placed):
                    out[idx] = shift
                    placed.append(moved)
                    break
                step += 1
    return out


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


def _all_members(nodes, path):
    """一个容器及其所有子孙的成员，展开成一维列表。"""
    out = list(nodes[path]["members"])
    for child in nodes[path]["children"]:
        out.extend(_all_members(nodes, child))
    return out


def _assign_default_positions(model):
    """给没坐标的实体排初始位；顶层容器之间做水平避让，保证不互相压住。

    ``if e.x == 0 and e.y == 0`` 是「这个节点还没有坐标」的约定——所以原点处的节点
    会被当成未定位并重新排布。带着人工坐标（``@drawcode xy="…"``）的节点不受影响。

    容器层级来自 ``path``：没有斜杠的源码每棵树只有一层，此时结果与老版本完全一致。
    """
    nodes = _container_tree(model)
    tops = sorted(p for p in nodes if "/" not in p)

    right_edge = None
    for gname in tops:
        _layout_tree(nodes, gname, PAD, PAD + HEADER + PAD)
        members = _all_members(nodes, gname)
        # 若这一棵树比已排好的往左，就整棵右移，避免两个顶层容器水平重叠
        box = _container_box(members)
        if right_edge is not None and box[0] < right_edge:
            dx = right_edge - box[0]
            for e in members:
                e.x += dx
            box = _container_box(members)
        right_edge = box[0] + box[2] + 4 * PAD


def _container_box(members):
    """容器的包围盒。节点尺寸已经含了尖角，不需要再为方向记号留余量。"""
    if not members:
        # 中间容器（`a/b/c` 里的 `b`）只有子容器、没有直属成员，会走到这里。
        return 0.0, 0.0, 0.0, 0.0
    xs = [e.x for e in members]
    ys = [e.y for e in members]
    x2 = [e.x + e.w for e in members]
    y2 = [e.y + e.h for e in members]
    ox, oy = min(xs) - PAD, min(ys) - PAD - HEADER
    ow = max(x2) - min(xs) + 2 * PAD
    oh = max(y2) - min(ys) + 2 * PAD + HEADER
    return ox, oy, ow, oh


def _entity_path(e):
    """实体的容器路径。

    `path` 是完整层级（`adc/采样`），`group` 是它的第一段。老实体只填了 group，
    所以这里退回 group；两者都空才落到 `misc`。解析器保证 path 非空，
    这个兜底是给手工构造的 model 用的。
    """
    return getattr(e, "path", "") or e.group or "misc"


def _container_tree(model):
    """从所有实体的 path 推出容器树。

    返回 ``{path: {"members": [...], "children": [child_path, ...]}}``。
    中间层级即使没有直属成员也会被建出来 —— ``path="adc/采样"`` 里那个 `adc`
    必须存在，否则子容器会没有父框可挂。
    """
    nodes = {}
    for _, e in _entities(model):
        parts = _entity_path(e).split("/")
        for i in range(len(parts)):
            nodes.setdefault("/".join(parts[: i + 1]), {"members": [], "children": []})
        nodes["/".join(parts)]["members"].append(e)
    for p in list(nodes):
        if "/" in p:
            parent = p.rsplit("/", 1)[0]
            if p not in nodes[parent]["children"]:
                nodes[parent]["children"].append(p)
    return nodes


def _stack(members, x_left, y_top):
    """把一组实体在给定左上角垂直堆叠，返回它们的包围盒。"""
    y = y_top
    for e in members:
        if e.x == 0 and e.y == 0:
            e.x, e.y = x_left, y
        y += e.h + GAP_Y
    return _container_box(members)


def _subtree_members(nodes, path):
    """一个容器子树里的全部实体（含各级子容器的）。"""
    out = list(nodes[path]["members"])
    for child in nodes[path]["children"]:
        out.extend(_subtree_members(nodes, child))
    return out


def _layout_tree(nodes, path, x_left, y_top):
    """递归排布一个容器：子容器各成一块，直属成员另成一块，横向依次摆开。

    单层容器（没有子容器）时，这就退化成「成员垂直堆叠」——与老行为完全一致，
    所以没有任何 ``path=`` 的源码产物逐字节不变。
    """
    node = nodes[path]
    own = sorted(node["members"], key=lambda e: (_dir_rank(e), e.id))

    # 块宽必须按**整棵子树**算。中间容器（`a/b/c` 里的 `b`）自己没有直属成员，
    # 若只看它的 members，宽度是 0 → 游标不前进 → 几棵子树叠在一起。
    blocks = []
    for child in sorted(node["children"]):
        _layout_tree(nodes, child, 0.0, 0.0)
        members = _subtree_members(nodes, child)
        if members:
            blocks.append(members)
    if own:
        blocks.append(own)

    if not blocks:
        return None

    # 游标走的是**块左边界**（和 _container_box 同一基准），不是成员坐标 ——
    # 早先把成员坐标 x_left 和包围盒左边界 box[0] 拿来比较，两者差一个 PAD，
    # 于是永远判定"需要平移"，把整块又推了 30。
    cursor = x_left
    for members in blocks:
        if members is own:
            _stack(members, cursor, y_top)
        else:
            # 子容器已经在局部坐标系里排好了，整体平移到游标即可 ——
            # 它的子容器也在这份 members 里，所以会跟着一起走。
            box = _container_box(members)
            dx = cursor - box[0]
            for e in members:
                e.x += dx
        box = _container_box(members)
        cursor = box[0] + box[2] + 2 * PAD + PAD

    return _container_box([e for members in blocks for e in members])


def _node_label(kind, e, cards=False):
    """节点上显示的两行 HTML：主标题 + 元信息行。

    cards=True 时设备卡片只显示一行标题：图片已经占满节点框，第二行会压到图上。
    """
    if kind == "signal":
        bits = [b for b in (e.ctype, e.dir, e.unit) if b]
        return "%s<br>%s" % (escape(e.name), escape(" / ".join(bits)))
    if cards and e.asset:
        return escape(e.alias or e.name)
    title = "%s()" % escape(e.alias or e.name)
    return "%s<br>%s" % (title, escape("%s %s()" % (e.ret, e.name)))


def _inline_edge_label(model, e, rw_labels):
    """直连边上的可见文本。

    用信号的 ``unit``（中文语义名）而不是 ``alias``：后者带 `a5` 这类编号，挂在
    线上会把线挤满。另一端是真节点（信号没被折掉）时，线上写 `read`/`write` ——
    它和箭头方向完全同义（箭头指着谁，谁的视角就是 read），纯冗余。设备总览那种
    几十条边的图上会把图面糊死，所以 `--no-rw-labels` 把这一类标签去掉。
    """
    if not e.sig:
        return e.rw if rw_labels else ""
    signal = model.signals.get(e.sig)
    if signal is None:
        return e.rw if rw_labels else ""
    return escape(signal.unit if signal.unit != "" else signal.name)


def _callout_attrs(c, i):
    """一个文字块的 `<object>` 属性表。

    label 原样交给 ``_attrs``（只转义一遍）：`<br>` 在文件里成为 `&lt;br&gt;`，
    XML 读回即 `<br>`，draw.io 按 html=1 换行。若先 escape 一遍，文件里会变成
    `&amp;lt;br&amp;gt;`，读回来是**字面量** `&lt;br&gt;`，图上显示成七个字符。
    """
    return [
        ("id", "co%d" % (i + 1)),
        ("label", c.text),
        ("symbolId", c.id),
        ("kind", "callout"),
        ("owner", c.owner),
    ]


def to_drawio(model, cards=False, rw_labels=True, straight_edges=False):
    """渲染整张图为 .drawio 文本。会**就地修改** model 的坐标。

    发射顺序：分区带 -> 容器 -> 节点 -> 说明文字 -> 边（边另带被推开的标签）。
    顺序不是随意的：

      * band 必须写在容器**之前**。draw.io 按文档顺序叠放，容器连同整棵子树一起
        画；band 是根的直接子节点，排在容器后面就会落在整棵子树上面、把卡片全盖住。
      * box / text 写在节点之后 —— 它们本来就该压在卡片上面。
      * 边分两趟：先算走法与标签落点，再写 XML。第二趟才写是去叠印逼出来的：
        落点和**所有**边比过之后，才知道哪几条标签叠在一起。

    三个开关都带默认值，所以不传新参数时产物与旧版逐字节相同。
    """
    _assign_default_positions(model)

    nodes = _container_tree(model)
    paths = sorted(nodes)

    # 容器 id 与原点：节点坐标在 XML 里是**相对父容器**的，所以处处要减去父的原点。
    # 顶层容器没有父，原点就是根 (0,0) —— 单层源码因此与老版本逐位相同。
    gid = {p: "grp%d" % (i + 1) for i, p in enumerate(paths)}
    boxes = {p: _container_box(_all_members(nodes, p)) for p in paths}

    def _parent_path(p):
        return p.rsplit("/", 1)[0] if "/" in p else None

    def _origin_of(p):
        """容器自己的原点 —— 它的几何是相对**父容器**写的。"""
        pp = _parent_path(p)
        return boxes[pp][:2] if pp else (0.0, 0.0)

    ents = sorted(_entities(model), key=lambda t: t[1].id)
    cell_id = {}
    for i, (kind, e) in enumerate(ents):
        cell_id[e.id] = "n%d" % (i + 1)

    out = []

    def emit_callouts(want):
        """发射一类文字块。它们挂在根 parent="1" 下、用画布绝对坐标。

        文字块不属于任何容器（见 model.Callout），所以不做容器偏移，也不参与
        _container_box。`want` 取 "band" 或 "text"：band 在容器前发，其余在节点后发。
        """
        for i, c in enumerate(model.callouts):
            is_band = c.shape == "band"
            if is_band != (want == "band"):
                continue
            out.append(
                "        <object %s>\n"
                '          <mxCell style="%s" vertex="1" parent="1">\n'
                '            <mxGeometry x="%s" y="%s" width="%s" height="%s" as="geometry" />\n'
                "          </mxCell>\n"
                "        </object>\n"
                % (
                    _attrs(_callout_attrs(c, i)),
                    _callout_style(c),
                    _num(c.x),
                    _num(c.y),
                    _num(c.w),
                    _num(c.h),
                )
            )

    emit_callouts("band")

    for p in paths:
        ox, oy, ow, oh = boxes[p]
        pox, poy = _origin_of(p)
        pp = _parent_path(p)
        out.append(
            '        <mxCell id="%s" value="%s" style="%s" vertex="1" parent="%s">\n'
            '          <mxGeometry x="%s" y="%s" width="%s" height="%s" as="geometry" />\n'
            "        </mxCell>\n"
            % (
                gid[p],
                escape(p.rsplit("/", 1)[-1]),
                CONT_STYLE,
                gid[pp] if pp else "1",
                _num(ox - pox),
                _num(oy - poy),
                _num(ow),
                _num(oh),
            )
        )

    for kind, e in ents:
        epath = _entity_path(e)
        # 节点相对**自己的容器**，不是父容器 —— 这和容器的相对基准不同，别合并
        ox, oy = boxes[epath][:2]
        # `style` 原样追加在样式串末尾（角色分色这类装饰）。空串等于没追加，
        # 所以不写 Style 的源码产物逐字节不变。
        if kind == "signal":
            style = SIGNAL_DIR_STYLE.get(getattr(e, "dir", ""), SIGNAL_STYLE) + e.style
        elif cards and e.asset:
            style = _func_image_style(e.asset) + e.style
        else:
            style = (FUNC_EXT_STYLE if e.external else FUNC_STYLE) + e.style
        # symbolId 是 drawcode 的身份标识，read_layout 只认它；其余属性是回读时
        # 用来还原 IR 的元数据（alias/note/器件信息等）
        pairs = [("id", cell_id[e.id]), ("label", _node_label(kind, e, cards)), ("symbolId", e.id), ("kind", kind)]
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
                gid[epath],
                _num(e.x - ox),
                _num(e.y - oy),
                _num(e.w),
                _num(e.h),
            )
        )

    emit_callouts("text")

    # 第一趟：算走法、标签落点与几何。
    laid = []
    for i, e in enumerate(sorted(model.edges, key=_edge_key)):
        src_ent = model.signals.get(e.src) or model.funcs.get(e.src)
        dst_ent = model.signals.get(e.dst) or model.funcs.get(e.dst)
        src_path = _entity_path(src_ent) if src_ent is not None else "misc"
        dst_path = _entity_path(dst_ent) if dst_ent is not None else "misc"
        # 同容器内的边挂在该容器下（坐标相对容器），跨容器的边挂在根下（坐标绝对）
        parent = gid[src_path] if src_path == dst_path else "1"
        ox, oy = boxes[src_path][:2] if parent != "1" else (0, 0)

        style = STRAIGHT_EDGE_STYLE if straight_edges else EDGE_STYLE
        # 内联边的颜色跟着它折叠掉的那个信号走：信号上的 Style 片段本来是给节点
        # 用的，节点没了，这个片段就落到线上 —— 否则「按关系性质分色」就没有落点。
        if e.rw == "inline" and e.sig:
            signal = model.signals.get(e.sig)
            if signal is not None:
                style += signal.style

        anchors = None
        waypoints = list(e.waypoints)
        if not waypoints:
            avoid = [(o.x, o.y, o.w, o.h) for _, o in ents]
            gap = _cross_gap(boxes[src_path], boxes[dst_path]) if parent == "1" else None
            # 直线模式**只丢自动拐点**：--layout-from 里人工画上的拐点照样保留 ——
            # 那是人明确放上去的东西，不该被一个样式开关悄悄吞掉。
            # 拐点可以丢，锚点不能丢：它决定线贴着哪条边走，丢了 draw.io 会自己
            # 就近挑边，「左右相连」可能变成从上下出线。
            anchors, routed = _route_edge(model, e, avoid, gap)
            waypoints = [] if straight_edges else routed
            if anchors is not None:
                style += ANCHOR_STYLE % tuple(_num(v) for v in anchors)

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

        # 折线 = 出锚点 -> 拐点 -> 入锚点。走 --layout-from 拿到人工拐点的边没有
        # 锚点可依，退到样式串里记着的锚点，再退到默认左右中点（draw.io 自己的
        # 默认是「就近贴边框」，这里只是给去叠印一个够用的近似）。
        anchor_set = anchors or _style_anchor(style) or (1.0, 0.5, 0.0, 0.5)
        sp, dp = _endpoints(_rect(model, e.src), _rect(model, e.dst), anchor_set)
        anchor, normal = _mid_and_normal([sp] + list(waypoints) + [dp])
        laid.append({
            "i": i,
            "e": e,
            "style": style,
            "parent": parent,
            "geom": geom,
            "label": _inline_edge_label(model, e, rw_labels),
            "anchor": anchor,
            "normal": normal,
        })

    shifts = separate_labels(
        [None if x["label"] == "" else _label_box(x["anchor"], x["label"]) for x in laid],
        LABEL_LANE,
    )

    for le in laid:
        eid = "e%d" % (le["i"] + 1)
        shift = shifts[le["i"]]
        moved = shift != 0
        pairs = [
            ("id", eid),
            # 被推开的标签不再留在边上：draw.io 自己拖标签时就是把文字挪进子单元格，
            # 两处都留着会画两遍。
            ("label", "" if moved else le["label"]),
            ("rel", "def-use"),
            ("src", le["e"].src),
            ("dst", le["e"].dst),
            ("rw", le["e"].rw),
        ]
        # 折叠掉的信号 id 留在边上：回读与校验时才能把这根线还原回 a5 那样的编号
        if le["e"].sig:
            pairs.append(("sig", le["e"].sig))

        out.append(
            "        <object %s>\n"
            '          <mxCell style="%s" edge="1" parent="%s" source="%s" target="%s">\n'
            "            %s\n"
            "          </mxCell>\n"
            "        </object>\n"
            % (_attrs(pairs), le["style"], le["parent"], cell_id[le["e"].src], cell_id[le["e"].dst], le["geom"])
        )

        if not moved:
            continue
        # 位移写进 `<mxPoint as="offset">`，**不要**写进 mxGeometry 的 x/y。
        # mxGraphView.getPoint 里两条路的语义完全不同：
        #   - geometry.y 沿矢量 (dy/L, -dx/L) 位移 —— 永远垂直于那条边，方向随边的
        #     走向转：横边上是上下、竖边上就成了左右；
        #   - geometry.offset 直接加到点上 —— 全局坐标轴，与边走法无关。
        # 按下都推开了却横着散开（该叠的还是叠着），就是踩了第一条。
        # geometry.x=0 是沿边的相对位置（0 = 弧长中点），保持不动。
        out.append(
            '        <mxCell id="%s_label" value="%s" style="%s" vertex="1" connectable="0" parent="%s">\n'
            '          <mxGeometry x="0" y="0" relative="1" as="geometry">'
            '<mxPoint x="0" y="%s" as="offset" /></mxGeometry>\n'
            "        </mxCell>\n"
            % (eid, escape(le["label"], quote=True), EDGE_LABEL_STYLE, eid, _num(shift))
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


def read_layout(xml, include_foreign=False):
    """读出人工排版：节点坐标、节点属性（attrs）、边的拐点。

    **只认带 symbolId 的元素**，所以：

      * 手工在 draw.io 里画的图 —— 一个 symbolId 都没有，三个返回值全空。
        这是**正确的**：那种图没有 drawcode 的节点身份，本来就无法当作排版来源。
        调用方（CLI）会因此报错而不是静默继续，见 cli.py 的 --layout-from 守卫。
      * 容器等裸 mxCell —— 天然被忽略，不会污染 IR。

    ``include_foreign=True`` 时另外返回两项，供 ``adopt`` 把「用户在 draw.io 里
    新加的元素」接回 IR：

      ``containers`` —— 容器 cell id -> 容器名（= group 名 = 文件），用来判断
      新元素该落进哪个源文件；
      ``foreign``    —— 图里可见、但没有 drawcode 身份的顶点。默认不返回，
      因为绝大多数调用方（尤其 --layout-from）只关心既有节点。
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
    result = {"nodes": nodes, "edges": edges, "attrs": attrs}
    if include_foreign:
        containers = _containers(xml)
        result["containers"] = containers
        result["foreign"] = _foreign_cells(cells, containers)
    return result


def _containers(xml):
    """容器 cell id -> 容器名。容器名就是 group 名，也是它对应的源文件名（不含扩展名）。"""
    root = _unpack(xml)
    out = {}
    for el in root.iter("mxCell"):
        if el.get("vertex") == "1" and "swimlane" in (el.get("style") or ""):
            out[el.get("id")] = (el.get("value") or "").strip()
    return out


def _foreign_cells(cells, containers):
    """图里「能看见、但不是 drawcode 节点」的顶点。

    用户手工加元素有两种常见做法，两种都会落到这里：

      * 直接拖一个形状出来 —— 裸 mxCell，没有 symbolId；
      * 复制一个已有节点 —— 副本带着**同一个 symbolId**，于是被 _load_cells
        折叠到原节点上，表现为「图里多了一个但读回来没多」。

    这里按 cell id 收集，所以上面第二种情况仍然能被发现：副本的 cell id 是新的。
    """
    out = []
    for cid, info in cells.items():
        if info["edge"] or info["symbolId"]:
            continue
        if cid in containers:
            continue  # 容器本身就是 swimlane，不是用户新加的元素
        # **挂在边下面的单元格是标签，不是节点**：去叠印写出的子标签就长这样
        # （parent 指向那条边）。漏掉这一条，sync 会把每条被推开的标签都当成
        # 「用户在图上新加的节点」，往源码里写一个名叫「经局域网读取数据集」的函数。
        parent_info = cells.get(info["parent"])
        if parent_info is not None and parent_info["edge"]:
            continue
        geom = info["cell"].find("mxGeometry")
        if geom is None:
            continue
        el = info["el"]
        out.append(
            {
                "cell_id": cid,
                "label": (el.get("label") or el.get("value") or "").strip(),
                "style": info["cell"].get("style") or "",
                "parent": info["parent"],
                "container": containers.get(info["parent"], ""),
                "x": float(geom.get("x") or 0),
                "y": float(geom.get("y") or 0),
                "w": float(geom.get("width") or 0),
                "h": float(geom.get("height") or 0),
            }
        )
    return out


def _geometry_snapshot(model):
    """每个实体此刻的 ``(x, y, w, h)``。必须在跑过默认布局之后取。

    两个 map 都收：`_entities()` 会跳过被 inline 折叠的信号，而覆盖循环靠
    ``signals.get(sid) or funcs.get(sid)`` 命中实体 —— 两者的集合必须对齐，
    否则折叠过的信号在图上被拖了也记不进 pinned。
    """
    snap = {}
    for s in model.signals.values():
        snap[s.id] = (s.x, s.y, s.w, s.h)
    for f in model.funcs.values():
        snap[f.id] = (f.x, f.y, f.w, f.h)
    return snap


def _restore_geometry(model, snap):
    """把快照写回实体 —— 让「取基线」变成**非破坏性**的（见 apply_layout）。

    遍历实体侧而不是快照侧：快照是实体的子集，遍历实体能保证一个都不漏。
    """
    for s in model.signals.values():
        r = snap.get(s.id)
        if r is not None:
            s.x, s.y, s.w, s.h = r
    for f in model.funcs.values():
        r = snap.get(f.id)
        if r is not None:
            f.x, f.y, f.w, f.h = r


def _record_pinned(model, sid, base, read):
    """「读回值与基线不一致」→ 记进 model.pinned（要回写源码的人工排版意图）。

    用**精确不等**，不设浮点容差：坐标本来就是整数，容差只会把「只拖动了一两个
    像素」这种真实排版吞掉。xy 存的是**读回值**（绝对画布坐标）。
    """
    if base is None:
        return
    bx, by, bw, bh = base
    x, y, w, h = read
    geom = PinnedGeom()
    if x != bx or y != by:
        geom.xy = [x, y]
    if w != bw or h != bh:
        geom.size = [w, h]
    if geom.xy is not None or geom.size is not None:
        model.pinned[sid] = geom


def apply_layout(model, layout):
    """把读出来的排版套回 IR。

    这里有两处**必须理解**的处理：

    0. **基线**：先跑 assign_default_positions 摆好默认布局，再快照每个实体的
       (x,y,w,h) —— 这就是「build 本来会写进 .drawio 的几何」（源码声明的 xy/size
       优先，没声明则是默认布局值）。读出值偏离基线（精确不等）的实体记进
       model.pinned，供回写侧写进源码注解。判据为什么不是「与默认布局比」：一个
       节点在源码里**已经有** xy 时，坐标本来就与默认布局不同 —— 拿默认布局当
       基准，每次 sync 都会重写这个键，而 sync 的验收标准是「没人动过就零 diff」。

       取基线时多调了一次 assignDefaultPositions，但**跑完立刻把模型恢复原状**
       （live 快照 -> assignDefaultPositions -> base 快照 -> restoreGeometry）。
       这么绕是为了绕开实测出来的一个坑：assignDefaultPositions **不是固定点** ——
       单层容器成立，多层容器（path 含 `/`）不成立，每调一次非最深层的实体整体
       右移 PAD(30)，且不收敛。不恢复的话，没人拖过的节点也会被判定成「人拖过」
       而进 pinned，sync 写出源码里本没有的 xy，幂等性直接崩掉。这是先于本特性
       就存在的缺陷（修它会动金标准），故只绕开、不修改。

    1. 覆盖节点几何（x/y/w/h），用户拖过的位置才算数；

    2. 末尾那个 ``if e.waypoints == auto.get(key)``：回读时无法区分「人工拖出来的
       拐点」和「上次自动算出来的拐点」——两者在文件里长得一模一样。先按当前坐标
       把所有边自动算一遍，凡是与自动值相等的，就认定它只是上次生成的产物，
       **丢弃不算人工编辑**，让本轮重新路由。否则只要用户挪动过一次节点，上一轮
       的拐点就会被当成"用户的选择"永久锁死，线再也绕不回来。

    已知边界：若用户在 build 之后、sync 之前改过源码（插入节点导致默认布局整体
    位移），那些被挪动但没人碰过的节点会被误判成「人拖过」而钉进源码。这与既有
    autoWaypoints 对边的处理是同一类脆弱性，属已知取舍。
    """
    model.pinned.clear()
    live = _geometry_snapshot(model)
    _assign_default_positions(model)
    base = _geometry_snapshot(model)
    _restore_geometry(model, live)

    for sid, (x, y, w, h) in layout.get("nodes", {}).items():
        ent = model.signals.get(sid) or model.funcs.get(sid)
        # 容器 cell、callout（两者都以 symbolId 形态出现在 layout["nodes"] 里）与
        # 图上未知的 id 都在这里挡掉：它们不是实体，没有「人工改过的几何」可回写。
        if ent is None:
            continue
        _record_pinned(model, sid, base.get(sid), (x, y, w, h))
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

"""IR（中间表示）——整条流水线的中枢。

数据流是单向的，两个方向各一条链：

    parse  ->  IR  ->  drawio / svg        （build：源码是唯一真相，图是派生物）
    drawio ->  IR  ->  source              （sync：把图上的排版改动写回声明层）

各语言前端（cparse / csparse）只负责产出一个 Model；下游的 drawio / svg / codegen
都只读这个 Model，不碰源码。所以「加一门语言」= 加一个前端，其余不动。
"""

from dataclasses import dataclass, field


@dataclass
class Signal:
    """一个信号：C 里是带 ``@drawcode`` 注解的变量，C# 里是带 ``[Drawcode]`` 的字段。

    ``id`` 是 ``文件::名字`` 形式的全局唯一键，跨语言合并时靠它去重；
    ``file`` / ``line`` 只用于回写时定位，不参与图的结构，也不影响几何。
    ``x``/``y``/``w``/``h`` 是排版结果——由布局算法或 ``--layout-from`` 填入，
    解析阶段一律是默认值。
    """

    id: str
    name: str
    ctype: str
    dir: str = "in"
    file: str = ""
    line: int = 0
    unit: str = ""
    alias: str = ""
    note: str = ""
    external: bool = False
    group: str = ""
    # 容器层级，`adc/采样前端` 这样的斜杠路径。空串表示「没标」，此时解析器会
    # 把它归一化成模块名（`adc.h` -> `adc`），所以下游拿到的 path 永远非空。
    # `group` 始终等于 path 的第一段，是给「只关心顶层容器」的旧代码用的。
    path: str = ""
    # 原样追加到节点样式串末尾的片段（`strokeColor=#4d7ea8;` 这类角色分色）。
    # 空串等于没追加，所以不写 `style` 的源码产物逐字节不变。
    # 来源：C 的 `style="…"` 与 C# 的 `Style = "…"`，两个前端都读。
    style: str = ""
    x: float = 0.0
    y: float = 0.0
    w: float = 160.0
    h: float = 60.0


@dataclass
class Callout:
    """一块不参与连线的说明文字（``[Callout]``）。

    为什么单独成一个列表而不是 Sig/Func 上的字段：一个声明可以挂**多个**文字块，
    塞进字段会被后一条静默覆盖。它们的坐标是**画布绝对坐标**，不属于任何容器 ——
    容器包围盒（``_container_box``）也不把它们算进去，否则拖一块说明就会把容器撑大。

    ``shape`` 取 text（无边框文字）/ box（带底色说明框）/ band（大片分区带）。
    ``font_size`` 为 0 表示用该种类的默认字号。
    """

    id: str
    text: str
    owner: str = ""
    shape: str = "text"
    font_size: float = 0.0
    x: float = 0.0
    y: float = 0.0
    w: float = 200.0
    h: float = 40.0


@dataclass
class PinnedGeom:
    """「从图里读回、且与 build 本来会写出的值不同」的几何 —— 要回写进源码注解的部分。

    两个字段各自可选：只拖动不改尺寸时只有 ``xy``；只缩放时只有 ``size``。
    值是**绝对画布坐标**，与 ``Signal.x/y`` 同坐标系 —— 节点在容器里时 XML 写的是
    相对坐标，换算由 drawio.py 与 codegen.py 各自负责。
    """

    xy: list = None
    size: list = None


@dataclass
class Param:
    """函数形参。形参同时也被当作「端口」参与方向排序（见 drawio._dir_rank）。"""

    name: str
    ctype: str
    dir: str = "in"


@dataclass
class Func:
    """一个函数/方法节点。

    ``reads`` / ``writes`` / ``calls`` 是从**函数体代码**扫描出来的符号引用，
    它们与注解无关——注解只提供标签文字，不产生任何一条边。
    """

    id: str
    name: str
    ret: str = "void"
    params: list = field(default_factory=list)
    file: str = ""
    line: int = 0
    alias: str = ""
    note: str = ""
    tooltip: str = ""
    asset: str = ""
    external: bool = False
    group: str = ""
    path: str = ""
    # 与 Signal.style 同义：原样追加到节点样式串末尾。空串时产物逐字节不变。
    style: str = ""
    reads: list = field(default_factory=list)
    writes: list = field(default_factory=list)
    calls: list = field(default_factory=list)
    x: float = 0.0
    y: float = 0.0
    w: float = 180.0
    h: float = 72.0


@dataclass
class Edge:
    """信号/函数之间的一条有向边。

    ``rw`` 取 ``read`` / ``write``，或 ``inline``（``--inline`` 把一写一读的信号
    折叠后，写者函数直连读者的那条边）；``waypoints`` 是人工（或自动）插入的中间
    拐点，会被写进 ``<Array as="points">`` 并在回读时原样取回。

    ``sig`` 只对 inline 边有值：被折叠掉的信号 id，用来把线上文字（信号语义名）
    与颜色找回来。普通边保持空串。
    """

    src: str
    dst: str
    rw: str = "read"
    waypoints: list = field(default_factory=list)
    sig: str = ""


@dataclass
class Device:
    """挂在一个函数上的外部器件元数据（``@device`` / ``[Device]``）。"""

    vendor: str = ""
    model: str = ""
    spec: str = ""
    size: str = ""
    asset: str = ""


@dataclass
class Model:
    """整张图的 IR。三个 dict 都以 ``id`` 为键，``edges`` 是有序列表。"""

    signals: dict = field(default_factory=dict)
    funcs: dict = field(default_factory=dict)
    edges: list = field(default_factory=list)
    devices: dict = field(default_factory=dict)
    files: list = field(default_factory=list)
    # 不参与连线的说明文字，按源码声明顺序排列（顺序即绘制顺序）。
    callouts: list = field(default_factory=list)
    # 被 collapse_signals 折叠成直连边的信号 id。_entities 必须跳过它们 ——
    # 否则信号节点照画、两段边却没了，图上会剩一堆悬空的椭圆。
    inlined: set = field(default_factory=set)
    # 被折叠的信号 -> (写者函数 id, 读者函数 id)，rebuild_edges 靠它发射直连边。
    inline_pairs: dict = field(default_factory=dict)
    # 「人拖过」的几何，由 apply_layout 填；纯 build 永远是空表。
    pinned: dict = field(default_factory=dict)

    def add_signal(self, s):
        self.signals[s.id] = s

    def add_func(self, f):
        self.funcs[f.id] = f

    def add_callout(self, c):
        self.callouts.append(c)

    def rebuild_edges(self):
        """从每个函数的 reads/writes 重建全部边。**这是边的唯一来源。**

        read  → ``信号 -> 函数``；write → ``函数 -> 信号``。方向在这一个地方定死，
        别处不要再拼边，否则顺序会和这里不一致、几何随之漂移。

        被折叠（inlined）的信号不再产出两段边；inner 边在最后按 inline_pairs 的
        插入顺序追加 —— 这个顺序必须与 TypeScript/.NET 的 Map 遍历顺序一致，
        因为边序会影响路由平局的选择。
        """
        out = []
        for f in self.funcs.values():
            for sid in f.reads:
                if sid in self.inlined:
                    continue
                out.append(Edge(sid, f.id, "read"))
            for sid in f.writes:
                if sid in self.inlined:
                    continue
                out.append(Edge(f.id, sid, "write"))
        for sid, pair in self.inline_pairs.items():
            out.append(Edge(pair[0], pair[1], "inline", [], sid))
        self.edges = out
        return out


def collapse_signals(model):
    """把「恰好一写一读」的信号折叠成写者到读者的一条直连边，返回折叠条数。

    为什么限定**恰好一写一读**：只有这时「信号」与「从 A 到 B 的这一根连线」才是
    同一样东西，折掉它不丢任何信息。多写（多处驱动同一信号）或多读（一个信号广播
    给多方）时，信号是真正的汇合点，折掉它就等于把汇合关系抹掉了。

    自环（同一个函数既写又读）也跳过：折出来会是一根自己指向自己的线。

    副作用：会重算 ``model.edges``。默认不调用，所以不传 ``--inline`` 时产物
    逐字节不变。
    """
    writers, readers = {}, {}
    for f in model.funcs.values():
        for sid in f.writes:
            writers.setdefault(sid, []).append(f.id)
        for sid in f.reads:
            readers.setdefault(sid, []).append(f.id)

    folded = 0
    for sid in model.signals:
        w = writers.get(sid, [])
        r = readers.get(sid, [])
        if len(w) != 1 or len(r) != 1:
            continue
        if w[0] == r[0]:
            continue
        model.inlined.add(sid)
        model.inline_pairs[sid] = (w[0], r[0])
        folded += 1
    model.rebuild_edges()
    return folded

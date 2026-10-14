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
    x: float = 0.0
    y: float = 0.0
    w: float = 160.0
    h: float = 60.0


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

    ``rw`` 取 ``read`` 或 ``write``；``waypoints`` 是人工（或自动）插入的中间拐点，
    会被写进 ``<Array as="points">`` 并在回读时原样取回。
    """

    src: str
    dst: str
    rw: str = "read"
    waypoints: list = field(default_factory=list)


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

    def add_signal(self, s):
        self.signals[s.id] = s

    def add_func(self, f):
        self.funcs[f.id] = f

    def rebuild_edges(self):
        """从每个函数的 reads/writes 重建全部边。**这是边的唯一来源。**

        read  → ``信号 -> 函数``；write → ``函数 -> 信号``。方向在这一个地方定死，
        别处不要再拼边，否则顺序会和这里不一致、几何随之漂移。
        """
        out = []
        for f in self.funcs.values():
            for sid in f.reads:
                out.append(Edge(sid, f.id, "read"))
            for sid in f.writes:
                out.append(Edge(f.id, sid, "write"))
        self.edges = out
        return out

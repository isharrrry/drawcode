"""按扩展名把文件分派给对应的语言前端，并把结果合并成一个 IR。

这是 build 的第一步：调用方给一串路径，拿回一个 Model，不关心哪个文件是什么语言。
"""

import os

from .cparse import parse_project
from .csparse import parse_cs_project
from .model import Model

CS_EXT = (".cs",)
C_EXT = (".c", ".h", ".cpp", ".hpp", ".cc", ".hh")


def parse_any(paths, root=None):
    """按扩展名分派到语言绑定，多个语言的结果合并进同一个 IR。

    ``root`` 是计算相对路径的基准（IR 里的 ``file`` 字段用它），缺省取第一个文件所在目录。

    注意合并是**按 id 覆盖**、不是按符号解析：C 和 C# 里同名的信号会被后者覆盖，
    跨语言的同名引用**不会**被连起来。这是已知限制，不是疏漏。
    """
    root = root or os.path.dirname(os.path.abspath(paths[0]))
    cs = [p for p in paths if p.lower().endswith(CS_EXT)]
    c = [p for p in paths if p.lower().endswith(C_EXT)]
    unknown = [p for p in paths if p not in cs and p not in c]
    if unknown:
        # 宁可报错也不静默跳过：传目录进来是常见误用，静默会让用户以为图是空的。
        raise ValueError("不支持的文件类型: %s" % ", ".join(unknown))

    parts = []
    if c:
        parts.append(parse_project(c, root=root))
    if cs:
        parts.append(parse_cs_project(cs, root=root))
    if len(parts) == 1:
        return parts[0]

    merged = Model(files=[])
    for sub in parts:
        merged.signals.update(sub.signals)
        merged.funcs.update(sub.funcs)
        merged.devices.update(sub.devices)
        # callouts 是**列表**而不是按 id 覆盖的 dict：C 与 C# 各产出自己那份，
        # 合并时必须 extend。早先漏了这一行，混合语言的图会静默丢掉全部文字块
        # （单语言时 parts 只有一个、走上面的提前 return，所以问题只在混编时暴露）。
        merged.callouts.extend(sub.callouts)
        merged.files.extend(sub.files)
    merged.rebuild_edges()
    return merged

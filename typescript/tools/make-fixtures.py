"""生成跨实现 fixture：把金标准 .drawio 打包成 draw.io 保存时的压缩形态。

单独跑一次即可；产物提交进仓库，测试直接读它 —— 这样 TS 侧读的是
**Python 生成的**压缩串，而不是自己 pack 又被自己 unpack 的自证循环。

    python typescript/tools/make-fixtures.py
"""
import base64
import os
import urllib.parse
import xml.etree.ElementTree as ET
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
TS_ROOT = os.path.dirname(HERE)
REPO = os.path.dirname(TS_ROOT)

RAW_SAFE = "~()*!.'"


def pack(xml_text: str) -> str:
    tree = ET.fromstring(xml_text)
    for diagram in tree.findall("diagram"):
        inner = diagram.find("mxGraphModel")
        if inner is None:
            continue
        payload = ET.tostring(inner, encoding="unicode")
        for child in list(diagram):
            diagram.remove(child)
        compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
        blob = (
            compressor.compress(urllib.parse.quote(payload, safe=RAW_SAFE).encode("utf-8"))
            + compressor.flush()
        )
        diagram.text = base64.b64encode(blob).decode("ascii")
    return ET.tostring(tree, encoding="unicode")


def main() -> int:
    out_dir = os.path.join(TS_ROOT, "test", "fixtures")
    os.makedirs(out_dir, exist_ok=True)
    for case in ("small-c", "small-cs"):
        src = os.path.join(REPO, "tests", "golden", case, "expected.drawio")
        with open(src, encoding="utf-8") as fh:
            packed = pack(fh.read())
        dst = os.path.join(out_dir, case + ".compressed.drawio")
        with open(dst, "w", encoding="utf-8", newline="") as fh:
            fh.write(packed)
        print("wrote %s (%d bytes)" % (dst, len(packed)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

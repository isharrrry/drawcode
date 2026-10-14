import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
_REPO = os.path.dirname(ROOT)

XSD = os.path.join(_REPO, "tools", "xsd", "mxfile.xsd")

try:
    from lxml import etree

    HAVE = True
except ImportError:
    HAVE = False

from drawcode.cparse import parse_project
from drawcode.csparse import parse_cs_project
from drawcode.drawio import to_drawio

EX = os.path.join(_REPO, "examples", "small", "c")
FILES = [os.path.join(EX, f) for f in ("adc.h", "adc.c", "dsp.h", "dsp.c")]

EXCS = os.path.join(_REPO, "examples", "small", "cs")
CS_FILES = [os.path.join(EXCS, f) for f in ("Adc.cs", "Dsp.cs")]


@unittest.skipUnless(HAVE, "lxml 未安装")
@unittest.skipUnless(os.path.exists(XSD), "官方 mxfile.xsd 不在位")
class TestOfficialSchema(unittest.TestCase):
    def test_generated_diagram_validates(self):
        xml = to_drawio(parse_project(FILES, root=EX))
        schema = etree.XMLSchema(etree.parse(XSD))
        doc = etree.fromstring(xml.encode("utf-8"))
        self.assertTrue(schema.validate(doc), "\n".join(str(e) for e in schema.error_log))

    def test_cs_diagram_validates(self):
        xml = to_drawio(parse_cs_project(CS_FILES, root=EXCS))
        schema = etree.XMLSchema(etree.parse(XSD))
        doc = etree.fromstring(xml.encode("utf-8"))
        self.assertTrue(schema.validate(doc), "\n".join(str(e) for e in schema.error_log))

    def test_diagram_with_waypoints_validates(self):
        m = parse_project(FILES, root=EX)
        m.edges[0].waypoints = [(10.0, 20.0), (30.0, 40.0)]
        xml = to_drawio(m)
        schema = etree.XMLSchema(etree.parse(XSD))
        doc = etree.fromstring(xml.encode("utf-8"))
        self.assertTrue(schema.validate(doc), "\n".join(str(e) for e in schema.error_log))


if __name__ == "__main__":
    unittest.main()

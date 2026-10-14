import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { toDrawio } from "../src/drawio.ts";
import { dumpIr, dumpIrJson } from "../src/dump.ts";
import { parseAny } from "../src/parse.ts";
import { toSvg } from "../src/svg.ts";
import { iterElements, parseXml } from "../src/xml.ts";
import { Schema } from "../src/xsd.ts";
import {
  CASES_DIR,
  caseNames,
  extractGeometry,
  extractShape,
  loadCase,
  mustRead,
  XSD_PATH,
} from "./helpers.ts";

// 模块顶层就解析 XSD：缺失或不可解析必须让整个文件炸掉，而不是静默降级。
const schema = Schema.parse(mustRead(XSD_PATH));

interface SvgShape {
  counts: Record<string, number>;
  texts: string[];
  coords: number[];
}

function svgShape(svg: string): SvgShape {
  const root = parseXml(svg);
  const counts: Record<string, number> = {};
  const texts: string[] = [];
  const coords: number[] = [];
  for (const el of iterElements(root)) {
    counts[el.tag] = (counts[el.tag] ?? 0) + 1;
    if (el.tag === "text" || el.tag === "tspan") {
      const value = (el.text ?? "").trim();
      if (value !== "") texts.push(value);
    }
    for (const key of ["x", "y", "cx", "cy", "rx", "ry", "width", "height"]) {
      const raw = el.attrib.get(key);
      if (raw !== undefined && raw !== "" && !Number.isNaN(Number(raw))) {
        coords.push(Number(raw));
      }
    }
  }
  return { counts, texts, coords };
}

const names = caseNames();

test("conformance: at least one golden case is actually exercised", () => {
  assert.ok(names.length > 0, "no golden cases found — a vacuous pass is not a pass");
});

for (const name of names) {
  const golden = loadCase(name);

  test(`[${name}] L1 — parse (IR) is exact`, () => {
    const model = parseAny(golden.files, golden.root);
    assert.deepStrictEqual(dumpIr(model), golden.ir);
  });

  test(`[${name}] L1 (strict) — canonical IR JSON is byte-identical to the golden`, () => {
    // 比 L1 更严：连键序和空白都要与 tools/dump_ir.py 的产物逐字节一致。
    const model = parseAny(golden.files, golden.root);
    assert.equal(dumpIrJson(model), mustRead(path.join(CASES_DIR, name, "expected.ir.json")));
  });

  test(`[${name}] L2 — graph structure (containers, nodes, edges, membership) is exact`, () => {
    const model = parseAny(golden.files, golden.root);
    assert.deepStrictEqual(extractShape(toDrawio(model)), extractShape(golden.drawio));
  });

  test(`[${name}] L3 — geometry (x/y/w/h, waypoints, anchors) is exact`, () => {
    const model = parseAny(golden.files, golden.root);
    const got = extractGeometry(toDrawio(model));
    const expected = extractGeometry(golden.drawio);
    assert.deepStrictEqual(got, expected);
  });

  test(`[${name}] L3 (strict) — generated .drawio is byte-identical to the golden`, () => {
    // spec 只要求结构相等；这条更严，通过说明连属性顺序和浮点拼写都一致。
    const model = parseAny(golden.files, golden.root);
    assert.equal(toDrawio(model), golden.drawio);
  });

  test(`[${name}] L4 — generated .drawio validates against mxfile.xsd`, () => {
    const model = parseAny(golden.files, golden.root);
    const errors = schema.validate(parseXml(toDrawio(model)));
    assert.deepStrictEqual(
      errors,
      [],
      `schema violations:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`,
    );
  });

  test(`[${name}] L4 — the golden .drawio itself validates (checker sanity)`, () => {
    const errors = schema.validate(parseXml(golden.drawio));
    assert.deepStrictEqual(
      errors,
      [],
      `checker rejects the golden too:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`,
    );
  });

  test(`[${name}] SVG preview matches the golden structurally`, () => {
    const model = parseAny(golden.files, golden.root);
    const got = svgShape(toSvg(model));
    const expected = svgShape(golden.svg);
    assert.deepStrictEqual(got.counts, expected.counts);
    assert.deepStrictEqual(got.texts, expected.texts);
    assert.equal(got.coords.length, expected.coords.length);
    got.coords.forEach((value, i) => {
      const other = expected.coords[i] as number;
      assert.ok(Math.abs(value - other) <= 0.5, `coord[${i}]: ${value} vs ${other}`);
    });
  });
}

test("L4 checker actually rejects invalid documents (not a rubber stamp)", () => {
  const golden = loadCase("small-c").drawio;
  const mutations: Array<[string, string]> = [
    ["fixed attribute violated", golden.replace('as="geometry" />', 'as="geo" />')],
    ["undeclared attribute", golden.replace("<mxfile ", '<mxfile bogusAttr="x" ')],
    ["enumeration violated", golden.replace('grid="1"', 'grid="2"')],
    ["positiveInteger violated", golden.replace('pageWidth="1169"', 'pageWidth="0"')],
    ["double violated", golden.replace('dx="1200"', 'dx="abc"')],
    ["unexpected child element", golden.replace("      </root>", "        <nope />\n      </root>")],
    ["required attribute missing", golden.replace('id="n1" ', "")],
  ];
  for (const [label, doc] of mutations) {
    const errors = schema.validate(parseXml(doc));
    assert.ok(errors.length > 0, `checker accepted an invalid document: ${label}`);
  }
  assert.deepStrictEqual(schema.validate(parseXml(golden)), [], "unmutated golden must pass");
});

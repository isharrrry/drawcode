import assert from "node:assert/strict";
import { test } from "node:test";

import { parseXml } from "../src/xml.ts";
import { Schema } from "../src/xsd.ts";
import { loadCase, mustRead, XSD_PATH } from "./helpers.ts";

const schema = Schema.parse(mustRead(XSD_PATH));
const golden = loadCase("small-c").drawio;

test("xsd: the vendor schema parses into the expected shape", () => {
  const s = schema as unknown as {
    elements: Map<string, unknown>;
    complexTypes: Map<string, unknown>;
    simpleTypes: Map<string, unknown>;
  };
  assert.deepStrictEqual([...s.elements.keys()], ["mxfile"]);
  assert.ok(s.complexTypes.has("mxCellType"));
  assert.ok(s.complexTypes.has("mxGeometryType"));
  assert.deepStrictEqual([...s.simpleTypes.keys()].sort(), [
    "booleanInt",
    "booleanString",
    "colorType",
    "mxPointAsType",
  ]);
});

test("xsd: the golden .drawio validates", () => {
  const errors = schema.validate(parseXml(golden));
  assert.deepStrictEqual(
    errors,
    [],
    errors.map((e) => `${e.path}: ${e.message}`).join("\n"),
  );
});

test("xsd: a fixed attribute violation is caught", () => {
  const errors = schema.validate(parseXml(golden.replace('as="geometry" />', 'as="geo" />')));
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /fixed value/);
});

test("xsd: an undeclared attribute is caught where anyAttribute is absent", () => {
  const errors = schema.validate(parseXml(golden.replace("<mxfile ", '<mxfile bogus="x" ')));
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /undeclared attribute/);
});

test("xsd: custom attributes on <object> are allowed via anyAttribute", () => {
  const doc = golden.replace('symbolId="adc.h::g_raw"', 'symbolId="adc.h::g_raw" customThing="ok"');
  assert.deepStrictEqual(schema.validate(parseXml(doc)), []);
});

test("xsd: enumeration and builtin-type violations are caught", () => {
  assert.match(
    schema.validate(parseXml(golden.replace('grid="1"', 'grid="2"')))[0]?.message ?? "",
    /not one of \[0, 1\]/,
  );
  assert.match(
    schema.validate(parseXml(golden.replace('pageWidth="1169"', 'pageWidth="0"')))[0]?.message ?? "",
    /positiveInteger/,
  );
  assert.match(
    schema.validate(parseXml(golden.replace('dx="1200"', 'dx="abc"')))[0]?.message ?? "",
    /xs:double/,
  );
});

test("xsd: a missing required attribute is caught", () => {
  const errors = schema.validate(parseXml(golden.replace('id="n1" ', "")));
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /missing required attribute "id"/);
});

test("xsd: an unexpected child element is caught", () => {
  const doc = golden.replace("      </root>", "        <nope />\n      </root>");
  const errors = schema.validate(parseXml(doc));
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /unexpected child <nope>/);
});

test("xsd: an empty sequence slot is NOT a violation (minOccurs=0 on mxGeometry)", () => {
  // mxCell 的 structural 行没有 mxGeometry —— 这是合法的，早期实现误判过。
  const errors = schema.validate(parseXml(golden));
  assert.deepStrictEqual(errors, []);
});

test("xsd: a document with no global element declaration is rejected", () => {
  const errors = schema.validate(parseXml("<other />"));
  assert.match(errors[0]?.message ?? "", /no global element declaration/);
});

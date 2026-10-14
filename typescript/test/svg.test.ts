import assert from "node:assert/strict";
import { test } from "node:test";

import { parseProject } from "../src/cparse.ts";
import { toSvg } from "../src/svg.ts";
import { iterElements, parseXml } from "../src/xml.ts";
import { examplesC } from "./helpers.ts";

const FILES = examplesC();

function model() {
  return parseProject(FILES);
}

test("svg: well-formed with a four-number viewBox", () => {
  const root = parseXml(toSvg(model()));
  assert.equal(root.tag, "svg");
  const vb = root.attrib.get("viewBox") ?? "";
  assert.equal(vb.split(/\s+/).length, 4);
});

test("svg: every symbol carries a label", () => {
  const root = parseXml(toSvg(model()));
  const text = [...iterElements(root)]
    .filter((el) => el.tag === "tspan" || el.tag === "text")
    .map((el) => el.text ?? "")
    .join("");
  for (const token of ["g_raw", "g_filtered", "g_coeff", "adc_read", "fir_apply", "dsp_set_gain"]) {
    assert.ok(text.includes(token), `missing label for ${token}`);
  }
});

test("svg: container titles are present", () => {
  const root = parseXml(toSvg(model()));
  const text = [...iterElements(root)]
    .filter((el) => el.tag === "text")
    .map((el) => el.text ?? "")
    .join("");
  assert.ok(text.includes("adc"));
  assert.ok(text.includes("dsp"));
});

test("svg: one shape per node and one path per edge", () => {
  const root = parseXml(toSvg(model()));
  const shapes = [...iterElements(root)].filter(
    (el) => el.tag === "ellipse" || (el.tag === "rect" && el.attrib.get("data-kind") === "func"),
  );
  assert.equal(shapes.length, 6);
  const paths = [...iterElements(root)].filter(
    (el) => el.tag === "path" && el.attrib.get("data-edge") !== undefined,
  );
  assert.equal(paths.length, 6);
});

test("svg: waypoints reach the path data", () => {
  const m = model();
  (m.edges[0] as { waypoints: Array<[number, number]> }).waypoints = [[700, 500]];
  const svg = toSvg(m);
  assert.ok(svg.includes("700"));
  assert.ok(svg.includes("500"));
});

test("svg: an external func is dashed", () => {
  const m = model();
  (m.funcs.get("dsp.h::fir_apply") as { external: boolean }).external = true;
  assert.ok(toSvg(m).includes("stroke-dasharray"));
});

test("svg: an empty model still yields well-formed SVG", () => {
  const empty = parseProject([], ".");
  const svg = toSvg(empty);
  assert.equal(parseXml(svg).tag, "svg");
  assert.ok(svg.includes('width="1"'));
});

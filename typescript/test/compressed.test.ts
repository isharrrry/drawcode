import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import { decompress, quote, readLayout } from "../src/drawio.ts";
import { caseNames, loadCase, mustRead, REPO } from "./helpers.ts";

function fixture(name: string): string {
  return path.join(REPO, "typescript", "test", "fixtures", `${name}.compressed.drawio`);
}

for (const name of caseNames()) {
  test(`[${name}] a compressed file written by Python reads back identically to the plain one`, () => {
    const golden = loadCase(name);
    const packed = mustRead(fixture(name));
    const fromPacked = readLayout(packed);
    const fromPlain = readLayout(golden.drawio);
    assert.deepStrictEqual([...fromPacked.nodes], [...fromPlain.nodes]);
    assert.deepStrictEqual([...fromPacked.edges], [...fromPlain.edges]);
    assert.deepStrictEqual([...fromPacked.attrs], [...fromPlain.attrs]);
    assert.ok(fromPacked.nodes.size > 0, "compressed read must not come back empty");
  });

  test(`[${name}] the fixture really is the compressed form`, () => {
    const text = mustRead(fixture(name));
    assert.ok(!text.includes("<mxGraphModel"), "fixture must not carry a plain mxGraphModel child");
    assert.ok(!text.includes("symbolId"), "the payload must be opaque base64, not readable XML");
  });
}

test("drawio: quote encodes everything outside draw.io's safe set", () => {
  // draw.io 用 safe="~()*!.'" 覆盖了 urllib 的默认 safe="/"，
  // 所以 `/ & ; = < >` 全部要被百分号编码，而 `! . ' ( ) * ~ _ -` 保持字面。
  assert.equal(quote("a&b;c!d.e/f'g(h)i*j~k-l_m"), "a%26b%3Bc!d.e%2Ff'g(h)i*j~k-l_m");
  assert.ok(quote("<x/>").startsWith("%3C"), "< must be encoded");
});

test("drawio: decompress rejects a payload that is not raw deflate", () => {
  const bogus = Buffer.from("definitely not compressed", "utf8").toString("base64");
  assert.throws(() => decompress(bogus));
});

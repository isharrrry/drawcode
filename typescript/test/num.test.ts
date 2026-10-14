import assert from "node:assert/strict";
import { test } from "node:test";

import { num, reprFloat } from "../src/num.ts";

test("num: integral values print without a decimal point", () => {
  assert.equal(num(420), "420");
  assert.equal(num(420.0), "420");
  assert.equal(num(0), "0");
  assert.equal(num(-7), "-7");
  // Python 的 str(int(-0.0)) 是 "0"，JS 的 String(-0) 也是 "0"
  assert.equal(num(-0), "0");
});

test("num: halves print with a decimal point", () => {
  assert.equal(num(420.5), "420.5");
  assert.equal(num(-0.5), "-0.5");
  assert.equal(num(15.5), "15.5");
});

test("num: large integral values do not fall into exponent notation", () => {
  // Python: str(int(1e21)) == "1000000000000000000000"
  // JS:     String(1e21) === "1e+21"  ← 必须走 BigInt 分支
  assert.equal(num(1e21), "1000000000000000000000");
  assert.equal(num(1e16), "10000000000000000");
});

test("num: reprFloat switches to Python-style exponent thresholds", () => {
  // Python 在 exp < -4 时用指数记法，且指数补到两位
  assert.equal(reprFloat(1e-5), "1e-05");
  assert.equal(reprFloat(1.5e-5), "1.5e-05");
  assert.equal(reprFloat(1e21), "1e+21");
  // [-4, 16) 区间保持定点
  assert.equal(reprFloat(0.5), "0.5");
  assert.equal(reprFloat(0.0001), "0.0001");
});

test("num: non-finite values follow Python spelling", () => {
  assert.equal(reprFloat(NaN), "nan");
  assert.equal(reprFloat(Infinity), "inf");
  assert.equal(reprFloat(-Infinity), "-inf");
});

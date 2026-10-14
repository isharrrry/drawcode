import assert from "node:assert/strict";
import { test } from "node:test";

import { attr, findChild, findChildren, iterElements, parseXml, serializeXml } from "../src/xml.ts";

test("xml: elements, attributes and text", () => {
  const el = parseXml('<a x="1" y="2">hello</a>');
  assert.equal(el.tag, "a");
  assert.equal(attr(el, "x"), "1");
  assert.equal(el.text, "hello");
  assert.equal(el.children.length, 0);
});

test("xml: prolog, comments and declarations are skipped", () => {
  const el = parseXml('<?xml version="1.0"?>\n<!-- lead -->\n<!DOCTYPE a>\n<a><!-- inner --><b /></a>');
  assert.equal(el.tag, "a");
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0]?.tag, "b");
  assert.equal(el.text, null, "comment text must not become element text");
});

test("xml: text / tail follow ElementTree semantics", () => {
  const el = parseXml("<a>one<b>two</b>three<c/>four</a>");
  assert.equal(el.text, "one");
  const [b, c] = el.children;
  assert.equal(b?.text, "two");
  assert.equal(b?.tail, "three");
  assert.equal(c?.tail, "four");
});

test("xml: named and numeric entities decode", () => {
  const el = parseXml('<a v="&lt;br&gt; &amp; &quot;q&quot; &apos;s&apos; &#65;&#x42;">&lt;x&gt;</a>');
  assert.equal(attr(el, "v"), `<br> & "q" 's' AB`);
  assert.equal(el.text, "<x>");
});

test("xml: CDATA is taken literally", () => {
  const el = parseXml("<a><![CDATA[<not-a-tag> & raw]]></a>");
  assert.equal(el.text, "<not-a-tag> & raw");
});

test("xml: self-closing and whitespace-only bodies", () => {
  assert.equal(serializeXml(parseXml("<a />")), "<a />");
  assert.equal(serializeXml(parseXml('<a x="1" />')), '<a x="1" />');
  assert.equal(parseXml("<a>   </a>").text, "   ");
});

test("xml: serialization escapes attributes and newlines like ElementTree", () => {
  const el = parseXml("<a />");
  el.attrib.set("v", 'a&b<c>d"e\nf\tg');
  assert.equal(serializeXml(el), '<a v="a&amp;b&lt;c&gt;d&quot;e&#10;f&#09;g" />');
});

test("xml: attribute order is preserved", () => {
  const el = parseXml('<a z="1" m="2" b="3" />');
  assert.deepStrictEqual([...el.attrib.keys()], ["z", "m", "b"]);
  assert.equal(serializeXml(el), '<a z="1" m="2" b="3" />');
});

test("xml: iterElements is depth-first pre-order and includes the root", () => {
  const el = parseXml("<a><b><d /></b><c /></a>");
  assert.deepStrictEqual([...iterElements(el)].map((e) => e.tag), ["a", "b", "d", "c"]);
});

test("xml: findChild only looks at direct children", () => {
  const el = parseXml("<a><b><deep /></b></a>");
  assert.equal(findChild(el, "deep"), null, "findChild is not a descendant selector");
  assert.equal(findChild(el, "b")?.tag, "b");
  assert.deepStrictEqual(findChildren(el, "b").length, 1);
});

test("xml: mismatched tags are rejected, not repaired", () => {
  assert.throws(() => parseXml("<a></b>"), /mismatched end tag/);
  assert.throws(() => parseXml("<a>"), /unexpected end of input/);
  assert.throws(() => parseXml("<a x=1 />"), /must be quoted/);
});

test("xml: round trip normalises empty elements to ElementTree's `<x />` spelling", () => {
  const canonical = '<root><object id="n1" label="a&lt;br&gt;b"><mxCell /></object><x y="1" /></root>';
  assert.equal(serializeXml(parseXml(canonical)), canonical);
  // 输入写 <x/> 也会被规范成 <x /> —— ElementTree 的 short_empty_elements 就是这个形态
  assert.equal(serializeXml(parseXml('<root><x y="1"/></root>')), '<root><x y="1" /></root>');
});

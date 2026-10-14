/**
 * XSD 子集校验器 —— 用来满足 conformance.md 的 L4（生成的 .drawio 必须通过
 * `../../tools/xsd/mxfile.xsd` 校验）。
 *
 * 为什么手写：Node 没有内置 XML Schema，引第三方库又会破坏"零依赖"和基准可比性。
 * 这个实现覆盖 mxfile.xsd 实际用到的构造：
 *
 *   xs:element（全局与局部，minOccurs/maxOccurs）
 *   xs:complexType（xs:sequence / xs:choice / xs:attribute / xs:anyAttribute）
 *   xs:simpleType（xs:restriction base，xs:enumeration / xs:pattern）
 *   内置类型 xs:string / xs:double / xs:positiveInteger
 *
 * 它**不是**通用 XSD 引擎：没有命名空间、没有 xs:import、没有 xs:extension、
 * 没有 identity constraints。校验失败会带路径和原因报出来，不静默通过。
 */

import type { XmlElement } from "./xml.ts";
import { parseXml } from "./xml.ts";

export interface XsdError {
  path: string;
  message: string;
}

interface SimpleTypeDef {
  name: string;
  base: string;
  enumerations: string[] | null;
  pattern: string | null;
}

interface AttributeDecl {
  name: string;
  type: string;
  use: "required" | "optional" | "prohibited";
  fixed: string | null;
}

type ParticleKind = "element" | "sequence" | "choice";

interface Particle {
  kind: ParticleKind;
  name: string | null;
  type: string | null;
  minOccurs: number;
  maxOccurs: number;
  children: Particle[];
}

interface ComplexTypeDef {
  name: string;
  particle: Particle | null;
  attributes: AttributeDecl[];
  anyAttribute: boolean;
  anyAttributeLax: boolean;
}

function attrInt(el: XmlElement, name: string, fallback: number): number {
  const raw = el.attrib.get(name);
  if (raw === undefined) return fallback;
  if (raw === "unbounded") return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseParticle(el: XmlElement): Particle | null {
  if (el.tag === "xs:element") {
    const name = el.attrib.get("name");
    if (name === undefined) return null;
    return {
      kind: "element",
      name,
      type: el.attrib.get("type") ?? "xs:string",
      minOccurs: attrInt(el, "minOccurs", 1),
      maxOccurs: attrInt(el, "maxOccurs", 1),
      children: [],
    };
  }
  if (el.tag === "xs:sequence" || el.tag === "xs:choice") {
    const children: Particle[] = [];
    for (const child of el.children) {
      const sub = parseParticle(child);
      if (sub !== null) children.push(sub);
    }
    return {
      kind: el.tag === "xs:sequence" ? "sequence" : "choice",
      name: null,
      type: null,
      minOccurs: attrInt(el, "minOccurs", 1),
      maxOccurs: attrInt(el, "maxOccurs", 1),
      children,
    };
  }
  return null;
}

function describe(p: Particle): string {
  if (p.kind === "element") return `<${p.name}>`;
  return `${p.kind}(${p.children.map(describe).join(" | ")})`;
}

export class Schema {
  private readonly elements = new Map<string, { name: string; type: string }>();
  private readonly complexTypes = new Map<string, ComplexTypeDef>();
  private readonly simpleTypes = new Map<string, SimpleTypeDef>();

  static parse(xsdText: string): Schema {
    const schema = new Schema();
    const root = parseXml(xsdText);
    for (const el of root.children) {
      if (el.tag === "xs:element") {
        const name = el.attrib.get("name");
        const type = el.attrib.get("type");
        if (name !== undefined && type !== undefined) schema.elements.set(name, { name, type });
        continue;
      }
      if (el.tag === "xs:simpleType") {
        const name = el.attrib.get("name");
        if (name === undefined) continue;
        const restriction = el.children.find((c) => c.tag === "xs:restriction");
        const enumerations: string[] = [];
        let pattern: string | null = null;
        if (restriction !== undefined) {
          for (const child of restriction.children) {
            if (child.tag === "xs:enumeration") {
              const value = child.attrib.get("value");
              if (value !== undefined) enumerations.push(value);
            } else if (child.tag === "xs:pattern") {
              pattern = child.attrib.get("value") ?? null;
            }
          }
        }
        schema.simpleTypes.set(name, {
          name,
          base: restriction?.attrib.get("base") ?? "xs:string",
          enumerations: enumerations.length > 0 ? enumerations : null,
          pattern,
        });
        continue;
      }
      if (el.tag === "xs:complexType") {
        const name = el.attrib.get("name");
        if (name === undefined) continue;
        let particle: Particle | null = null;
        const attributes: AttributeDecl[] = [];
        let anyAttribute = false;
        let anyAttributeLax = false;
        for (const child of el.children) {
          if (child.tag === "xs:annotation") continue;
          const candidate = parseParticle(child);
          if (candidate !== null && (child.tag === "xs:sequence" || child.tag === "xs:choice")) {
            particle = candidate;
            continue;
          }
          if (child.tag === "xs:attribute") {
            const aname = child.attrib.get("name");
            if (aname === undefined) continue;
            const use = child.attrib.get("use");
            attributes.push({
              name: aname,
              type: child.attrib.get("type") ?? "xs:string",
              use: use === "required" ? "required" : use === "prohibited" ? "prohibited" : "optional",
              fixed: child.attrib.get("fixed") ?? null,
            });
            continue;
          }
          if (child.tag === "xs:anyAttribute") {
            anyAttribute = true;
            anyAttributeLax = child.attrib.get("processContents") === "lax";
          }
        }
        schema.complexTypes.set(name, { name, particle, attributes, anyAttribute, anyAttributeLax });
      }
    }
    return schema;
  }

  validate(root: XmlElement): XsdError[] {
    const errors: XsdError[] = [];
    const decl = this.elements.get(root.tag);
    if (decl === undefined) {
      errors.push({ path: `/${root.tag}`, message: `no global element declaration for <${root.tag}>` });
      return errors;
    }
    this.validateElement(root, decl.type, `/${root.tag}`, errors);
    return errors;
  }

  private validateBuiltin(typeName: string, value: string, path: string, errors: XsdError[]): void {
    const local = typeName.replace(/^xs:/, "");
    if (local === "double" || local === "decimal" || local === "float") {
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value)) {
        errors.push({ path, message: `"${value}" is not a valid xs:${local}` });
      }
      return;
    }
    if (local === "positiveInteger") {
      if (!/^\d+$/.test(value) || Number(value) <= 0) {
        errors.push({ path, message: `"${value}" is not a valid xs:positiveInteger` });
      }
      return;
    }
    if (local === "nonNegativeInteger") {
      if (!/^\d+$/.test(value)) {
        errors.push({ path, message: `"${value}" is not a valid xs:nonNegativeInteger` });
      }
      return;
    }
    if (local === "boolean") {
      if (!["true", "false", "1", "0"].includes(value)) {
        errors.push({ path, message: `"${value}" is not a valid xs:boolean` });
      }
    }
  }

  private validateSimpleValue(
    typeName: string,
    value: string,
    path: string,
    errors: XsdError[],
  ): void {
    if (typeName.startsWith("xs:")) {
      this.validateBuiltin(typeName, value, path, errors);
      return;
    }
    const st = this.simpleTypes.get(typeName);
    if (st === undefined) return;
    if (st.enumerations !== null && !st.enumerations.includes(value)) {
      errors.push({
        path,
        message: `"${value}" is not one of [${st.enumerations.join(", ")}] (${typeName})`,
      });
    }
    if (st.pattern !== null && !new RegExp(`^(?:${st.pattern})$`).test(value)) {
      errors.push({ path, message: `"${value}" does not match /${st.pattern}/ (${typeName})` });
    }
  }

  private validateElement(el: XmlElement, typeName: string, path: string, errors: XsdError[]): void {
    if (typeName.startsWith("xs:")) {
      if (el.children.length > 0) {
        errors.push({ path, message: `<${el.tag}> has child elements but type is ${typeName}` });
      }
      this.validateBuiltin(typeName, (el.text ?? "").trim(), path, errors);
      return;
    }
    const simple = this.simpleTypes.get(typeName);
    if (simple !== undefined) {
      if (el.children.length > 0) {
        errors.push({ path, message: `<${el.tag}> has child elements but type is ${typeName}` });
      }
      this.validateSimpleValue(typeName, (el.text ?? "").trim(), path, errors);
      return;
    }
    const complex = this.complexTypes.get(typeName);
    if (complex === undefined) {
      errors.push({ path, message: `unknown type "${typeName}" for <${el.tag}>` });
      return;
    }

    this.validateAttributes(el, complex, path, errors);

    if (complex.particle === null) {
      if (el.children.length > 0) {
        errors.push({ path, message: `<${el.tag}> (${typeName}) must not have child elements` });
      }
      return;
    }

    const consumed = this.repeat(complex.particle, el.children, 0, path, errors);
    if (consumed.index < el.children.length) {
      const leftover = el.children[consumed.index] as XmlElement;
      errors.push({
        path,
        message: `<${el.tag}>: unexpected child <${leftover.tag}> at position ${consumed.index}`,
      });
    }
  }

  private validateAttributes(
    el: XmlElement,
    complex: ComplexTypeDef,
    path: string,
    errors: XsdError[],
  ): void {
    const declared = new Map(complex.attributes.map((a) => [a.name, a]));
    for (const [name, value] of el.attrib) {
      const decl = declared.get(name);
      if (decl === undefined) {
        if (!complex.anyAttribute) {
          errors.push({ path, message: `<${el.tag}>: undeclared attribute "${name}"` });
        }
        continue;
      }
      if (decl.fixed !== null && value !== decl.fixed) {
        errors.push({
          path,
          message: `<${el.tag}>@${name}: fixed value is "${decl.fixed}", got "${value}"`,
        });
      }
      this.validateSimpleValue(decl.type, value, `${path}@${name}`, errors);
    }
    for (const decl of complex.attributes) {
      if (decl.use === "required" && !el.attrib.has(decl.name)) {
        errors.push({ path, message: `<${el.tag}>: missing required attribute "${decl.name}"` });
      }
    }
  }

  /**
   * 按 minOccurs/maxOccurs 重复匹配一个粒子。
   *
   * 两个容易写错的地方：
   *   1. 「组出现一次」和「消耗了一个子元素」是两件事 ——
   *      `<xs:sequence><xs:element minOccurs="0"/></xs:sequence>` 可以既出现一次、
   *      又消耗零个元素。把两者划等号会把所有可空 sequence 误判成失败。
   *   2. 试探缓冲里的错误必须**在成功时提交**，否则深层校验错误会被静默吞掉，
   *      校验器就退化成"什么都通过"的摆设。
   */
  private repeat(
    p: Particle,
    children: XmlElement[],
    start: number,
    path: string,
    errors: XsdError[],
  ): { index: number; matched: boolean } {
    let cur = start;
    let count = 0;

    while (count < p.maxOccurs) {
      const before = cur;
      if (p.kind === "element") {
        const child = children[cur];
        if (child === undefined || child.tag !== p.name) break;
        this.validateElement(child, p.type as string, `${path}/${child.tag}`, errors);
        cur += 1;
        count += 1;
        continue;
      }
      const trial: XsdError[] = [];
      const r = this.matchGroup(p, children, cur, path, trial);
      if (!r.matched) break;
      errors.push(...trial);
      cur = r.index;
      count += 1;
      if (cur === before) break;
    }

    if (count < p.minOccurs) {
      errors.push({
        path,
        message: `expected at least ${p.minOccurs} of ${describe(p)}, got ${count}`,
      });
      return { index: cur, matched: false };
    }
    return { index: cur, matched: true };
  }

  /** 匹配一次组合粒子（sequence / choice），返回是否成立以及新位置。 */
  private matchGroup(
    p: Particle,
    children: XmlElement[],
    index: number,
    path: string,
    errors: XsdError[],
  ): { index: number; matched: boolean } {
    if (p.kind === "sequence") {
      let cur = index;
      let allOk = true;
      for (const sub of p.children) {
        const r = this.repeat(sub, children, cur, path, errors);
        cur = r.index;
        if (!r.matched) allOk = false;
      }
      return { index: cur, matched: allOk };
    }

    const child = children[index];
    if (child === undefined) return { index, matched: false };
    for (const sub of p.children) {
      if (sub.kind === "element" && sub.name !== child.tag) continue;
      const trial: XsdError[] = [];
      const r = this.repeat(sub, children, index, path, trial);
      if (r.matched && r.index > index) {
        errors.push(...trial);
        return { index: r.index, matched: true };
      }
    }
    return { index, matched: false };
  }
}

/**
 * 最小 XML 解析 / 序列化器 —— 对等 Python `xml.etree.ElementTree` 在本仓库用到的子集。
 *
 * 为什么手写而不引依赖：drawio 文档结构简单（无命名空间、无 DTD、无混合内容语义），
 * 而且 benchmark 要三版做同样的工作 —— 零依赖让 TS 版与 Python 版站在同一起跑线。
 *
 * 与 ElementTree 对齐的语义（踩过坑的地方，见 SKILL.md）：
 *   - `iter()` 是含自身的深度优先前序遍历；
 *   - `find()` 只看**直接**子元素，不是后代；
 *   - 注释被丢弃，且注释里的文本不进入 text/tail；
 *   - 空元素序列化成 `<tag />`（斜杠前有一个空格）；
 *   - 属性值里的 \n \t \r 序列化成 `&#10;` `&#09;` `&#13;`（ElementTree 的 _escape_attrib）。
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

const ENTITY_RE = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g;

export function decodeEntities(text: string): string {
  if (text.indexOf("&") === -1) return text;
  return text.replace(ENTITY_RE, (whole: string, body: string) => {
    if (body.charAt(0) === "#") {
      const hex = body.charAt(1) === "x" || body.charAt(1) === "X";
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(cp)) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body];
    return named === undefined ? whole : named;
  });
}

export interface XmlElement {
  tag: string;
  attrib: Map<string, string>;
  children: XmlElement[];
  /** 第一个子元素之前的字符数据（ElementTree 语义）。 */
  text: string | null;
  /** 本元素结束后、下一个兄弟之前的字符数据。 */
  tail: string | null;
}

function makeElement(tag: string): XmlElement {
  return { tag, attrib: new Map(), children: [], text: null, tail: null };
}

class XmlParser {
  private readonly src: string;
  private i = 0;

  constructor(src: string) {
    this.src = src;
  }

  parseDocument(): XmlElement {
    this.skipProlog();
    const root = this.parseElement();
    return root;
  }

  private startsWith(token: string): boolean {
    return this.src.startsWith(token, this.i);
  }

  private skipWhitespace(): void {
    while (this.i < this.src.length) {
      const c = this.src.charAt(this.i);
      if (c === " " || c === "\t" || c === "\n" || c === "\r") this.i++;
      else break;
    }
  }

  private skipProlog(): void {
    for (;;) {
      this.skipWhitespace();
      if (this.startsWith("<?")) {
        const end = this.src.indexOf("?>", this.i);
        if (end < 0) throw new Error("XML: unterminated processing instruction");
        this.i = end + 2;
        continue;
      }
      if (this.startsWith("<!--")) {
        this.skipComment();
        continue;
      }
      if (this.startsWith("<!")) {
        const end = this.src.indexOf(">", this.i);
        if (end < 0) throw new Error("XML: unterminated declaration");
        this.i = end + 1;
        continue;
      }
      break;
    }
  }

  private skipComment(): void {
    const end = this.src.indexOf("-->", this.i + 4);
    if (end < 0) throw new Error("XML: unterminated comment");
    this.i = end + 3;
  }

  private readName(): string {
    const rest = this.src.slice(this.i);
    const m = /^[^\s/>=]+/.exec(rest);
    if (!m) throw new Error(`XML: expected a name at offset ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }

  private readAttributes(el: XmlElement): void {
    for (;;) {
      this.skipWhitespace();
      const c = this.src.charAt(this.i);
      if (c === "" || c === ">" || c === "/") return;
      const name = this.readName();
      this.skipWhitespace();
      if (this.src.charAt(this.i) !== "=") {
        el.attrib.set(name, "");
        continue;
      }
      this.i++;
      this.skipWhitespace();
      const quote = this.src.charAt(this.i);
      if (quote !== '"' && quote !== "'") {
        throw new Error(`XML: attribute ${name} value must be quoted`);
      }
      const end = this.src.indexOf(quote, this.i + 1);
      if (end < 0) throw new Error(`XML: unterminated value for attribute ${name}`);
      el.attrib.set(name, decodeEntities(this.src.slice(this.i + 1, end)));
      this.i = end + 1;
    }
  }

  private parseElement(): XmlElement {
    if (this.src.charAt(this.i) !== "<") {
      throw new Error(`XML: expected '<' at offset ${this.i}`);
    }
    this.i++;
    const tag = this.readName();
    const el = makeElement(tag);
    this.readAttributes(el);
    if (this.startsWith("/>")) {
      this.i += 2;
      return el;
    }
    if (this.src.charAt(this.i) !== ">") {
      throw new Error(`XML: malformed start tag <${tag}>`);
    }
    this.i++;

    let buf = "";
    const commit = (): void => {
      if (buf === "") return;
      const decoded = decodeEntities(buf);
      const last = el.children[el.children.length - 1];
      if (last === undefined) el.text = (el.text ?? "") + decoded;
      else last.tail = (last.tail ?? "") + decoded;
      buf = "";
    };

    for (;;) {
      if (this.i >= this.src.length) {
        throw new Error(`XML: unexpected end of input inside <${tag}>`);
      }
      if (this.startsWith("</")) {
        this.i += 2;
        const close = this.readName();
        if (close !== tag) {
          throw new Error(`XML: mismatched end tag </${close}> for <${tag}>`);
        }
        this.skipWhitespace();
        if (this.src.charAt(this.i) !== ">") {
          throw new Error(`XML: malformed end tag </${close}>`);
        }
        this.i++;
        commit();
        return el;
      }
      if (this.startsWith("<!--")) {
        commit();
        this.skipComment();
        continue;
      }
      if (this.startsWith("<![CDATA[")) {
        const end = this.src.indexOf("]]>", this.i + 9);
        if (end < 0) throw new Error("XML: unterminated CDATA section");
        buf += this.src.slice(this.i + 9, end);
        this.i = end + 3;
        continue;
      }
      if (this.src.charAt(this.i) === "<") {
        commit();
        el.children.push(this.parseElement());
        continue;
      }
      const next = this.src.indexOf("<", this.i);
      if (next < 0) {
        buf += this.src.slice(this.i);
        this.i = this.src.length;
      } else {
        buf += this.src.slice(this.i, next);
        this.i = next;
      }
    }
  }
}

export function parseXml(src: string): XmlElement {
  return new XmlParser(src).parseDocument();
}

function escapeXmlAttrib(value: string): string {
  let out = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  out = out.replace(/\r/g, "&#13;").replace(/\n/g, "&#10;").replace(/\t/g, "&#09;");
  return out;
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function writeElement(el: XmlElement, out: string[]): void {
  out.push("<", el.tag);
  for (const [key, value] of el.attrib) {
    out.push(" ", key, '="', escapeXmlAttrib(value), '"');
  }
  const hasText = el.text !== null && el.text !== "";
  if (!hasText && el.children.length === 0) {
    out.push(" />");
    return;
  }
  out.push(">");
  if (hasText) out.push(escapeXmlText(el.text as string));
  for (const child of el.children) {
    writeElement(child, out);
    if (child.tail !== null && child.tail !== "") out.push(escapeXmlText(child.tail));
  }
  out.push("</", el.tag, ">");
}

export function serializeXml(el: XmlElement): string {
  const out: string[] = [];
  writeElement(el, out);
  return out.join("");
}

/** 深度优先前序遍历，**包含**自身（ElementTree `iter()` 语义）。 */
export function* iterElements(el: XmlElement): Generator<XmlElement> {
  yield el;
  for (const child of el.children) yield* iterElements(child);
}

/** 只看直接子元素（ElementTree `find()` 语义，不是后代选择器）。 */
export function findChild(el: XmlElement, tag: string): XmlElement | null {
  for (const child of el.children) {
    if (child.tag === tag) return child;
  }
  return null;
}

export function findChildren(el: XmlElement, tag: string): XmlElement[] {
  return el.children.filter((child) => child.tag === tag);
}

export function attr(el: XmlElement, name: string): string | null {
  const value = el.attrib.get(name);
  return value === undefined ? null : value;
}

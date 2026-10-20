const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body><div id="c"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'https://localhost/',
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, 'location', {
  value: dom.window.location,
  configurable: true,
  writable: true,
});
global.XMLSerializer = dom.window.XMLSerializer;
global.DOMParser = dom.window.DOMParser;
global.HTMLElement = dom.window.HTMLElement;
global.Element = dom.window.Element;
global.Node = dom.window.Node;
global.Image = dom.window.Image;

const base = path.join(__dirname, 'node_modules', 'mxgraph', 'javascript', 'src');
const mx = require('mxgraph')({ mxBasePath: base, mxImageBasePath: path.join(base, 'images') });

const [, , inFile, outFile, padArg] = process.argv;
const pad = padArg ? parseInt(padArg, 10) : 10;

// draw.io 的 `shape=path` 是标准功能，但 mxGraph 核心不实现它（核心只注册
// box / customShape / sample），所以离线渲染会把它当矩形。这里补上，否则
// 生成器输出的五边形节点在本预览里看不出形状。
//
// 路径坐标按 160x60 的**设计尺寸**书写（与 drawio.py 的 NODE_W/NODE_H 一致），
// 绘制时按 cell 的实际 w/h 缩放。drawio.py 生成的 cell 本来就是 160x60，
// 所以即便 draw.io 客户端对 path 的缩放策略与这里不同，两边结果也一致。
function DrawcodePathShape() {
  mx.mxShape.call(this);
}
mx.mxUtils.extend(DrawcodePathShape, mx.mxShape);

DrawcodePathShape.prototype.paintVertexShape = function (c, x, y, w, h) {
  // 注意：这个 mxGraph 版本没有 mxConstants.STYLE_PATH 常量（undefined），
  // 所以必须用字面量 'path' 取，否则永远拿到空串、悄悄退回矩形。
  const raw = (this.style && this.style.path) || '';
  if (process.env.DRAWCODE_DEBUG_SHAPE) {
    console.error(
      `[shape] raw=${JSON.stringify(raw)} shape=${JSON.stringify(this.style && this.style.shape)} ` +
        `styleKeys=${this.style ? Object.keys(this.style).slice(0, 10).join(',') : 'none'}`,
    );
  }
  const pts = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((pair) => pair.split(',').map(Number));
  if (pts.length < 3 || pts.some((p) => p.length !== 2 || p.some(isNaN))) {
    // 路径无法解析时退回矩形，而不是画出一个破图
    c.rect(x, y, w, h);
    c.fillAndStroke();
    return;
  }
  const sx = w / 160;
  const sy = h / 60;
  c.begin();
  c.moveTo(x + pts[0][0] * sx, y + pts[0][1] * sy);
  for (let i = 1; i < pts.length; i++) {
    c.lineTo(x + pts[i][0] * sx, y + pts[i][1] * sy);
  }
  c.close();
  c.fillAndStroke();
};

mx.mxCellRenderer.registerShape('path', DrawcodePathShape);

const LINE_HEIGHT = mx.mxConstants.LINE_HEIGHT || 1.2;
const patchedGetSize = function (text, fontSize, fontFamily, textWidth, fontStyle) {
  const fs = fontSize != null ? fontSize : mx.mxConstants.DEFAULT_FONTSIZE;
  const raw = String(text == null ? '' : text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  const lines = raw.split('\n');
  let maxW = 0;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) {
      w += ch.codePointAt(0) > 0x2e7f ? fs : fs * 0.55;
    }
    maxW = Math.max(maxW, w);
  }
  return new mx.mxRectangle(0, 0, Math.ceil(maxW), Math.ceil(fs * LINE_HEIGHT * lines.length));
};

mx.mxUtils.getSizeForString = patchedGetSize;
if (mx.mxUtils.getSizeForString !== patchedGetSize) {
  Object.defineProperty(mx.mxUtils, 'getSizeForString', {
    value: patchedGetSize,
    writable: true,
    configurable: true,
  });
}
console.log(`patch applied=${mx.mxUtils.getSizeForString === patchedGetSize} sample=${JSON.stringify(mx.mxUtils.getSizeForString('ADC 采样()', 11, 'Arial'))}`);

function decodeDiagram(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('<')) return trimmed;
  const raw = Buffer.from(trimmed, 'base64');
  const xml = zlib.inflateRawSync(raw).toString('utf8');
  return decodeURIComponent(xml);
}

function loadModelElement(xml) {
  const parser = new dom.window.DOMParser();
  const parse = (s) => parser.parseFromString(s, 'text/xml');
  let doc = parse(xml);
  let el = doc.documentElement;
  if (el.nodeName === 'mxfile') {
    const diagrams = el.getElementsByTagName('diagram');
    let chosen = null;
    for (const d of diagrams) {
      if (d.getAttribute('name') === path.basename(inFile, '.drawio')) chosen = d;
    }
    if (!chosen) chosen = diagrams[0];
    if (chosen.firstElementChild) return chosen.firstElementChild;
    el = parse(decodeDiagram(chosen.textContent)).documentElement;
  }
  return el;
}

const xmlText = fs.readFileSync(inFile, 'utf8');
const modelEl = loadModelElement(xmlText);

const container = document.getElementById('c');
const graph = new mx.mxGraph(container);

const sheet = graph.getStylesheet();
for (const s of [sheet.getDefaultVertexStyle(), sheet.getDefaultEdgeStyle()]) {
  s[mx.mxConstants.STYLE_FONTCOLOR] = '#000000';
}
sheet.getDefaultVertexStyle()[mx.mxConstants.STYLE_FILLCOLOR] = '#ffffff';
sheet.getDefaultVertexStyle()[mx.mxConstants.STYLE_STROKECOLOR] = '#000000';

// draw.io 的样式串里，不含 '=' 的裸段（如 "swimlane"）引用的是**命名样式**：
// mxStylesheet.getCellStyle 拿它去查 this.styles[名]，命中就把那条样式的键值合并进来，
// 查不到就**把这一段静默丢掉**（见 view/mxStylesheet.js，else 分支没有兜底）。
// draw.io 客户端在初始化时注册了这批命名样式（swimlane → {shape:'swimlane'} 等），
// 裸 mxGraph 没有，于是 "swimlane;startSize=30;…" 里的 swimlane 被丢弃、容器退回矩形：
// 标题画到矩形正中，标题分隔线也不画。这里按已注册形状名补一份 {名: {shape: 名}}，
// 使裸段等价于 "shape=名"。键名直接取 mxCellRenderer.defaultShapes ——
// registerShape(key, shape) 就是以 mxConstants.SHAPE_* 的字面量（'rectangle'、'swimlane'…）为键。
// 带 '.' 的键是 mxgraph.xxx 模板形状名，不会作为裸段出现在样式串里，略过。
// STYLE_SHAPE 在本版本可能是 undefined（同第 49 行 STYLE_PATH 的坑），故回退字面量。
{
  const shapeKey = mx.mxConstants.STYLE_SHAPE || 'shape';
  for (const shapeName of Object.keys(mx.mxCellRenderer.defaultShapes)) {
    if (!shapeName.includes('.') && sheet.styles[shapeName] == null) {
      sheet.putCellStyle(shapeName, { [shapeKey]: shapeName });
    }
  }
}

for (const k of Object.keys(mx)) {
  if (typeof mx[k] === 'function' && window[k] == null) window[k] = mx[k];
}

const plainLabel = (v) =>
  v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();

const rootEl = modelEl.getElementsByTagName('root')[0];
if (rootEl) {
  const objs = Array.from(rootEl.getElementsByTagName('object'));
  for (const obj of objs) {
    const cell = Array.from(obj.children).find((e) => e.nodeName === 'mxCell');
    if (!cell) continue;
    for (const a of Array.from(obj.attributes)) {
      if (a.name === 'id') cell.setAttribute('id', a.value);
      else if (a.name === 'label') cell.setAttribute('value', plainLabel(a.value));
      else if (!cell.hasAttribute(a.name)) cell.setAttribute(a.name, a.value);
    }
    obj.parentNode.replaceChild(cell, obj);
  }

  for (const cell of Array.from(rootEl.getElementsByTagName('mxCell'))) {
    const v = cell.getAttribute('value');
    if (v && /<[a-zA-Z/]/.test(v)) cell.setAttribute('value', plainLabel(v));
    const st = cell.getAttribute('style');
    if (st && /html=1/.test(st)) cell.setAttribute('style', st.replace(/html=1/, 'html=0'));
  }
  console.log(`unwrapped=${objs.length} rootKids=${rootEl.children.length}`);
}

const codec = new mx.mxCodec(modelEl.ownerDocument);
codec.decode(modelEl, graph.getModel());
const dbg = graph.getModel();
console.log(`decoded: cells=${Object.keys(dbg.cells).length} rootChildren=${dbg.getChildCount(dbg.root)}`);
const layer = dbg.getChildAt(dbg.root, 0);
console.log(`layer=${layer && layer.id} layerChildren=${layer ? dbg.getChildCount(layer) : 'n/a'} modelEl=${modelEl.nodeName}`);
graph.view.validate();

const bounds = graph.getGraphBounds();
const w = Math.ceil(bounds.width) + pad * 2;
const h = Math.ceil(bounds.height) + pad * 2;

const svgDoc = document.implementation.createDocument('http://www.w3.org/2000/svg', 'svg', null);
const svgRoot = svgDoc.documentElement;
// 不要再 setAttribute('xmlns', …)：文档就是以这个命名空间 createDocument 出来的，
// 序列化器自己会写一遍，手工再加一笔就成了 `xmlns="…" xmlns="…"` 重复属性 ——
// 浏览器宽容，严格 XML 解析器（jsdom 的 text/xml、多数命令行工具）直接报错拒收。
// xmlns:xlink 相反必须显式写：不写的话序列化器会给每个 xlink 属性现造 nsN 前缀，
// 而 resvg 只认字面名字 href / xlink:href，认不出 ns1:href，图片会被静默丢掉。
svgRoot.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
svgRoot.setAttribute('version', '1.1');
svgRoot.setAttribute('width', String(w));
svgRoot.setAttribute('height', String(h));
// viewBox 的原点必须落在 `bounds - pad`，不能写 (0,0)。
// mxImageExport.drawState 是按**绝对坐标**画内容的（它不减去 bounds 原点），而画布尺寸只有
// bounds 那么大；原点写 (0,0) 时，bounds 原点一偏离 (0,0)，整张图就朝右下整体偏移，
// 右边和下边还会被裁掉一截 —— 只有 bounds 原点恰好接近 (0,0) 的图才看不出问题（示例图就是）。
// 下面那行白底矩形本来就是按 `pad - bounds` 画的（即假设视角原点在 bounds-pad），
// 把 viewBox 改成同一个原点，两者才对得上。宽度高度不变，图片像素尺寸因此也不变。
//
// 原点再**向下/向左取整**：bounds 的坐标是容器内卡片坐标累加出来的，通常是小数，
// 于是白底矩形的边落在像素格中间，光栅化后最右和最上一列只被覆盖一半 —— PNG 拿
// 出来看就是贴着上边和右边的一道半透明细缝（在深色背景的看图器里像一条黑边）。
// 把 viewBox 起点 floor、终点 ceil，矩形四条边正好压在像素边界上，白底就铺满了。
const ox = Math.floor(bounds.x - pad);
const oy = Math.floor(bounds.y - pad);
const ow = Math.ceil(bounds.x - pad + w) - ox;
const oh = Math.ceil(bounds.y - pad + h) - oy;
svgRoot.setAttribute('viewBox', `${ox} ${oy} ${ow} ${oh}`);

const canvas = new mx.mxSvgCanvas2D(svgRoot);
canvas.rect(ox, oy, ow, oh);
canvas.setFillColor('#ffffff');
canvas.setStrokeColor('none');
canvas.fillAndStroke();
canvas.setFillColor('none');

const exportImage = new mx.mxImageExport();
const rootState = graph.getView().getState(graph.getModel().root);

const seenText = new Set();
const origDrawText = mx.mxImageExport.prototype.drawText;
mx.mxImageExport.prototype.drawText = function (state, canvas) {
  const t = state.text;
  if (t != null) {
    if (!seenText.has(t)) {
      seenText.add(t);
      if (seenText.size <= 3) {
        console.log(`text: ctor=${t.constructor && t.constructor.name} checkBounds=${typeof t.checkBounds} value=${JSON.stringify(t.value)}`);
      }
    }
    if (typeof t.checkBounds !== 'function') t.checkBounds = mx.mxText.prototype.checkBounds;
  }
  return origDrawText.apply(this, arguments);
};

exportImage.drawState(rootState, canvas);
console.log(`textSeen=${seenText.size}`);

const svgStr0 = new dom.window.XMLSerializer().serializeToString(svgRoot);

// 图片路径归一化。JSDOM 的文档 URL 是 https://localhost/（见文件头），而 mxGraph 画
// `shape=image` 时会拿 `image=…` 去解析成**绝对 URL**，于是设备图片在导出的 SVG 里成了
// `href="https://localhost/图片/xx.png"` —— 浏览器打开必然裂图，而 .drawio 里存的是相对路径。
// 这里把那个假域名前缀摘掉，还原成 .drawio 里写的相对路径；SVG 与图片目录放在一起即可显示。
// 只摘这个字面前缀，真实的 http(s) 外链（如 assets/ads1115.svg 之外的网络图）不动。
const DUMMY_BASE = 'https://localhost/';
const rebased = (svgStr0.match(/href="https:\/\/localhost\//g) || []).length;

// 命名空间前缀归一化。JSDOM 的 XMLSerializer 会给每个 xlink 属性**现造一个前缀**
// （`xmlns:ns1="http://www.w3.org/1999/xlink" ns1:href="…"`，一张图里 ns1…ns12），
// 而不是复用根上已声明的 xlink。浏览器按命名空间解析，看不出差别；但有些渲染器
// （resvg/usvg，本工具 PNG 那一步就是它）只认字面属性名 `href` / `xlink:href`，
// 认不出 `ns1:href` —— 结果是图片被**静默丢掉**：SVG 在浏览器里正常，PNG 里卡片全没了。
// 所以这里统一降级成 SVG2 的裸 `href`（xlink 命名空间本来就是废弃写法），并摘掉那些
// 只为它存在的命名空间声明；根上已有的 xmlns:xlink 声明保留，别的属主不受影响。
const svgStr = svgStr0
  .replace(/\s+xmlns:ns\d+="http:\/\/www\.w3\.org\/1999\/xlink"/g, '')
  .replace(/ns\d+:href=/g, 'href=')
  .split(`href="${DUMMY_BASE}`)
  .join('href="');

if (rebased > 0) console.log(`rebased ${rebased} image href(s) off ${DUMMY_BASE}`);

fs.writeFileSync(outFile, svgStr);

console.log(`cells=${graph.getModel().getChildCount(graph.getModel().root)}`);
console.log(`bounds=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
console.log(`canvas=${w}x${h} bytes=${svgStr.length}`);

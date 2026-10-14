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
svgRoot.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
svgRoot.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
svgRoot.setAttribute('version', '1.1');
svgRoot.setAttribute('width', String(w));
svgRoot.setAttribute('height', String(h));
svgRoot.setAttribute('viewBox', `0 0 ${w} ${h}`);

const canvas = new mx.mxSvgCanvas2D(svgRoot);
canvas.rect(pad - bounds.x, pad - bounds.y, w, h);
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

const svgStr = new dom.window.XMLSerializer().serializeToString(svgRoot);
fs.writeFileSync(outFile, svgStr);

console.log(`cells=${graph.getModel().getChildCount(graph.getModel().root)}`);
console.log(`bounds=${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`);
console.log(`canvas=${w}x${h} bytes=${svgStr.length}`);

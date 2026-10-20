/**
 * 把导出的 SVG 裁一块出来放大，用于**肉眼复核大图**。
 *
 * 为什么需要它：一张两千像素宽的图上，12 张卡片的名字、边上的标签只有 10~13px，
 * 直接看整图的缩略图时，相邻的两段文字会被降采样糊成一段 —— 人（和模型）会据此
 * 报出根本不存在的「文字重叠」。放大到 2~3 倍、只看一小块，才有资格下结论。
 *
 * 做法是**改根元素的 viewBox**，不是嵌套 <svg>/<image>：resvg 能把裁剪框画出来，
 * 但会把嵌套 SVG 里的文字整段丢掉（试过，文字全没了）。
 * **更正**：本文件早先写过「resvg 的 crop / fitTo 在本机实测无效」。那是假象 ——
 * 两者都有效，但只**要在选项里同时出现 `resourcesDir`，它们就双双被静默丢弃**，
 * 输出悄悄回落到源尺寸。实测与正解见 render_png.js 头部那段长注释。
 * 本文件仍然用 viewBox 裁剪：改 viewBox 是**矢量**层面的取景，与渲染尺寸解耦，
 * 放大多少倍都不会降采样，比在像素空间裁更干净。
 *
 * 用法：node zoom_svg.js <in.svg> <out.svg> <x> <y> <w> <h> [scale]
 *   x,y,w,h 用的是 **SVG 自己的用户坐标**（= 原 viewBox 的坐标系），不是像素；
 *   想按像素框选的话先看一眼原 SVG 的 viewBox 与 width/height 换算一次。
 *   scale 默认 3。输出 SVG 的 width/height = w*scale / h*scale，viewBox 不变，
 *   于是渲染出来就是「这一块，放这么大」。
 */
const fs = require('node:fs');

const [, , inFile, outFile, xs, ys, ws, hs, scaleArg] = process.argv;
if (!inFile || !outFile || xs === undefined || ys === undefined || ws === undefined || hs === undefined) {
  console.error('usage: node zoom_svg.js <in.svg> <out.svg> <x> <y> <w> <h> [scale]');
  process.exit(2);
}
const [x, y, w, h] = [xs, ys, ws, hs].map(Number);
if ([x, y, w, h].some((v) => !Number.isFinite(v)) || w <= 0 || h <= 0) {
  console.error('x/y/w/h 必须是数字，且 w、h 为正');
  process.exit(2);
}
const scale = scaleArg ? Number(scaleArg) : 3;

const svg = fs.readFileSync(inFile, 'utf8');

// 只改根标签上的三个属性；正文一个字都不动（正文里可能有 <image href>，
// 那些是相对路径，必须保持原样，否则放大图就丢图片了）
const openTag = /<svg\b[^>]*>/.exec(svg);
if (openTag === null) {
  console.error(`${inFile} 里找不到 <svg> 根标签`);
  process.exit(2);
}
const oldViewBox = /\bviewBox="([^"]*)"/.exec(openTag[0]);
if (oldViewBox === null) {
  console.error('根 <svg> 上没有 viewBox，无法确定用户坐标系');
  process.exit(2);
}
const [vx, vy, vw, vh] = oldViewBox[1].trim().split(/[\s,]+/).map(Number);

// 越界只提示、不拦：裁到画布外面渲染出来是白底，肉眼一看就知道框错了
if (x < vx || y < vy || x + w > vx + vw || y + h > vy + vh) {
  console.error(
    `注意：裁剪框超出原 viewBox [${vx} ${vy} ${vw} ${vh}]，框外会是白底。` +
      `原图内容范围大约 x ${vx}~${vx + vw}，y ${vy}~${vy + vh}。`,
  );
}

let newTag = openTag[0]
  .replace(/\bviewBox="[^"]*"/, `viewBox="${x} ${y} ${w} ${h}"`)
  .replace(/\bwidth="[^"]*"/, `width="${w * scale}"`)
  .replace(/\bheight="[^"]*"/, `height="${h * scale}"`);
if (!/\bwidth="/.test(openTag[0])) newTag = newTag.replace('<svg', `<svg width="${w * scale}"`);
if (!/\bheight="/.test(openTag[0])) newTag = newTag.replace('<svg', `<svg height="${h * scale}"`);

fs.writeFileSync(outFile, svg.replace(openTag[0], newTag), 'utf8');
console.log(
  `裁剪 [${x},${y} ${w}x${h}] ×${scale} -> ${outFile}（原 viewBox ${oldViewBox[1]}，共 ${vw}x${vh}）`,
);

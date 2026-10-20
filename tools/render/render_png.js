const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const [, , inFile, outFile, widthArg, resArg, cropArg] = process.argv;
const svg = fs.readFileSync(inFile);
const width = widthArg ? parseInt(widthArg, 10) : 0;

// 局部放大：第 6 个位置参数 `x,y,w,h`。总览图动辄 1600x1300，整图缩到一屏后
// 十几号字根本看不清有没有压线/断行；把出图尺寸调大再交给看图方，也会被再缩回去。
// 所以裁剪必须发生在**渲染这一步**。
//
// 注意 crop 的坐标系：是**渲染后的像素**，不是 SVG 用户坐标 —— 窗口左上角 = (用户坐标 - viewBox 原点) * (目标宽度 / SVG 宽度)。
// （实测：`fitTo width=2400` + `crop 360x190` → 出图正好 360x190，窗口是设备像素、1:1 取窗。）
// 拿 `<text x=…>` 里量到的用户坐标直接喂进来会裁到别处 —— 要按上面的换算来，
// 或者用 `%TEMP%/ais_crop/crop_user.js` 那种按用户坐标换算的小包装。
// 两个一起用即「先放大、再取窗」，得到的是局部的高清图。
const crop = cropArg
  ? (() => {
      const [x, y, w, h] = cropArg.split(',').map(Number);
      if ([x, y, w, h].some((v) => !Number.isFinite(v)) || w <= 0 || h <= 0) {
        throw new Error(`第 6 个参数应为 x,y,w,h 四个数，收到：${cropArg}`);
      }
      return { left: x, top: y, right: x + w, bottom: y + h };
    })()
  : undefined;

// 相对图片引用（`<image href="图片/设备-xx.png">`）：
// resvg 默认**不去读外部文件**（它不像浏览器那样按文档位置解析相对路径），于是设备卡片上的照片
// 在 PNG 里会整块消失 —— SVG 打开却正常。这是预览工具链的坑，不是图的问题。
//
// 基准目录：默认取输入 SVG 所在目录，与「.drawio 里的相对路径是相对 .drawio 自身」这套约定一致。
// 第 5 个位置参数可以改掉它。
//
// **不要**把这个目录交给 `resourcesDir` 选项：resvg-js 2.6.2 里，选项里一旦出现 resourcesDir，
// `fitTo` 和 `crop` 就双双被丢掉，输出悄悄回落到 SVG 的原始尺寸 —— 不报错、不警告。
// 实测（同一份 SVG、同一批选项）：`{fitTo:width:100}` → 100x50；加 `crop` → 50x30；
// 再加 `resourcesDir` → 400x200（源尺寸，缩放与裁剪全丢）。
// 这个坑很贵：以为自己在看局部放大图，其实一直是整图，"局部"两字是假的。
//
// 正道是绑定自带的 `imagesToResolve()` / `resolveImage()`：先把要的图片文件读成 Buffer 喂进去，
// 选项里就不必出现 resourcesDir 了。见 js-binding.d.ts。
const resourcesDir = resArg ? path.resolve(resArg) : path.dirname(path.resolve(inFile));

const resvg = new Resvg(svg, {
  fitTo: width ? { mode: 'width', value: width } : { mode: 'original' },
  background: '#ffffff',
  font: {
    loadSystemFonts: true,
    defaultFontFamily: 'Arial',
  },
  crop,
});

// 图片用「问它要什么、就给它读什么」的方式喂：缺失的图片只跳过，不让整张图渲染失败
for (const href of resvg.imagesToResolve()) {
  const file = path.resolve(resourcesDir, decodeURIComponent(href));
  if (fs.existsSync(file)) resvg.resolveImage(href, fs.readFileSync(file));
}

const img = resvg.render();
const png = img.asPng();
fs.writeFileSync(outFile, png);
// 报的是**位图**尺寸：`resvg.width` 是源 SVG 的宽度（2059 那种），拿它当"我渲染成了多大"会骗人
console.log(`${outFile} ${png.length} bytes ${img.width}x${img.height}`);

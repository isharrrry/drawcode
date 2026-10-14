# tools/render — 离线把 `.drawio` 渲成图片

用 **draw.io 自己的渲染内核 mxGraph** 出图，不需要装 draw.io 桌面版、不需要 GUI。

```bash
cd tools/render
npm install

node render_drawio.js  input.drawio output.svg 10    # .drawio -> SVG（mxGraph 引擎）
node render_png.js     output.svg   output.png 2022  # SVG -> PNG（resvg）
```

## 为什么要这么绕

draw.io 桌面版是 Electron 应用，**无法在无窗口的服务器/CI 里驱动**（实测三条路都堵死：Session 0 窗口被拒 `0x5`、绿色版崩溃 `0x80000003`、静默安装要提权）。但 `mxgraph` 是它开源的渲染内核，能在 Node + jsdom 里直接跑——**让 draw.io 自己出图**，而不是自己重画一遍。

自己重画（比如手写 SVG）看似简单，实际会在中文换行、箭头裁剪、正交路由圆角、连线避让上全面失真——这些正是 mxGraph 已经做对的。

## 两个已知限制（诚实说明）

1. **画不出 `jumpStyle=arc` 的跳线。** `jumpStyle` 是 draw.io 自己扩展的属性，**mxGraph 核心没有**（在 `mxgraph/javascript/src` 里 grep 零匹配）。生成的 `.drawio` 配置对 draw.io 客户端有效，但这个离线渲染器不显示跳线。**要验证跳线效果，必须用 draw.io 打开 `.drawio` 文件。**
2. **中文文字测量是估算的。** jsdom 没有排版引擎，`offsetWidth` 恒为 0，mxGraph 拿不到真实字宽，所以 `getSizeForString` 被打了补丁（CJK 按 `fontSize` 全宽、ASCII 按 `0.55×fontSize` 估算）。对**文字渲染**无影响（SVG 用 `text-anchor` 定位），但依赖文字测量的**标签避让**可能不准。要彻底解决需引入 node-canvas 提供真实测量。

## 依赖归属

`mxgraph` / `jsdom` / `@resvg/resvg-js` **只属于本工具目录**。三个语言实现（`python/`、`typescript/`、`dotnet/`）都零第三方运行时依赖——否则性能基准就不可比了。

## 已知依赖风险

`npm install` 会报：

```
npm warn deprecated mxgraph@4.2.2: Package no longer supported. Use at your own risk
```

**这是真的**：上游 jgraph 已把 mxGraph 归档，转向 TypeScript 重写（maxGraph）。本工具钉在 `mxgraph@4.2.2`——最后一个 JS 版本——因为 draw.io 桌面版本身就是基于它，用它才能保证渲染结果与 draw.io 客户端一致。

后果要说清：

- 这个包**不会再收到修复**。它是**开发/展示工具**，不参与 `drawcode` 的产物生成，也不参与性能基准，所以风险被限制在这一层。
- 若上游渲染行为需要在未来跟进，替代路径是切换到 maxGraph，但那会引入与 draw.io 客户端的渲染差异，需要重新核对。
- `jsdom` / `@resvg/resvg-js` 仍在维护。

## 验证记录

在本机实跑过（Windows 11 / Node 24.16.0）：

```
npm.cmd install --no-audit --no-fund     → added 39 packages in 3s
node render_drawio.js expected.drawio out.svg 10
                                         → canvas=1011x395 bytes=5450
node render_png.js out.svg out.png 800   → 1011x395, 25307 bytes
```

注意 Windows 上要用 **`npm.cmd`** 而不是 `npm`：PowerShell 的默认执行策略会拒绝 `npm.ps1`，报 `cannot be loaded because running scripts is disabled`。

/**
 * 打包 VSIX：扩展代码 + 解析核心 + 框架依赖的 .NET sidecar。
 *
 * 发布策略是「不携带、不裁剪 .NET 运行时」：sidecar 只发
 * `dll + deps.json + runtimeconfig.json`，目标机必须有 .NET 10+ 运行时。
 * 这样一份通用 VSIX 可以同时装在 Windows 与 Linux 上；缺少运行时时扩展会给出
 * 安装指引（见 `typescript/src/artifact/dotnet.ts`），而不是空白页。
 *
 * 为什么自己写而不用 `vsce package`：
 *   - 本机没有 vsce 依赖，安装它只为打一个包不划算；
 *   - VSIX 就是一个 ZIP：根目录放 `[Content_Types].xml` 与 `extension.vsixmanifest`，
 *     其余文件在 `extension/` 下。结构稳定且短，自己写反而能精确控制「哪些文件进包」。
 *
 * 为什么必须把 sidecar 发进去：
 *   PE/CLI 元数据由 `tools/drawcode-metadata` 读取。安装后的扩展目录里没有仓库，
 *   如果 sidecar 不随包走，打开 DLL 就只剩一条 tool-unavailable 诊断。
 *
 * ZIP 用 store（不压缩）：整个包只有几百 KB，省掉 deflate 实现与兼容性风险。
 * 文件名统一 UTF-8（general purpose flag 0x0800），避免中文路径在解压时乱码。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..", "..");

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** 必须存在的构建产物；缺一个都说明 `npm run build` 没跑或跑失败了。 */
const REQUIRED = [
  "dist/extension.js",
  "dist/coreWorker.js",
  "dist/core/artifact/read.js",
  "dist/core/artifact/inspect.js",
  "media/main.js",
];

/**
 * Marketplace 说明页的唯一来源是仓库的 docs 页面，不是扩展目录里的副本。
 * VSIX 规范要求它叫 `extension/README.md`，所以复制时改名；文档本身住在 docs/。
 */
const README_SOURCE = path.join(REPO, "docs", "vscode-extension.md");

/**
 * MIT 要求许可与版权声明随所有副本分发，而 `vsce` 会自带仓库根的 LICENSE。
 * 这里是自写打包器，不补这一步安装后的扩展目录里就只有 `license: MIT` 字段、
 * 没有正文，等于许可声明不完整。
 */
const LICENSE_SOURCE = path.join(REPO, "LICENSE");

/**
 * 市场页的 Changelog 标签只读包内的 `extension/CHANGELOG.md`。
 * 仓库根的同名文件是唯一来源，打包时复制，不在这里维护第二份。
 */
const CHANGELOG_SOURCE = path.join(REPO, "CHANGELOG.md");

/**
 * 把 docs 页面变成 VSIX 里的说明页。只做三处删除，不做渲染：
 *   - YAML frontmatter 是文档站的元数据，市场页会把它当正文显示；
 *   - 顶部的「← 文档索引」与末尾的「相关」小节都指向别的 docs 页面，
 *     而 VSIX 只带这一份说明，留着就是死链。
 * 其余正文原样保留，避免在打包脚本里维护第二套 Markdown 逻辑。
 */
function readmeForVsix() {
  if (!fs.existsSync(README_SOURCE)) fail(`缺少文档页：${README_SOURCE}`);
  const text = fs.readFileSync(README_SOURCE, "utf8");
  const body = text.startsWith("---\n") ? text.slice(text.indexOf("\n---\n", 4) + 5) : text;
  return body
    .replace(/^\[←[^\n]*\]\(index[^)\n]*\)\n\n?/m, "")
    .replace(/\n## 相关\n[\s\S]*$/, "\n");
}

function fail(message) {
  console.error(`package-vsix: ${message}`);
  process.exit(1);
}

// ZIP 的 CRC32（与 zlib 的 crc32 同多项式，但手写以兼容任何 Node 版本）。
// 必须在下面的打包流程执行前初始化：const 有暂时性死区，函数声明虽提升，
// 但函数体里引用它时不会自动延后。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

for (const relative of REQUIRED) {
  if (!fs.existsSync(path.join(ROOT, relative))) {
    fail(`缺少 ${relative}；请先运行 npm run build`);
  }
}

// icon 是 Marketplace 列表页唯一的视觉标识。声明了却不存在时，让打包失败而不是
// 生成一个 manifest 指向空路径的 VSIX。
if (pkg.icon && !fs.existsSync(path.join(ROOT, pkg.icon))) {
  fail(`缺少图标：${pkg.icon}`);
}

/** 递归复制，filter 收到相对源目录的 POSIX 路径。 */
function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const relative = path.relative(from, source).split(path.sep).join("/");
    if (!filter(relative)) continue;
    if (entry.isDirectory()) copyDir(source, target, filter);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), "drawcode-vsix-"));
const extensionDir = path.join(stage, "extension");

try {
  // ── 1. 扩展本体 ────────────────────────────────────────────────────────
  copyDir(path.join(ROOT, "dist"), path.join(extensionDir, "dist"), (rel) => {
    // 测试与 source map 不进安装包：前者依赖 VS Code 测试宿主，后者只会增大体积。
    if (rel === "test" || rel.startsWith("test/")) return false;
    if (rel.endsWith(".map")) return false;
    return true;
  });
  copyDir(path.join(ROOT, "media"), path.join(extensionDir, "media"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(extensionDir, "package.json"));
  fs.writeFileSync(path.join(extensionDir, "README.md"), readmeForVsix());
  if (!fs.existsSync(LICENSE_SOURCE)) fail(`缺少许可证文件：${LICENSE_SOURCE}`);
  fs.copyFileSync(LICENSE_SOURCE, path.join(extensionDir, "LICENSE"));
  if (fs.existsSync(CHANGELOG_SOURCE)) {
    fs.copyFileSync(CHANGELOG_SOURCE, path.join(extensionDir, "CHANGELOG.md"));
  }

  // ── 2. sidecar：每次现发布，避免包进上一次的旧 dll ────────────────────
  const sidecarProject = path.join(REPO, "tools", "drawcode-metadata", "DrawcodeMetadata.csproj");
  if (!fs.existsSync(sidecarProject)) fail(`找不到 sidecar 工程：${sidecarProject}`);
  const sidecarOut = path.join(stage, "sidecar");
  console.log("publish sidecar ->", sidecarOut);
  execFileSync(
    "dotnet",
    [
      "publish",
      sidecarProject,
      "-c",
      "Release",
      "-o",
      sidecarOut,
      // 显式关掉自包含与裁剪：机器上可能残留全局 SelfContained / PublishTrimmed，
      // 不能让 VSIX 悄悄变成「带运行时」或「被裁剪」的包。发布策略固定为框架依赖。
      "--self-contained",
      "false",
      "-p:PublishTrimmed=false",
      "--nologo",
      "-v",
      "quiet",
    ],
    { stdio: "inherit" },
  );

  const sidecarTarget = path.join(
    extensionDir,
    "tools",
    "drawcode-metadata",
    "bin",
    "Release",
    "net10.0",
  );
  fs.mkdirSync(sidecarTarget, { recursive: true });
  // .exe 是 apphost，.pdb 是调试符号：运行 `dotnet <dll>` 都用不到。
  const sidecarFiles = [
    "drawcode-metadata.dll",
    "drawcode-metadata.deps.json",
    "drawcode-metadata.runtimeconfig.json",
  ];
  for (const name of sidecarFiles) {
    const source = path.join(sidecarOut, name);
    if (!fs.existsSync(source)) fail(`sidecar 发布产物缺少 ${name}`);
    fs.copyFileSync(source, path.join(sidecarTarget, name));
  }

  // 守卫发布形态：VSIX 绝不能携带 .NET 运行时（用户明确要求不包含、不裁剪）。
  // runtimeconfig 里出现 includedFrameworks 就说明是自包含发布；缺 framework
  // 则说明发布参数被全局属性改写了。两者都必须让打包失败，而不是悄悄进包。
  const runtimeConfigPath = path.join(sidecarOut, "drawcode-metadata.runtimeconfig.json");
  const runtimeConfig = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8"));
  const runtimeOptions = runtimeConfig.runtimeOptions ?? {};
  if (runtimeOptions.includedFrameworks !== undefined) {
    fail("sidecar 是自包含发布（runtimeconfig.includedFrameworks 存在）；VSIX 不允许携带运行时");
  }
  if (runtimeOptions.framework === undefined) {
    fail("sidecar 不是框架依赖发布（runtimeconfig 缺少 framework）");
  }

  // publish 的原始输出在 stage 根下；不回删的话 zip 里会多出一份 `sidecar/`
  // （含用不到的 .exe 与 .pdb），等于把同一个 dll 打包两遍。
  fs.rmSync(sidecarOut, { recursive: true, force: true });

  // ── 3. VSIX 的两个清单 ────────────────────────────────────────────────
  const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".css" ContentType="text/css" />
  <Default Extension=".html" ContentType="text/html" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
  <Default Extension=".dll" ContentType="application/octet-stream" />
  <Default Extension=".exe" ContentType="application/octet-stream" />
</Types>
`;
  const escapeXml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  // Marketplace 的图标不是随包附带就够了，必须在 vsixmanifest 里声明成 Assets；
  // 未配置 icon 时不生成该行，保持旧包结构不变。
  const iconAsset = pkg.icon
    ? `\n    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${escapeXml(pkg.icon)}" Addressable="true" />`
    : "";
  const iconElement = pkg.icon ? `\n    <Icon>extension/${escapeXml(pkg.icon)}</Icon>` : "";

  // 许可证同理：正文随包复制还不够，市场页的「License」链接读的是 License Asset。
  const licenseAsset =
    '\n    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />';

  // 分类与标签只从 manifest 读（package.json 的同名字段不会自动带进去），
  // 缺这两行时市场页的分类与标签区域就是空的。
  const listElement = (tag, value) =>
    Array.isArray(value) && value.length > 0
      ? `\n    <${tag}>${escapeXml(value.join(","))}</${tag}>`
      : "";
  const tagsElement = listElement("Tags", pkg.keywords);
  const categoriesElement = listElement("Categories", pkg.categories);

  // 仓库与问题页链接属于展示型元数据：字段缺失时整行不生成，避免写出空 href。
  const repositoryUrl =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  const linkProperties = [
    ["Microsoft.VisualStudio.Services.Links.Source", repositoryUrl],
    ["Microsoft.VisualStudio.Services.Links.Getstarted", repositoryUrl],
    ["Microsoft.VisualStudio.Services.Links.GitHub", repositoryUrl],
    ["Microsoft.VisualStudio.Services.Links.Support", pkg.bugs?.url],
    ["Microsoft.VisualStudio.Services.Links.Learn", pkg.homepage],
  ]
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([id, value]) => `\n      <Property Id="${id}" Value="${escapeXml(value)}" />`)
    .join("");

  // Changelog 同样是「随包附带不够，必须声明」：未声明时市场页的该标签为空白。
  const changelogAsset = fs.existsSync(CHANGELOG_SOURCE)
    ? `\n    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />`
    : "";

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${escapeXml(pkg.name)}" Version="${escapeXml(pkg.version)}" Publisher="${escapeXml(pkg.publisher)}" />
    <DisplayName>${escapeXml(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${escapeXml(pkg.description)}</Description>${tagsElement}${categoriesElement}
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${escapeXml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />${linkProperties}
    </Properties>
    <License>extension/LICENSE</License>${iconElement}
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />${changelogAsset}${licenseAsset}${iconAsset}
  </Assets>
</PackageManifest>
`;

  fs.writeFileSync(path.join(stage, "[Content_Types].xml"), contentTypes);
  fs.writeFileSync(path.join(stage, "extension.vsixmanifest"), manifest);

  // ── 4. 打 ZIP ─────────────────────────────────────────────────────────
  const entries = [];
  collect(stage, stage, entries);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const outDir = path.join(ROOT, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${pkg.name}-${pkg.version}.vsix`);
  fs.writeFileSync(outFile, buildZip(entries));

  const size = fs.statSync(outFile).size;
  console.log(`package-vsix: ${entries.length} 个文件，${(size / 1024).toFixed(1)} KB`);
  console.log(`package-vsix: -> ${outFile}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

/** 收集所有文件为 { name, data }；name 用 POSIX 分隔符。 */
function collect(root, dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(root, full, out);
    else if (entry.isFile()) {
      out.push({
        name: path.relative(root, full).split(path.sep).join("/"),
        data: fs.readFileSync(full),
      });
    }
  }
}

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 最小 ZIP 写入器：仅 store（method 0），UTF-8 文件名。
 *
 * 固定时间戳（1980-01-01）让同一个源码树产出逐字节相同的包，
 * 方便比对「这次打包到底多了什么」。
 */
function buildZip(entries) {
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021; // 1980-01-01
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * 命令行入口：`build`（源码 -> .drawio）、`sync`（.drawio -> 源码声明层）。
 * 参数集合与退出码是 CLI 契约；早期的 Python / .NET 实现接受同一组参数，已于 2026-10-21 退役。
 *
 * 两个"宁可大声失败"的地方（都曾经静默出错）：
 *
 *   - `--layout-from` 指向的文件**不存在**，或**不含 drawcode 节点**时，直接报错退出。
 *     手画的 draw.io 文档是裸 `<mxCell>`、没有 symbolId，拿它当布局源会**静默把所有节点
 *     丢到 0,0**；而用户显式传了这个参数，说明他期望复用布局，此时"什么都不做"是错的。
 *   - 退出码约定与另外两版一致：参数错 2，正常 0。
 */

import * as nodePath from "node:path";
import { parseArgs } from "node:util";

import { adoptForeign } from "./adopt.ts";
import { canonicalArtifactJson } from "./artifact/inspect.ts";
import { readArtifact } from "./artifact/read.ts";
import { syncSource } from "./codegen.ts";
import { applyLayout, readLayout, toDrawio } from "./drawio.ts";
import { dumpIrJson } from "./dump.ts";
import {
  abspath,
  basename,
  dirname,
  ensureDir,
  exists,
  readTextFile,
  relPath,
  stem,
  writeTextFile,
} from "./fsutil.ts";
import { collapseSignals } from "./model.ts";
import { parseAny } from "./parse.ts";
import { SVG_PADDING, toSvg } from "./svg.ts";

const USAGE = `usage: drawcode <build|sync> ...

  build <files...> [--root DIR] [--out FILE] [--merge] [--inline] [--cards] [--no-rw-labels] [--layout-from FILE] [--svg FILE]
        source code -> .drawio (one diagram per module unless --merge)

        --inline folds a signal that has exactly one writer and one reader into a direct
        writer -> reader edge; the signal node disappears and its unit becomes the edge
        label. Signals with several readers stay as nodes (they are real junctions).

        --cards draws a func carrying asset="..." as an image card: the picture fills the
        node box and its name sits underneath. Off by default -- asset is plain metadata
        then, which is what the shared goldens pin down.

        --no-rw-labels drops the read/write labels on edges that end at a signal node. Those
        labels only restate the arrow direction, and on a diagram with dozens of edges they
        bury the content. Node-to-signal edges keep their labels by default (goldens).

        --straight-edges draws every edge as a direct line instead of the obstacle-avoiding
        orthogonal route. Auto-computed bends are dropped; bends that came from
        --layout-from are kept, because a human put them there on purpose. The exit and
        entry anchors survive, so a line still leaves and enters the side it used to.

  sync <FILE.drawio> <files...> [--root DIR] [--write]
        .drawio -> source code (declaration layer only)

  dump-ir <files...> [--root DIR] [--out FILE]
        parsed IR as canonical JSON, for L1 conformance comparison
        (write to stdout when --out is omitted; this is also how the goldens are regenerated)

  inspect <artifact> [--out FILE] [--infer-edges]
        compiled artifact (.dll/.so/.out/.a/.o) as canonical JSON
        (write to stdout when --out is omitted; exit 0 even when the file
        carries no drawcode metadata -- diagnostics are part of the model)

Source code is the single source of truth; the diagram is a derived view.`;

/** 同名不同扩展名 = 同一个模块（dsp.h 与 dsp.c 是一个模块的两个面）。*/
const SIBLING_EXTS = [".h", ".c", ".hpp", ".cpp", ".cc", ".cs"];

/**
 * 给一个文件，就把它同名的兄弟文件一起带上。
 *
 * `build dsp.h` 和 `build dsp.c` 都应当指「dsp 这个模块」——用户不该为了画一张图
 * 而把同一个模块的两个扩展名都写出来。找不到兄弟文件时原样保留。
 */
function expandModules(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of files) {
    const d = dirname(abspath(f));
    const name = stem(basename(f));
    const sibs = SIBLING_EXTS.map((e) => `${d}/${name}${e}`).filter((p) => exists(p));
    for (const p of sibs.length > 0 ? sibs : [abspath(f)]) {
      const key = p.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(p);
      }
    }
  }
  return out;
}

/** 模块旁的 `<模块名>.drawio`。*/
function defaultOut(path: string): string {
  return abspath(path).replace(/\.[^./\\]*$/, "") + ".drawio";
}

interface Plan {
  files: string[];
  out: string;
}

/**
 * 决定产出几张图、各自包含哪些文件、写到哪里。
 *
 * 默认**一个模块一张图**：把不相干的模块硬塞进一张图，读的人得先在一堆框里
 * 找自己要的那块。只有 `--merge` 才合成一张总览图。
 */
function planBuild(files: string[], out: string | undefined, merge: boolean): Plan[] {
  if (merge) {
    return [{ files, out: abspath(out ?? "flow.drawio") }];
  }

  const modules = new Map<string, string[]>();
  for (const f of files) {
    const name = stem(basename(f));
    const list = modules.get(name);
    if (list === undefined) modules.set(name, [f]);
    else list.push(f);
  }

  if (modules.size === 1) {
    const [, members] = [...modules.entries()][0] as [string, string[]];
    return [{ files: members, out: abspath(out ?? defaultOut(members[0] as string)) }];
  }

  if (out !== undefined) {
    throw new Error(
      `--out names a single file, but ${modules.size} modules were given: ` +
        `${[...modules.keys()].sort().join(", ")}\n` +
        "Leave --out off to get one .drawio per module (next to each module),\n" +
        "or pass --merge to put them all in one file.",
    );
  }
  return [...modules.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, members]) => ({ files: members, out: defaultOut(members[0] as string) }));
}

function parse(argv: string[]): {
  cmd: string;
  values: Record<string, unknown>;
  positionals: string[];
} | null {
  const [cmd, ...rest] = argv;
  if (cmd === "build") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        root: { type: "string" },
        out: { type: "string" },
        merge: { type: "boolean" },
        inline: { type: "boolean" },
        cards: { type: "boolean" },
        "no-rw-labels": { type: "boolean" },
        "straight-edges": { type: "boolean" },
        "layout-from": { type: "string" },
        svg: { type: "string" },
      },
      allowPositionals: true,
    });
    return { cmd, values: values as Record<string, unknown>, positionals };
  }
  if (cmd === "sync") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        root: { type: "string" },
        write: { type: "boolean" },
      },
      allowPositionals: true,
    });
    return { cmd, values: values as Record<string, unknown>, positionals };
  }
  if (cmd === "dump-ir") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        root: { type: "string" },
        out: { type: "string" },
      },
      allowPositionals: true,
    });
    return { cmd, values: values as Record<string, unknown>, positionals };
  }
  if (cmd === "inspect") {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        out: { type: "string" },
        "infer-edges": { type: "boolean" },
      },
      allowPositionals: true,
    });
    return { cmd, values: values as Record<string, unknown>, positionals };
  }
  return null;
}

/**
 * CLI 壳负责解析 sidecar 的位置。
 *
 * 核心不再自己从 `import.meta.url` 猜仓库层级。CLI 无论从源码
 * (`typescript/src/cli.ts`) 还是编译产物 (`typescript/dist/cli.js`) 运行，
 * 向上两级都是仓库根，因此这里用相对自身的固定层级；扩展则有它自己的
 * 随包目录，两边把结果以 `metadataToolPath` 传给 `readArtifact`，核心只负责调用。
 */
function metadataToolPath(): string {
  return nodePath.join(
    import.meta.dirname,
    "..",
    "..",
    "tools",
    "drawcode-metadata",
    "bin",
    "Release",
    "net10.0",
    "drawcode-metadata.dll",
  );
}

/**
 * `inspect` 是唯一需要异步的 CLI 命令：PE 解析要等 sidecar 子进程。
 *
 * 其余命令保持同步（测试直接 `assert.equal(main([...]), 0)`），
 * 因而这里单独返回 Promise；`main` 的签名是 `number | Promise<number>`，
 * 调用方（bin 与测试）按需 await。
 */
async function inspectCommand(
  artifact: string,
  outOption: string | undefined,
  inferEdges: boolean,
): Promise<number> {
  let model;
  try {
    model = await readArtifact(artifact, {
      inferEdges,
      // 只有 PE 会用到 sidecar；ELF / ar 忽略这个字段。
      metadataToolPath: metadataToolPath(),
    });
  } catch (exc) {
    // 只有 I/O 失败（不存在、无权限）会走到这里；格式问题在模型诊断里。
    console.error(`drawcode: inspect: ${(exc as Error).message}`);
    return 2;
  }

  const json = canonicalArtifactJson(model);

  if (outOption === undefined) {
    // 与 dump-ir 一致：没有 --out 时只输出 JSON 本体，方便 `| jq` 或重定向。
    process.stdout.write(json);
    return 0;
  }

  const out = abspath(outOption);
  ensureDir(dirname(out));
  writeTextFile(out, json);
  console.log(
    `signals=${model.signals.length} funcs=${model.funcs.length} types=${model.types.length} ` +
      `diagnostics=${model.diagnostics.length} -> ${out}`,
  );
  return 0;
}

export function main(argv: string[]): number | Promise<number> {
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (exc) {
    console.error(`drawcode: ${(exc as Error).message}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }

  const { cmd, values, positionals } = parsed;
  const rootOption = typeof values.root === "string" ? values.root : undefined;

  if (cmd === "build") {
    const given = positionals;
    if (given.length === 0) {
      console.error("drawcode: build 至少需要一个源文件");
      return 2;
    }
    const root = rootOption ?? dirname(abspath(given[0] as string));
    const files = expandModules(given);

    let plans: Plan[];
    try {
      plans = planBuild(
        files,
        typeof values.out === "string" ? values.out : undefined,
        values.merge === true,
      );
    } catch (exc) {
      console.error(`drawcode: ${(exc as Error).message}`);
      return 2;
    }

    const layoutFrom = typeof values["layout-from"] === "string" ? values["layout-from"] : undefined;
    const svgOption = typeof values.svg === "string" ? values.svg : undefined;

    if (plans.length > 1 && (layoutFrom !== undefined || svgOption !== undefined)) {
      // 这两个选项都是「针对一张图」的：布局只有一个，SVG 也只有一个文件名。
      // 多模块时静默只作用于第一张图才是最坏的做法。
      console.error(
        `drawcode: ${plans.length} modules given, so ${plans.length} diagrams would be written; --layout-from and --svg\n` +
          "only make sense for a single diagram. Narrow the file list, or pass --merge.",
      );
      return 2;
    }

    const inline = values.inline === true;
    const cards = values.cards === true;
    // 默认 true（既有产物逐字节不变）；--no-rw-labels 时把节点—信号边上的 read/write 去掉
    const rwLabels = values["no-rw-labels"] !== true;
    // 默认 false（既有产物逐字节不变，金样不受影响）；--straight-edges 时边走直线
    const straightEdges = values["straight-edges"] === true;

    for (const plan of plans) {
      const model = parseAny(plan.files, root);

      // 折叠「一写一读」的信号：设备之间直连，中间的信号节点不画。
      // 放在布局之前是刻意的 —— 这是**图的内容**变了，不是排版变了，
      // 少掉的节点必须由重新布局补位，而不是在原位留一个洞。
      let folded = 0;
      if (inline) folded = collapseSignals(model);

      if (layoutFrom !== undefined) {
        if (!exists(layoutFrom)) {
          console.error(`drawcode: --layout-from: no such file: ${layoutFrom}`);
          return 2;
        }
        const layout = readLayout(readTextFile(layoutFrom));
        if (layout.nodes.size === 0) {
          console.error(
            `drawcode: --layout-from: ${layoutFrom} holds no drawcode nodes, so there is no layout to reuse.\n` +
              "Only a .drawio written by drawcode (or edited from one) carries the symbolId on each node.\n" +
              "A diagram drawn by hand in draw.io cannot be used here.",
          );
          return 2;
        }
        applyLayout(model, layout);
      }

      const xml = toDrawio(model, cards, rwLabels, straightEdges);
      const out = plan.out;
      ensureDir(dirname(out));
      writeTextFile(out, xml);

      let svgNote = "";
      if (svgOption !== undefined) {
        const svgOut = abspath(svgOption);
        ensureDir(dirname(svgOut));
        writeTextFile(svgOut, toSvg(model, SVG_PADDING, cards, rwLabels, straightEdges));
        svgNote = ` + ${svgOut}`;
      }

      // signals= 报的是**折叠前**的信号数：它和调用方看到的源码一一对应，
      // 折了多少另用 folded= 报，否则这个数会随排版选项变化，没法当校验依据。
      const inlineNote = inline ? ` folded=${folded}` : "";
      console.log(
        `signals=${model.signals.size} funcs=${model.funcs.size} edges=${model.edges.length} -> ${out}${svgNote}${inlineNote}`,
      );
    }
    return 0;
  }

  if (cmd === "inspect") {
    const [artifact, ...extra] = positionals;
    if (artifact === undefined) {
      console.error("drawcode: inspect 需要一个程序集文件");
      return 2;
    }
    if (extra.length > 0) {
      console.error(`drawcode: inspect 只接受一个产物文件，多出了：${extra.join(", ")}`);
      return 2;
    }
    return inspectCommand(
      artifact,
      typeof values.out === "string" ? values.out : undefined,
      values["infer-edges"] === true,
    );
  }

  if (cmd === "dump-ir") {
    const files = positionals;
    if (files.length === 0) {
      console.error("drawcode: dump-ir 至少需要一个源文件");
      return 2;
    }
    const root = rootOption ?? dirname(abspath(files[0] as string));
    const model = parseAny(files, root);
    const json = dumpIrJson(model);
    const outOption = typeof values.out === "string" ? values.out : undefined;
    if (outOption === undefined) {
      // 没有 --out 时只输出 JSON 本体，方便 `| jq` 或重定向 —— 提示文字会弄脏产物。
      process.stdout.write(json);
      return 0;
    }
    const out = abspath(outOption);
    ensureDir(dirname(out));
    writeTextFile(out, json);
    console.log(
      `signals=${model.signals.size} funcs=${model.funcs.size} edges=${model.edges.length} devices=${model.devices.size} -> ${out}`,
    );
    return 0;
  }

  // sync
  const [drawioPath, ...files] = positionals;
  if (drawioPath === undefined || files.length === 0) {
    console.error("drawcode: sync 需要 <FILE.drawio> 与至少一个源文件");
    return 2;
  }
  const root = rootOption ?? dirname(abspath(files[0] as string));
  const layout = readLayout(readTextFile(drawioPath), true);
  if (layout.nodes.size === 0 && layout.edges.size === 0) {
    // 手工图没有 symbolId，没有任何可回写的东西，必须说清楚而不是假装成功
    console.error(
      `drawcode: ${drawioPath} holds no drawcode cells, so there is nothing to write back.\n` +
        "Only a .drawio written by drawcode (or edited from one) carries the symbolId\n" +
        "that identifies each node.",
    );
    return 2;
  }
  const model = parseAny(files, root);
  applyLayout(model, layout);

  // 图里有、源码里没有的元素（用户在 draw.io 里新加的）接回 IR，
  // 这样 codegen 的 missing 分支才能把它们写进源码。定不下来的只报告、不猜。
  const [adopted, problems] = adoptForeign(model, layout, root);
  for (const note of problems) console.log(`note: ${note}`);
  if (adopted.length > 0) {
    console.log(`adopted ${adopted.length} element(s) added in the diagram: ${adopted.join(", ")}`);
  }

  if (values.write !== true) {
    console.log(
      `dry-run: ${layout.nodes.size} nodes / ${layout.edges.size} edges read back; pass --write to apply`,
    );
    return 0;
  }

  const changed: string[] = [];
  for (const file of files) {
    const rel = relPath(file, root);
    if (syncSource(file, model, rel)) changed.push(rel);
  }
  console.log(`updated: ${changed.length > 0 ? changed.join(", ") : "(no change)"}`);
  return 0;
}

if (import.meta.filename === process.argv[1]) {
  // `inspect` 返回 Promise（等 sidecar），其余命令同步返回数字；统一 await。
  process.exitCode = await main(process.argv.slice(2));
}

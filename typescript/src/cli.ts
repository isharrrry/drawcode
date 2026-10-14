/**
 * 命令行入口：`build`（源码 -> .drawio）、`sync`（.drawio -> 源码声明层）。
 * 对等 Python `cli.py` 与 .NET `Cli.cs`，三者接受同一组参数。
 *
 * 两个"宁可大声失败"的地方（都曾经静默出错）：
 *
 *   - `--layout-from` 指向的文件**不存在**，或**不含 drawcode 节点**时，直接报错退出。
 *     手画的 draw.io 文档是裸 `<mxCell>`、没有 symbolId，拿它当布局源会**静默把所有节点
 *     丢到 0,0**；而用户显式传了这个参数，说明他期望复用布局，此时"什么都不做"是错的。
 *   - 退出码约定与另外两版一致：参数错 2，正常 0。
 */

import { parseArgs } from "node:util";

import { adoptForeign } from "./adopt.ts";
import { syncSource } from "./codegen.ts";
import { applyLayout, readLayout, toDrawio } from "./drawio.ts";
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
import { parseAny } from "./parse.ts";
import { toSvg } from "./svg.ts";

const USAGE = `usage: drawcode <build|sync> ...

  build <files...> [--root DIR] [--out FILE] [--merge] [--layout-from FILE] [--svg FILE]
        source code -> .drawio (one diagram per module unless --merge)

  sync <FILE.drawio> <files...> [--root DIR] [--write]
        .drawio -> source code (declaration layer only)

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
  return null;
}

export function main(argv: string[]): number {
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

    for (const plan of plans) {
      const model = parseAny(plan.files, root);

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

      const xml = toDrawio(model);
      const out = plan.out;
      ensureDir(dirname(out));
      writeTextFile(out, xml);

      let svgNote = "";
      if (svgOption !== undefined) {
        const svgOut = abspath(svgOption);
        ensureDir(dirname(svgOut));
        writeTextFile(svgOut, toSvg(model));
        svgNote = ` + ${svgOut}`;
      }

      console.log(
        `signals=${model.signals.size} funcs=${model.funcs.size} edges=${model.edges.length} -> ${out}${svgNote}`,
      );
    }
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
  process.exitCode = main(process.argv.slice(2));
}

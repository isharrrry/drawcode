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

import { syncSource } from "./codegen.ts";
import { applyLayout, readLayout, toDrawio } from "./drawio.ts";
import { abspath, dirname, ensureDir, exists, readTextFile, relPath, writeTextFile } from "./fsutil.ts";
import { parseAny } from "./parse.ts";
import { toSvg } from "./svg.ts";

const USAGE = `usage: drawcode <build|sync> ...

  build <files...> [--root DIR] [--out FILE] [--layout-from FILE] [--svg FILE]
        source code -> .drawio

  sync <FILE.drawio> <files...> [--root DIR] [--write]
        .drawio -> source code (declaration layer only)

Source code is the single source of truth; the diagram is a derived view.`;

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
    const files = positionals;
    if (files.length === 0) {
      console.error("drawcode: build 至少需要一个源文件");
      return 2;
    }
    const root = rootOption ?? dirname(abspath(files[0] as string));
    const model = parseAny(files, root);

    const layoutFrom = typeof values["layout-from"] === "string" ? values["layout-from"] : undefined;
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
    const out = abspath(typeof values.out === "string" ? values.out : "flow.drawio");
    ensureDir(dirname(out));
    writeTextFile(out, xml);

    const svgOption = typeof values.svg === "string" ? values.svg : undefined;
    if (svgOption !== undefined) {
      const svgOut = abspath(svgOption);
      ensureDir(dirname(svgOut));
      writeTextFile(svgOut, toSvg(model));
    }

    console.log(
      `signals=${model.signals.size} funcs=${model.funcs.size} edges=${model.edges.length} -> ${out}` +
        (svgOption !== undefined ? ` + ${abspath(svgOption)}` : ""),
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
  const layout = readLayout(readTextFile(drawioPath));
  const model = parseAny(files, root);
  applyLayout(model, layout);

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

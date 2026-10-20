#!/usr/bin/env node
/**
 * 包入口。**只有转发**，不含任何逻辑。
 *
 * 为什么需要一个独立文件而不是让 `src/cli.ts` 自己当入口：
 *
 *   - `package.json` 的 `bin` 字段要一个可执行文件，`files` 列表把它算进发布物；
 *   - `src/cli.ts` 模块底部那段 `import.meta.filename === process.argv[1]` 的守卫，
 *     只在**直接运行该文件**时触发。被 import 时它什么也不做，所以 `bin` 必须自己调 `main`。
 *
 * 这个文件曾经长期不存在：仓库根 `.gitignore` 里那条给 .NET 构建产物用的裸 `bin/`
 * 把 `typescript/bin/` 一起匹配掉了，于是入口文件进不了仓库，而 README、
 * `npm run drawcode`、`package.json` 全都指着它。测试直接 import `src/cli.ts`
 * 的 `main()`，所以没有一条测试能发现。修法是把 .gitignore 的作用域收窄到 `dotnet/`，
 * 见根目录那条规则的注释。
 *
 * `main` 是**同步**函数，返回退出码（0 成功 / 2 用法或输入错误）。
 * 这里用 `process.exitCode` 而不是 `process.exit()`：后者会**截断尚未冲刷的 stdout** ——
 * 管道里重定向到文件或 `| head` 时，`updated: …` 这类输出会整段消失。
 */

import { main } from "../src/cli.ts";

process.exitCode = main(process.argv.slice(2));

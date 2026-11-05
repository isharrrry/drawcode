#!/usr/bin/env node
/**
 * 统一版本号的唯一写入口。
 *
 * 核心库与 VS Code 扩展发布同一个版本：扩展把 `typescript/src` 编译进 `dist/core/`
 * 并装进同一个 VSIX，两者分开编号只会描述一个任何包都不会单独处于的状态。
 * 因此版本号只允许通过本脚本修改；`npm run version:check` 在 CI 或提交前校验
 * 三份 package.json 与两份 lock 文件是否一致。
 *
 * 用法：
 *   node scripts/bump-version.mjs 0.5.0
 *   node scripts/bump-version.mjs --check
 */

import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 每个 package.json 都带一个 version 字段。 */
const PACKAGES = ["package.json", "typescript/package.json", "editors/vscode/package.json"];

/** lock 文件顶层与 `packages[""]` 各带一份版本；存在才改。 */
const LOCKS = [
  "package-lock.json",
  "typescript/package-lock.json",
  "editors/vscode/package-lock.json",
];

/** 只接受无前缀、无预发布标记的 MAJOR.MINOR.PATCH，避免写出 npm 无法解析的版本。 */
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), "utf8"));
}

/**
 * package.json 保留手工维护的紧凑格式（部分 command 对象写在一行里），
 * 因此只替换第一个 version 的值，不重新序列化整个文件。
 */
function writePackageVersion(relative, next) {
  const file = path.join(ROOT, relative);
  const raw = fs.readFileSync(file, "utf8");
  const updated = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${next}$2`);
  if (updated === raw) {
    throw new Error(`bump-version: 在 ${relative} 里找不到 version 字段`);
  }
  fs.writeFileSync(file, updated);
}

/** lock 文件由 npm 生成，本来就是两空格缩进，可以直接重新序列化。 */
function writeJson(relative, value) {
  fs.writeFileSync(path.join(ROOT, relative), `${JSON.stringify(value, null, 2)}\n`);
}

function lockExists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

/** 收集所有携带版本号的位置，用于 --check 与 bump 后的自检。 */
function collectVersions() {
  const found = [];
  for (const relative of PACKAGES) {
    found.push({ file: relative, version: readJson(relative).version });
  }
  for (const relative of LOCKS) {
    if (!lockExists(relative)) continue;
    const lock = readJson(relative);
    found.push({ file: relative, version: lock.version });
    const rootEntry = lock.packages?.[""];
    if (rootEntry) found.push({ file: `${relative} packages[""]`, version: rootEntry.version });
  }
  return found;
}

function check() {
  const expected = readJson("package.json").version;
  const mismatched = collectVersions().filter((entry) => entry.version !== expected);

  if (mismatched.length > 0) {
    console.error(`version:check: root package.json is ${expected}, but:`);
    for (const entry of mismatched) {
      console.error(`  - ${entry.file}: ${entry.version}`);
    }
    console.error("Run `npm run bump -- <version>` instead of editing one file.");
    process.exit(1);
  }

  console.log(`version:check: ${expected} in ${collectVersions().length} places`);
}

function bump(next) {
  for (const relative of PACKAGES) {
    writePackageVersion(relative, next);
  }

  for (const relative of LOCKS) {
    if (!lockExists(relative)) continue;
    const lock = readJson(relative);
    lock.version = next;
    if (lock.packages?.[""]) lock.packages[""].version = next;
    writeJson(relative, lock);
  }

  check();
  console.log(`version:check: updated to ${next}; review and commit the version files together`);
}

const arg = process.argv[2];

if (arg === "--check") {
  check();
} else if (!arg) {
  console.error("usage: npm run bump -- <major.minor.patch>");
  process.exit(1);
} else if (!SEMVER.test(arg)) {
  console.error(`bump-version: '${arg}' is not a plain MAJOR.MINOR.PATCH version`);
  process.exit(1);
} else {
  bump(arg);
}

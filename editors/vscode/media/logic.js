/**
 * webview 的纯逻辑层：不碰 DOM、不碰 vscode，只在给定模型与状态下算数据。
 *
 * 本版把「信号」提升为**端口行**，这是整套交互的语义基础：
 *   - 一个信号被某模块里的函数写入 → 该模块有一条「输出端口行」；
 *   - 同一个信号被另一个模块里的函数读取 → 那个模块有一条「输入端口行」；
 *   - 一条数据流因此就是「某一行 → 某一行」，画布上不需要再画模块节点。
 *
 * 树与分组也建立在这个语义上：
 *   - 树只有一列：模块 → 输出/输入信号分组 → 端口行；
 *   - 勾选的端口进入右侧竖向堆叠的 groupbox，字段在 groupbox 内以树展开，
 *     不再按深度向右加列；
 *   - 基本类型不再占一行/一列，而是在树行上以 `[int]` 形式直接标注。
 *
 * 为什么单独一层：树行、groupbox 树、勾选派生、属性过滤、连线端点全是
 * **可以断言的函数**，混在 DOM 代码里就只能靠人工点页面验证。
 * `test/logic.test.mjs` 用 vm 直接加载本文件。
 *
 * 数据来源是解析核心的规范 JSON（字段见 src/types.ts）。
 * 这里不修改模型：所有派生数据放在 WeakMap 索引里，模型对象只读。
 */
(function (root) {
  "use strict";

  /** 行高必须与 cascade.js 的 ROW_H 一致：行号与连线的纵坐标靠它换算。 */
  var ROW_HEIGHT = 22;

  /**
   * groupbox 树的最大深度。自引用结构体靠类型链已经能停；这里只是
   * 兜住异常元数据（例如两个类型互相包含但 Object 引用断开）造成的无限递归。
   * 取 32 而不是 8：用户要求“一直展开到基本类型”，正常的深结构不该被截断。
   */
  var MAX_FIELD_DEPTH = 32;

  /** 未归属实体在级联表里的伪模块 id，必须与 slicer.ts 的常量一致。 */
  var ORPHAN_MODULE_ID = "__orphans__";

  /*
   * 分组模式的边界。
   *
   * 分组会把「一个模块有多个属性值」展开成多条路径：例如某模块同时标了
   * `平面:网络` 与 `平面:共享内存`，它就要分别出现在两个桶里。层数越多、
   * 每层值越多，路径数是笛卡尔积。这里限制单个模块的路径数与整棵树里模块
   * 出现次数，避免一个标签写得很随意的程序集把 webview 撑爆；被截断时界面
   * 会明确提示，而不是静默少显示。
   */
  var GROUP_MAX_LEVELS = 6;
  var GROUP_MAX_PATHS_PER_MODULE = 64;
  var GROUP_MAX_OCCURRENCES = 4000;
  var GROUP_MAX_PRESETS = 32;
  var GROUP_ALIAS_MAX = 80;
  /** 层级值为空时的桶；用控制字符做键，避免和真实值 `（未标注）` 撞在一起。 */
  var GROUP_UNLABELED = "\u0000";
  var GROUP_UNLABELED_LABEL = "（未标注）";
  var GROUP_PATH_SEP = "\u001f";
  var GROUP_CONFIG_VERSION = 1;

  // ── 小工具 ────────────────────────────────────────────────────────────

  function asSet(value) {
    // 不用 `instanceof Set`：跨 realm 创建的 Set（worker、vm 里的测试）会判 false。
    // 结构化判断足够，且对“类 Set 的只读视图”也成立。
    if (value !== null && typeof value === "object" &&
        typeof value.has === "function" && typeof value.size === "number") {
      return value;
    }
    return new Set(Array.isArray(value) ? value : []);
  }

  function byName(a, b) {
    var an = a.name || a.id || "";
    var bn = b.name || b.id || "";
    return an < bn ? -1 : an > bn ? 1 : 0;
  }

  function pushToMap(map, key, value) {
    var list = map.get(key);
    if (list === undefined) {
      list = [];
      map.set(key, list);
    }
    list.push(value);
  }

  function dirLabel(dir) {
    if (dir === "in") return "输入 (in)";
    if (dir === "out") return "输出 (out)";
    if (dir === "inout") return "双向 (inout)";
    return "未标注";
  }

  function portDirLabel(dir) {
    return dir === "out" ? "输出" : "输入";
  }

  function signalLabel(s) {
    return s.alias ? s.alias + "  ·  " + s.name : s.name;
  }

  /**
   * 端口键与字段键都要能安全放进 DOM 的 data-key。
   * id 里可能出现任意字符（C++ 符号尤其宽松），所以对 id/path 做编码；
   * 分隔符 `|` 本身保持可读，方便日志与测试。
   */
  function encodePart(value) {
    try {
      return encodeURIComponent(String(value));
    } catch (error) {
      return String(value);
    }
  }

  function decodePart(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return value;
    }
  }

  /**
   * 端口键的方向段用单字母 `o` / `i`，不用 `out` / `in`。
   *
   * 原因不只是短：`parsePortKey` 是 webview 收到 `data-key` 后的唯一解析入口，
   * 它必须能从键本身判断方向。早期实现两边一个写 `out`、一个只认 `o`，
   * 结果真实端口键全部解析失败，数据流永远为空。这里同时接受两种写法，
   * 让调用方可以传语义方向（`out`/`in`），键格式保持稳定。
   */
  function dirToken(dir) {
    if (dir === "out" || dir === "o") return "o";
    if (dir === "in" || dir === "i") return "i";
    return String(dir);
  }

  function portKeyOf(dir, moduleId, signalId) {
    return dirToken(dir) + "|" + encodePart(moduleId) + "|" + encodePart(signalId);
  }

  /** 端口键只有三段，解析失败返回 null，避免一条坏键让整次渲染抛异常。 */
  function parsePortKey(key) {
    if (typeof key !== "string") return null;
    var parts = key.split("|");
    if (parts.length !== 3) return null;
    if (parts[0] !== "o" && parts[0] !== "i") return null;
    return {
      dir: parts[0] === "o" ? "out" : "in",
      moduleId: decodePart(parts[1]),
      signalId: decodePart(parts[2]),
    };
  }

  /**
   * 字段键：`sf|<端口键>|<列号>|<编码后的字段路径>`。
   * 端口键本身占三段，所以拆分后第 4 段固定是列号，第 5 段起是路径
   * （路径里即使含 `|` 也已被 encodeURIComponent 编成 %7C）。
   */
  function fieldKeyOf(portKey, column, path) {
    return "sf|" + portKey + "|" + column + "|" + encodePart(path);
  }

  function parseFieldKey(key) {
    if (typeof key !== "string" || key.indexOf("sf|") !== 0) return null;
    var parts = key.split("|");
    if (parts.length !== 6) return null;
    var column = Number(parts[4]);
    if (!isFinite(column) || column <= 0) return null;
    return {
      portKey: parts[1] + "|" + parts[2] + "|" + parts[3],
      column: column,
      path: decodePart(parts[5]),
    };
  }

  // ── 索引 ──────────────────────────────────────────────────────────────

  var indexCache = new WeakMap();

  /**
   * 建立只读索引。WeakMap 以模型对象为键：模型是快照，解析一次后不再变化，
   * 索引可以安全复用；换程序集时旧模型被回收，索引一起消失。
   */
  function getIndex(model) {
    var cached = indexCache.get(model);
    if (cached !== undefined) return cached;

    var ix = {
      model: model,
      moduleById: new Map(),
      moduleByPath: new Map(),
      parentById: new Map(),
      childModuleIds: new Set(),
      typeById: new Map(),
      typeByModuleId: new Map(),
      typeByPath: new Map(),
      /** C# 类型 id 形如 `程序集::命名空间.类型`，信号 ctype 通常只有后半段。 */
      typeBySuffix: new Map(),
      /** 类型 path 用 `/` 分段，ctype 用 `.` 分段；规范化后建一张表。 */
      typeByFullName: new Map(),
      typeByName: new Map(),
      signalById: new Map(),
      funcById: new Map(),
      ownSignals: new Map(),
      ownFuncs: new Map(),
      ownTypes: new Map(),
      // 实体 → 所属模块 id（没有归属时为 null）。
      signalModule: new Map(),
      funcModule: new Map(),
      writersBySignal: new Map(),
      readersBySignal: new Map(),
      orphanSignals: [],
      orphanFuncs: [],
      orphanTypes: [],
    };

    (model.modules || []).forEach(function (m) {
      ix.moduleById.set(m.id, m);
      if (m.path) ix.moduleByPath.set(m.path, m);
      (m.children || []).forEach(function (cid) {
        ix.childModuleIds.add(cid);
        if (!ix.parentById.has(cid)) ix.parentById.set(cid, m.id);
      });
    });

    (model.types || []).forEach(function (t) {
      ix.typeById.set(t.id, t);
      ix.typeByPath.set(t.path, t);
      var sep = t.id.indexOf("::");
      if (sep >= 0) ix.typeBySuffix.set(t.id.slice(sep + 2), t);
      if (!ix.typeByName.has(t.name)) ix.typeByName.set(t.name, t);
      if (t.path) ix.typeByFullName.set(t.path.replace(/\//g, "."), t);
      // C# 的模块树把类型本身当一个模块，模块 id 与类型 id 相同。
      if (ix.moduleById.has(t.id)) ix.typeByModuleId.set(t.id, t);
    });

    (model.signals || []).forEach(function (s) {
      ix.signalById.set(s.id, s);
    });
    (model.funcs || []).forEach(function (f) {
      ix.funcById.set(f.id, f);
      (f.writes || []).forEach(function (sid) {
        pushToMap(ix.writersBySignal, sid, f.id);
      });
      (f.reads || []).forEach(function (sid) {
        pushToMap(ix.readersBySignal, sid, f.id);
      });
    });

    // path 归属：优先精确匹配模块 path，否则找最长前缀。
    // 例：C# 信号 path = "Ns/Type"，正好是类型模块；ELF 类型 path = "mod/Struct"，
    // 但模块只有 "mod"，于是落到最长前缀。
    function moduleForPath(path) {
      if (!path) return null;
      var exact = ix.moduleByPath.get(path);
      if (exact !== undefined) return exact;
      var best = null;
      ix.moduleByPath.forEach(function (m, mp) {
        if (mp && path.indexOf(mp + "/") === 0) {
          if (best === null || mp.length > best.path.length) best = m;
        }
      });
      return best;
    }
    ix.moduleForPath = moduleForPath;

    (model.signals || []).forEach(function (s) {
      var m = moduleForPath(s.path);
      ix.signalModule.set(s.id, m === null ? null : m.id);
      if (m === null) ix.orphanSignals.push(s);
      else pushToMap(ix.ownSignals, m.id, s);
    });
    (model.funcs || []).forEach(function (f) {
      var m = moduleForPath(f.path);
      ix.funcModule.set(f.id, m === null ? null : m.id);
      if (m === null) ix.orphanFuncs.push(f);
      else pushToMap(ix.ownFuncs, m.id, f);
    });
    (model.types || []).forEach(function (t) {
      if (ix.typeByModuleId.has(t.id)) return;
      var m = moduleForPath(t.path);
      if (m === null) ix.orphanTypes.push(t);
      else pushToMap(ix.ownTypes, m.id, t);
    });

    indexCache.set(model, ix);
    return ix;
  }

  // ── 类型解析 ──────────────────────────────────────────────────────────

  /**
   * 在类型表里找名字对应的类型。
   *
   * 顺序是按「歧义最小」排的：
   *   1. 完整 id；
   *   2. C# id 的 `::` 后半段（信号 ctype 的常见形态）；
   *   3. path 把 `/` 换成 `.`（与 ctype 的点分命名空间对齐）；
   *   4. 短名（最后一段），可能歧义，所以放最后。
   * 找不到返回 null：基本类型（int/double）本来就不在类型表里。
   */
  function findType(ix, name) {
    if (!name) return null;
    if (ix.typeById.has(name)) return ix.typeById.get(name);
    if (ix.typeBySuffix.has(name)) return ix.typeBySuffix.get(name);
    var dotted = name.replace(/\//g, ".");
    if (ix.typeByFullName.has(dotted)) return ix.typeByFullName.get(dotted);
    var short = dotted.split(".").pop();
    if (short.indexOf("::") >= 0) short = short.split("::").pop();
    if (ix.typeByName.has(short)) return ix.typeByName.get(short);
    return null;
  }

  /** 泛型实参可能嵌套（Dictionary<string, List<T>>），按顶层逗号拆分。 */
  function splitTypeArgs(text) {
    var out = [];
    var depth = 0;
    var start = 0;
    for (var i = 0; i < text.length; i += 1) {
      var ch = text.charAt(i);
      if (ch === "<" || ch === "(" || ch === "[") depth += 1;
      else if (ch === ">" || ch === ")" || ch === "]") depth -= 1;
      else if (ch === "," && depth === 0) {
        out.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(text.slice(start).trim());
    return out;
  }

  /**
   * 把 ctype 解析成类型与「是否集合」。
   *
   * 为什么不只查 id：字段 ctype 是源码书写形态，可能是
   * `System.Collections.Generic.IReadOnlyList`1<某命名空间.飞机状态>`、
   * `某命名空间.飞机状态[]`、`struct 某类型 *`。这里剥掉包装，
   * 集合标记用于在界面上显示「元素」，让用户知道下一列是元素类型。
   */
  function resolveCtype(ix, ctype) {
    var name = String(ctype || "").trim();
    var collection = false;
    if (!name) return { type: null, name: "", collection: false };

    name = name.replace(/^(struct|class|union|const|ref|out|in)\s+/, "");
    name = name.replace(/\s+const\s*$/, "");
    while (/[\*&]$/.test(name)) name = name.slice(0, -1).trim();
    name = name.replace(/\?$/, "").trim();

    while (/\[\s*\]$/.test(name)) {
      collection = true;
      name = name.replace(/\[\s*\]$/, "").trim();
    }

    var lt = name.indexOf("<");
    if (lt >= 0 && name.charAt(name.length - 1) === ">") {
      var outer = name.slice(0, lt).trim();
      var inner = name.slice(lt + 1, -1);
      var args = splitTypeArgs(inner);
      // Dictionary<K,V> 的数据形态是 V；其它泛型取第一个实参。
      var pick = /Dictionary|IDictionary|SortedDictionary/.test(outer)
        ? args[args.length - 1]
        : args[0];
      if (/List|Collection|Array|Set|HashSet|IEnumerable|IReadOnlyList|IList|ICollection|Queue|Stack|Dictionary/.test(outer)) {
        collection = true;
      }
      if (/Nullable/.test(outer)) collection = false;
      name = pick ? pick.trim() : "";
      // 实参本身可能是数组/指针，递归一轮把包装剥干净。
      return resolveCtype(ix, name + (collection ? "[]" : ""));
    }

    return { type: findType(ix, name), name: name, collection: collection };
  }

  /**
   * 信号对应的结构类型 —— 决定端口行右侧能展开哪些字段。
   *
   * 必须 **ctype 优先**：两个读取器对 `ownerType` 的语义并不一致：
   *   - C#：`OwnerType` 是声明该成员的类（`ModelBuilder.ConsiderSignal`），
   *     通常是一个没有字段的组件类；
   *   - ELF：`ownerType` 是 `ctype` 解析出的数据类型 id（`elf.ts`）。
   * 之前优先 ownerType，真实样本里 62 个端口全部被判成“无字段”，
   * 级联表第二列根本打不开。ctype 才是信号自身的数据类型；
   * ctype 解析不到（只写了名字或跨程序集）时再用 ownerType 兜底。
   */
  function signalType(ix, s) {
    var resolved = resolveCtype(ix, s.ctype).type;
    if (resolved !== null) return resolved;
    if (s.ownerType && ix.typeById.has(s.ownerType)) return ix.typeById.get(s.ownerType);
    return null;
  }

  /**
   * 字段的声明类型。
   *
   * 字段比信号多一个 `typeId`：读取器在解析时就把引用解析好了，比从 ctype
   * 字符串再猜一遍更可靠（C 的 typedef、C# 的嵌套类名都可能对不上）。
   * 顺序因此是 typeId → ctype：typeId 命中时仍用 `resolveCtype` 的 collection
   * 判定，因为它才看得见 `IReadOnlyList<T>`、`T[]` 这些包装。
   */
  function resolveFieldType(ix, field) {
    var resolved = resolveCtype(ix, field.ctype);
    if (resolved.type !== null) return resolved;
    if (field.typeId && ix.typeById.has(field.typeId)) {
      var target = ix.typeById.get(field.typeId);
      return { type: target, name: target.name, collection: resolved.collection };
    }
    return resolved;
  }

  // ── 端口索引 ──────────────────────────────────────────────────────────

  var portsCache = new WeakMap();

  function flagsKey(flags) {
    flags = flags || {};
    return (flags.showExcluded === true ? "e" : "") +
      (flags.showCompilerGenerated === true ? "c" : "");
  }

  function visibleSignal(s, flags) {
    return flags.showExcluded === true || !s.exclude;
  }

  function visibleFunc(f, flags) {
    if (flags.showExcluded !== true && f.exclude) return false;
    // 记录类型的 <Clone>$、<PrintMembers> 等编译器生成方法默认不参与端口。
    if (flags.showCompilerGenerated !== true && f.name.charAt(0) === "<") return false;
    return true;
  }

  function orphanModule() {
    return {
      id: ORPHAN_MODULE_ID,
      name: "（未归属）",
      path: "",
      kind: "namespace",
      children: [],
      root: false,
      exclude: false,
      counts: { signals: 0, funcs: 0, types: 0 },
    };
  }

  /**
   * 端口索引：所有派生交互的事实来源。
   *
   * 同一条关系在两端各有一条端口行：
   *   - 写函数所在模块 → `o|模块|信号`；
   *   - 读函数所在模块 → `i|模块|信号`。
   * 因此同一个信号在生产模块是「输出行」，在每个消费模块是「输入行」。
   *
   * 没有观察到写者/读者时，用信号自身的 dir 补一条「声明端口」：
   * 这是外部符号或元数据只标方向的情况，否则该信号会从界面上消失。
   */
  function getPorts(model, flags) {
    flags = flags || {};
    var key = flagsKey(flags);
    var byModel = portsCache.get(model);
    if (byModel === undefined) {
      byModel = {};
      portsCache.set(model, byModel);
    }
    if (byModel[key] !== undefined) return byModel[key];

    var ix = getIndex(model);
    var byKey = new Map();
    var byModule = new Map();
    var bySignal = new Map();

    function moduleEntry(moduleId) {
      var entry = byModule.get(moduleId);
      if (entry === undefined) {
        entry = { outputs: [], inputs: [] };
        byModule.set(moduleId, entry);
      }
      return entry;
    }

    function signalEntry(signalId) {
      var entry = bySignal.get(signalId);
      if (entry === undefined) {
        entry = { outputs: [], inputs: [] };
        bySignal.set(signalId, entry);
      }
      return entry;
    }

    function ensurePort(dir, moduleId, signal) {
      var pkey = portKeyOf(dir, moduleId, signal.id);
      var port = byKey.get(pkey);
      if (port === undefined) {
        port = {
          key: pkey,
          dir: dir,
          moduleId: moduleId,
          signalId: signal.id,
          signal: signal,
          module: moduleId === ORPHAN_MODULE_ID
            ? orphanModule()
            : ix.moduleById.get(moduleId) || null,
          funcIds: [],
          declared: false,
          // 「方向未标注」标记：无元数据程序集（只有符号表）只能看到全局变量，
          // 看不到谁写谁读。这类信号仍要有个端口才不会被树吞掉，但它的方向是
          // 猜的，界面必须把「输出」和「方向未知」分开，否则读者会把推断当事实。
          inferredDir: false,
        };
        byKey.set(pkey, port);
        var entry = moduleEntry(moduleId);
        if (dir === "out") entry.outputs.push(port);
        else entry.inputs.push(port);
        var sig = signalEntry(signal.id);
        if (dir === "out") sig.outputs.push(port);
        else sig.inputs.push(port);
      }
      return port;
    }

    function addDeclared(dir, moduleId, signal) {
      if (moduleId === undefined || moduleId === null) moduleId = ORPHAN_MODULE_ID;
      if (moduleId !== ORPHAN_MODULE_ID) {
        var m = ix.moduleById.get(moduleId);
        if (m !== undefined && m.exclude && flags.showExcluded !== true) return undefined;
      }
      return ensurePort(dir, moduleId, signal);
    }

    (model.signals || []).forEach(function (s) {
      if (!visibleSignal(s, flags)) return;
      var writers = (ix.writersBySignal.get(s.id) || []).filter(function (fid) {
        var f = ix.funcById.get(fid);
        return f !== undefined && visibleFunc(f, flags);
      });
      var readers = (ix.readersBySignal.get(s.id) || []).filter(function (fid) {
        var f = ix.funcById.get(fid);
        return f !== undefined && visibleFunc(f, flags);
      });

      writers.forEach(function (fid) {
        var mid = ix.funcModule.get(fid);
        if (mid === undefined || mid === null) mid = ORPHAN_MODULE_ID;
        if (mid !== ORPHAN_MODULE_ID) {
          var fm = ix.moduleById.get(mid);
          if (fm !== undefined && fm.exclude && flags.showExcluded !== true) return;
        }
        ensurePort("out", mid, s).funcIds.push(fid);
      });

      readers.forEach(function (fid) {
        var mid = ix.funcModule.get(fid);
        if (mid === undefined || mid === null) mid = ORPHAN_MODULE_ID;
        if (mid !== ORPHAN_MODULE_ID) {
          var fm = ix.moduleById.get(mid);
          if (fm !== undefined && fm.exclude && flags.showExcluded !== true) return;
        }
        ensurePort("in", mid, s).funcIds.push(fid);
      });

      var owner = ix.signalModule.get(s.id);
      if (owner === undefined || owner === null) owner = ORPHAN_MODULE_ID;

      // 没有观察到的写者：按声明方向补端口。
      //
      // 方向为空是「无元数据程序集」的常态（ELF 符号表只能看到谁读了全局变量，
      // 看不到谁写）。这类信号只要有读者，就必须补一个输出端：
      //   - 只补输入端时，勾选它只能得到孤立端口，画布上没有 out → in 可连；
      //   - 输出端声明在信号归属模块上，语义是「该模块承载这个信号的产出」，
      //     而不是「某个函数写了它」——所以 declared=true，信息面板会标明是补的。
      // 没有读者时也保留原来的输出端，避免信号在树上完全消失。
      if (writers.length === 0) {
        if (s.dir === "in") addDeclared("in", owner, s);
        else if (s.dir === "inout") {
          addDeclared("in", owner, s);
          addDeclared("out", owner, s);
        } else {
          // dir === "out"，以及无法判定方向（dir === ""）的推断信号。
          // 后者只在这里临时挂到输出端，树会把它单独归到「方向未标注」组。
          var inferred = addDeclared("out", owner, s);
          if (inferred !== undefined && !s.dir) inferred.inferredDir = true;
        }
      }
      // 没有观察到的读者：只有信号声明为输入/双向时才补输入端口。
      if (readers.length === 0 && writers.length > 0) {
        if (s.dir === "in" || s.dir === "inout") addDeclared("in", owner, s);
      }
    });

    // 声明端口最终以「有没有观察到函数」为准；先建后补的也在这里统一。
    byKey.forEach(function (port) {
      port.declared = port.funcIds.length === 0;
      // 同一个函数可能既写又读同一信号：同一端口里只记一次。
      if (port.funcIds.length > 1) port.funcIds = Array.from(new Set(port.funcIds)).sort();
    });

    // 排好序，保证级联表与画布每次重建的顺序稳定。
    byModule.forEach(function (entry) {
      entry.outputs.sort(function (a, b) {
        var al = signalLabel(a.signal);
        var bl = signalLabel(b.signal);
        return al < bl ? -1 : al > bl ? 1 : (a.signalId < b.signalId ? -1 : 1);
      });
      entry.inputs.sort(function (a, b) {
        var al = signalLabel(a.signal);
        var bl = signalLabel(b.signal);
        return al < bl ? -1 : al > bl ? 1 : (a.signalId < b.signalId ? -1 : 1);
      });
    });

    // 子树端口集合：模块/分组复选框一次勾选整棵子树时直接取用。
    var subtreeKeys = new Map();
    var visiting = new Set();
    function collectSubtree(moduleId) {
      if (subtreeKeys.has(moduleId)) return subtreeKeys.get(moduleId);
      if (visiting.has(moduleId)) return new Set(); // 防御：模块树不应有环
      visiting.add(moduleId);
      var keys = new Set();
      var entry = byModule.get(moduleId);
      if (entry !== undefined) {
        entry.outputs.forEach(function (p) { keys.add(p.key); });
        entry.inputs.forEach(function (p) { keys.add(p.key); });
      }
      var m = moduleId === ORPHAN_MODULE_ID ? undefined : ix.moduleById.get(moduleId);
      if (m !== undefined) {
        (m.children || []).forEach(function (cid) {
          collectSubtree(cid).forEach(function (k) { keys.add(k); });
        });
      }
      visiting.delete(moduleId);
      subtreeKeys.set(moduleId, keys);
      return keys;
    }
    (model.modules || []).forEach(function (m) { collectSubtree(m.id); });
    collectSubtree(ORPHAN_MODULE_ID);

    var subtreeCounts = new Map();
    subtreeKeys.forEach(function (keys, moduleId) {
      var outputs = 0;
      var inputs = 0;
      keys.forEach(function (k) {
        var p = byKey.get(k);
        if (p !== undefined) {
          if (p.dir === "out") outputs += 1;
          else inputs += 1;
        }
      });
      subtreeCounts.set(moduleId, { outputs: outputs, inputs: inputs });
    });

    var ports = {
      byKey: byKey,
      byModule: byModule,
      bySignal: bySignal,
      subtreeKeys: subtreeKeys,
      subtreeCounts: subtreeCounts,
      orphanModule: orphanModule(),
    };
    byModel[key] = ports;
    return ports;
  }

  // ── 属性分类与基本类型 ────────────────────────────────────────────────

  /**
   * 常见基本类型名（C# / C / C++ / Rust 混在一张表里）。
   *
   * 为什么需要这张表：`resolveCtype` 只能回答“模型里有没有这个结构类型”。
   * 返回 null 既可能是 `int` 这种真正的基本类型，也可能是跨程序集、本次没解析到的
   * 自定义类型。前者应该在树行里直接显示 `[int]`，后者不能冒充基本类型——
   * 否则用户会以为一个结构体没有字段可展开。
   */
  var BASIC_TYPES = {
    bool: true, boolean: true, byte: true, sbyte: true, ubyte: true,
    short: true, ushort: true, int: true, uint: true, long: true, ulong: true,
    int8: true, int16: true, int32: true, int64: true,
    uint8: true, uint16: true, uint32: true, uint64: true,
    int8_t: true, int16_t: true, int32_t: true, int64_t: true,
    uint8_t: true, uint16_t: true, uint32_t: true, uint64_t: true,
    size_t: true, ssize_t: true, word: true, dword: true, qword: true,
    float: true, double: true, decimal: true, float16: true, float32: true, float64: true,
    char: true, wchar: true, wchar_t: true, string: true, object: true,
    void: true, nint: true, nuint: true,
  };

  /**
   * 基本类型名；不是基本类型（结构体、枚举、未知自定义类型）返回 null。
   *
   * 枚举在程序集里是独立类型，算“非基本”——它能展开出枚举成员，
   * 用户需要看到成员名，而不是只看到一个 `[Direction]` 标签。
   */
  /**
   * 数组后缀：按原始 ctype 里写了几对方括号还原几对。
   *
   * `resolveCtype` 为了让调用方统一查字段，把 `float[][]` 剥成
   * 「元素 float + collection=true」，维数就丢了。展示层不能直接拿
   * `resolved.name` 当类型名，否则客户端的 `byte[]` 会被说成 `byte`。
   * 原始写法是 `List<T>` 这类泛型时没有方括号可数，就退回一对 `[]`。
   */
  function arraySuffixOf(resolved, raw) {
    if (!resolved || !resolved.collection) return "";
    var matched = String(raw || "").match(/(\[\s*,*\s*\])+\s*$/);
    if (matched === null) return "[]";
    var pairs = (matched[0].match(/\[/g) || []).length;
    return pairs > 0 ? new Array(pairs + 1).join("[]") : "[]";
  }

  function basicTypeLabel(ix, ctype) {
    var resolved = resolveCtype(ix, ctype);
    if (resolved.type !== null) return null;
    var name = String(resolved.name || "").replace(/^System\./, "");
    if (name === "") return null;
    // `byte[]` 与 `byte` 是两种不同的数据形态：数组信号要带上方括号，
    // 否则树上的类型标签会把「一块缓冲区」说成「一个字节」。
    var suffix = arraySuffixOf(resolved, ctype);
    if (BASIC_TYPES[name] === true) return name + suffix;
    // C 系变体：`unsigned int` 已被 resolveCtype 保留成两段，这里再兜一轮。
    if (/^(unsigned|signed)\s+/i.test(name)) {
      var stripped = name.replace(/^(unsigned|signed)\s+/i, "");
      return basicTypeLabel(ix, stripped + suffix);
    }
    return null;
  }

  /**
   * 类型的展示名：解析结果丢了数组包装，展示时必须补回来。
   *
   * `resolveCtype` 为了查字段会把 `float[]` 拆成「元素 float + collection」，
   * 但直接拿 `name` 展示就把数组说成了标量。这里统一还原成 `float[]`；
   * 原始 ctype 本身已带括号时按原维数追加，不重复叠加。
   */
  function displayTypeName(resolved, raw) {
    // 解析到类型时用类型自身的短名（`M.Frame` -> `Frame`）；
    // 跨程序集解析不到时才退回 ctype 原文。
    var name = String(
      (resolved && resolved.type && resolved.type.name) ||
        (resolved && resolved.name) ||
        raw ||
        "",
    );
    if (name === "") return "";
    if (resolved && resolved.collection && !/(\[\s*,*\s*\])+\s*$/.test(name)) {
      name += arraySuffixOf(resolved, raw);
    }
    return name;
  }

  /**
   * 把标签拆成「分类 / 值」。
   *
   * 现有两类标签共用同一个数组：
   *   - 业务标签 `语义:实时数据`（Drawcode.Tags 原样）；
   *   - 特性值 `Device.Model=示例型号`（sidecar 从 [Device] 采集）。
   * 两者都只按**第一个**分隔符拆，值里再出现冒号/等号不影响分组。
   */
  function splitFacetTag(tag) {
    var text = String(tag || "");
    var match = text.match(/^([^:=]+)[:=](.+)$/);
    if (match === null) return null;
    var name = match[1].trim();
    var value = match[2].trim();
    if (name === "" || value === "") return null;
    return { name: name, value: value, tag: text };
  }

  /**
   * 把任意标签解释成「分类 / 值」。
   *
   * `[Device]` 特性与 `Tags = "语义:实时"` 自带分类；C 模板里的 `DC_SIGNAL(x,
   * "telemetry,rmem")` 只有裸标签，没有分类。后者不能再被丢掉——C/ELF 程序集
   * 没有特性系统，裸标签就是它们唯一的筛选维度。统一收进「标签」分类，
   * 既让属性下拉框可用，也让分组模式能按裸标签分层。
   */
  function facetOfTag(tag) {
    var facet = splitFacetTag(tag);
    if (facet !== null) return facet;
    var text = String(tag || "").trim();
    if (text === "" || text.length > 100) return null;
    return { name: "标签", value: text, tag: text };
  }

  /**
   * 从模型里收集可筛选的属性分组。
   *
   * 只扫描“有标签的实体”：信号、类型、函数。模块是类型的另一种视图，
   * 它的标签就在同 id 的类型上，重复收集会让同一个值出现两次计数。
   *
   * 返回按分类名排序的分组；组内按命中数量降序，数量相同按值排序，
   * 让筛选下拉框稳定——每次重建顺序都变的下拉框没法用键盘选。
   */
  function facetGroups(model) {
    var byName = new Map();
    function add(tags) {
      (tags || []).forEach(function (tag) {
        var facet = facetOfTag(tag);
        if (facet === null) return;
        var group = byName.get(facet.name);
        if (group === undefined) {
          group = { name: facet.name, values: new Map() };
          byName.set(facet.name, group);
        }
        var entry = group.values.get(facet.tag);
        if (entry === undefined) {
          entry = { tag: facet.tag, value: facet.value, count: 0 };
          group.values.set(facet.tag, entry);
        }
        entry.count += 1;
      });
    }
    (model.signals || []).forEach(function (s) { add(s.tags); });
    (model.types || []).forEach(function (t) {
      add(t.tags);
      (t.fields || []).forEach(function (f) { add(f.tags); });
    });
    (model.funcs || []).forEach(function (f) { add(f.tags); });

    var groups = [];
    byName.forEach(function (group) {
      var values = Array.from(group.values.values()).sort(function (a, b) {
        if (a.count !== b.count) return b.count - a.count;
        return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
      });
      groups.push({ name: group.name, values: values });
    });
    groups.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return groups;
  }

  // ── 分组配置（持久化在程序集同目录的 .drawcode.json） ──────────────────

  /**
   * 清洗层级名列表。
   *
   * 配置来自磁盘，也可能来自旧版本插件：任何一项都可能是 null、数字、
   * 超长字符串或重复项。这里只做三件事——去空、去重、限量——绝不抛异常。
   * 未知属性名不在这里删：程序集重新编译后属性可能暂时缺失（例如切片还没
   * 加载完），删掉会让用户的配置悄悄丢失。界面会把「当前程序集没有该属性」
   * 显示出来，用户自己决定是否移除。
   */
  function cleanGroupLevels(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i += 1) {
      var text = typeof raw[i] === "string" ? raw[i].trim() : "";
      if (text === "" || text.length > 100) continue;
      if (out.indexOf(text) >= 0) continue;
      if (out.length >= GROUP_MAX_LEVELS) break;
      out.push(text);
    }
    return out;
  }

  /**
   * 把任意 JSON 洗成可用的分组配置。
   *
   * 返回 `{version, levels, active, defaultPreset, presets, issues}`：
   *   - `issues` 是给人看的提示，不是异常；调用方把它显示在分组条上；
   *   - 引用不存在的别名会被降级为 null，而不是让 `find` 返回 undefined
   *     后继续往下传（那会在渲染时变成 `undefined.alias` 之类的异常）。
   */
  function sanitizeGroupingConfig(raw) {
    var out = {
      version: GROUP_CONFIG_VERSION,
      levels: [],
      active: null,
      defaultPreset: null,
      presets: [],
      issues: [],
    };
    if (raw === undefined || raw === null) return out;
    if (typeof raw !== "object" || Array.isArray(raw)) {
      out.issues.push("配置文件不是对象，已忽略");
      return out;
    }

    out.levels = cleanGroupLevels(raw.levels);

    var presets = [];
    var seen = new Set();
    var rawPresets = Array.isArray(raw.presets) ? raw.presets : [];
    for (var i = 0; i < rawPresets.length && presets.length < GROUP_MAX_PRESETS; i += 1) {
      var item = rawPresets[i];
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      var alias = typeof item.alias === "string" ? item.alias.trim() : "";
      if (alias === "" || alias.length > GROUP_ALIAS_MAX || seen.has(alias)) continue;
      seen.add(alias);
      presets.push({ alias: alias, levels: cleanGroupLevels(item.levels) });
    }
    out.presets = presets;

    function pickAlias(value, what) {
      if (typeof value !== "string" || value.trim() === "") return null;
      var alias = value.trim();
      if (!seen.has(alias)) {
        out.issues.push("配置里的" + what + "「" + alias + "」已不存在");
        return null;
      }
      return alias;
    }
    out.active = pickAlias(raw.active, "别名");
    out.defaultPreset = pickAlias(raw.defaultPreset, "默认别名");
    return out;
  }

  /** 按别名找预设；找不到返回 null（调用方不必再判 undefined）。 */
  function findGroupPreset(config, alias) {
    if (alias === null || alias === undefined) return null;
    var presets = config && Array.isArray(config.presets) ? config.presets : [];
    for (var i = 0; i < presets.length; i += 1) {
      if (presets[i].alias === alias) return presets[i];
    }
    return null;
  }

  /**
   * 从配置里选一组要启用的层级。
   *
   * 优先级：指定的别名（会话里正在用的）→ 默认别名 → 配置里上次的 levels。
   * 每一层都有兜底，配置文件被改坏时最多得到空数组，界面回到普通树。
   */
  function resolveGroupLevels(config, preferredAlias) {
    var preset = findGroupPreset(config, preferredAlias);
    if (preset === null) preset = findGroupPreset(config, config.defaultPreset);
    if (preset !== null) return { levels: preset.levels.slice(), alias: preset.alias };
    return { levels: cleanGroupLevels(config.levels), alias: null };
  }

  // ── 过滤命中 ──────────────────────────────────────────────────────────

  /**
   * 计算过滤命中。
   *
   * `filter` 是自由文本（名字、路径、标签）；`facet` 是属性下拉框选中的
   * **完整标签**（例如 `Device.Model=示例型号`）。两者同时存在时取交集：
   * 用户先按属性缩窄范围，再在范围内搜名字，是表格筛选的常见顺序。
   */
  function hitSets(model, filter, facet) {
    var hits = {
      modules: new Set(),
      signals: new Set(),
      funcs: new Set(),
      types: new Set(),
    };
    var needle = String(filter || "").trim().toLowerCase();
    var facetTag = String(facet || "").trim();
    if (!needle && !facetTag) return hits;

    function textHit(parts) {
      if (!needle) return true;
      for (var i = 0; i < parts.length; i += 1) {
        var p = parts[i];
        if (p && String(p).toLowerCase().indexOf(needle) >= 0) return true;
      }
      return false;
    }

    function tagHit(tags) {
      if (!facetTag) return true;
      return (tags || []).indexOf(facetTag) >= 0;
    }

    (model.signals || []).forEach(function (s) {
      if (textHit([s.name, s.alias, s.ctype, s.unit, s.path].concat(s.tags || [])) &&
          tagHit(s.tags)) {
        hits.signals.add(s.id);
      }
    });
    (model.funcs || []).forEach(function (f) {
      if (textHit([f.name, f.path].concat(f.tags || [])) && tagHit(f.tags)) hits.funcs.add(f.id);
    });
    (model.types || []).forEach(function (t) {
      var typeHit = textHit([t.name, t.path].concat(t.tags || [])) && tagHit(t.tags);
      var fieldHit = (t.fields || []).some(function (f) {
        return textHit([f.name, f.ctype].concat(f.tags || [])) && tagHit(f.tags);
      });
      if (typeHit || fieldHit) hits.types.add(t.id);
    });
    (model.modules || []).forEach(function (m) {
      // 模块本身没有标签；启用属性筛选时不靠名字命中模块，
      // 而靠它子树里的类型/信号命中被保留（见 buildCascade 的 moduleVisible）。
      if (!facetTag && textHit([m.name, m.path])) hits.modules.add(m.id);
    });
    return hits;
  }

  /**
   * 切片模式下的命中集合来自宿主：webview 手里只有已加载的切片，
   * 本地搜索必然漏掉未下发的实体，所以 filter 必须由宿主全量执行。
   */
  function normalizeHits(raw) {
    return {
      modules: asSet(raw && raw.modules),
      signals: asSet(raw && raw.signals),
      funcs: asSet(raw && raw.funcs),
      types: asSet(raw && raw.types),
    };
  }

  // ── 模块树 ────────────────────────────────────────────────────────────

  /** 模块链（根 → 自身），供定位时解除折叠。 */
  function moduleChain(model, moduleId) {
    var ix = getIndex(model);
    if (moduleId === ORPHAN_MODULE_ID) return [ORPHAN_MODULE_ID];
    var ids = [];
    var cursor = ix.moduleById.get(moduleId);
    var guard = 0;
    while (cursor !== undefined && cursor !== null && guard < 64) {
      ids.push(cursor.id);
      var pid = ix.parentById.get(cursor.id);
      cursor = pid === undefined ? null : ix.moduleById.get(pid);
      guard += 1;
    }
    ids.reverse();
    return ids;
  }

  function moduleNameOf(ix, moduleId) {
    if (moduleId === ORPHAN_MODULE_ID) return "未归属";
    var m = ix.moduleById.get(moduleId);
    return m === undefined ? "未归属" : m.name;
  }

  /** 导出 draw.io 时用的层级路径；模块自带 path，缺失时才退回短名。 */
  function modulePathOf(ix, moduleId) {
    if (moduleId === ORPHAN_MODULE_ID) return "未归属";
    var m = ix.moduleById.get(moduleId);
    return m === undefined ? "未归属" : (m.path || m.name);
  }

  /**
   * 生成模块树与勾选产生的 groupbox。
   *
   * 与上一版的根本区别：树**只有一列**。字段不再按深度向右加列，
   * 而是进入每个勾选端口自己的 groupbox；因此这里返回 `rows`（树行）
   * 与 `groups`（groupbox 数据）两份互相独立的数据。
   *
   * 树的语义没变：
   *   - 模块行按层级展开，分组行（输出信号/输入信号）可整选；
   *   - 端口行是“某模块里的某条信号”，输出与输入是同一个信号的两端；
   *   - 行号 `index` 从 0 开始，是左侧连线的纵坐标基准。
   *
   * groupbox 的语义：
   *   - 勾选端口 → 一个 groupbox；勾选字段 → 它所属端口也出现 groupbox；
   *   - groupbox 内默认展开一层字段，继续展开才显示更深层；
   *   - 每个 groupbox 的序号从 1 重新编号，方便按行读数。
   */
  function buildCascade(model, state) {
    state = state || {};
    var ix = getIndex(model);
    var flags = {
      showExcluded: state.showExcluded === true,
      showCompilerGenerated: state.showCompilerGenerated === true,
    };
    var ports = getPorts(model, flags);
    var checked = asSet(state.checked);
    var collapsed = asSet(state.collapsed);
    var filter = String(state.filter || "").trim().toLowerCase();
    var facet = String(state.facet || "").trim();
    var hasFilter = filter.length > 0 || facet.length > 0;
    var hits = state.filterHits ? normalizeHits(state.filterHits) : hitSets(model, filter, facet);
    var showEmptyModules = state.showEmptyModules === true;
    var sliced = state.sliced === true;
    var loaded = asSet(state.loadedModules);
    var hasOrphans = state.hasOrphans === true;

    // ── 分组模式 ──
    // 层级为空就是普通模块树；非空时下面走另一条行构建路径。
    // 所有分组相关的临时表都在这里建，普通模式不额外付出遍历成本。
    var groupLevels = cleanGroupLevels(state.groupLevels);
    var grouping = groupLevels.length > 0;
    /** 端口键 → 它第一次出现的端口行下标；分组模式下同一端口会出现多次。 */
    var portRowIndex = new Map();
    /** 端口键 → 第一次出现的端口行 key（分组模式下不等于 portKey）。 */
    var portRowKey = new Map();
    /** 模块 id → 第一次出现的模块行 key / 下标。 */
    var moduleRowKey = new Map();
    var moduleRowIndex = new Map();
    /** 函数 id → 第一次出现的函数行 key / 下标（函数作为子模块时使用）。 */
    var funcRowKey = new Map();
    var funcRowIndex = new Map();
    /**
     * 端口键 → 端口行消失时应该锚定的行键。
     *
     * 普通树里它是「输出/输入信号」分组键；函数作为子模块后，端口可能属于
     * 某个函数，折叠函数时应锚到函数行而不是整个模块的信号分组。
     * 这个表只记“端口自己能看到的最深容器”，最终是否可用由 indexByKey 判定。
     */
    var portAnchorKeys = new Map();
    /** 模块 id → 要展开它需要从 collapsed 里移除的所有行 key。 */
    var uncollapseByModule = new Map();
    /** 模块 id → 每次出现的行键链（桶 → 模块 → I/O 分组），用于折叠锚定。 */
    var occurrenceChains = new Map();
    var groupingTruncated = false;

    // 字段勾选反查端口：用于让端口行显示“部分选中”。
    var fieldCheckedPorts = new Set();
    checked.forEach(function (k) {
      var f = parseFieldKey(k);
      if (f !== null) fieldCheckedPorts.add(f.portKey);
    });

    // ── 过滤器：把各类命中折算到信号 ──
    var hitSignals = new Set();
    if (hasFilter) {
      hits.signals.forEach(function (id) { hitSignals.add(id); });
      hits.funcs.forEach(function (fid) {
        var f = ix.funcById.get(fid);
        if (f === undefined) return;
        (f.writes || []).forEach(function (sid) { hitSignals.add(sid); });
        (f.reads || []).forEach(function (sid) { hitSignals.add(sid); });
      });
      (model.signals || []).forEach(function (s) {
        var t = signalType(ix, s);
        if (t !== null && hits.types.has(t.id)) hitSignals.add(s.id);
        if (s.ownerType && hits.types.has(s.ownerType)) hitSignals.add(s.id);
      });
    }

    function portMatches(port) {
      if (!hasFilter) return true;
      if (hitSignals.has(port.signalId)) return true;
      // 类型本身作为模块时，模块 id 与类型 id 相同。
      if (hits.types.has(port.moduleId)) return true;
      var mid = port.moduleId;
      var guard = 0;
      while (mid !== undefined && mid !== null && guard < 64) {
        if (hits.modules.has(mid)) return true;
        mid = ix.parentById.get(mid);
        guard += 1;
      }
      return false;
    }

    function moduleAllowed(m) {
      return m !== undefined && m !== null &&
        (flags.showExcluded || !m.exclude);
    }

    function selfHit(m) {
      return hasFilter &&
        (hits.modules.has(m.id) || hits.types.has(m.id));
    }

    var loadedCache = new Map();
    function subtreeLoaded(moduleId) {
      if (!sliced) return true;
      if (loadedCache.has(moduleId)) return loadedCache.get(moduleId);
      loadedCache.set(moduleId, false); // 防御环
      var m = ix.moduleById.get(moduleId);
      if (m === undefined) {
        loadedCache.set(moduleId, true);
        return true;
      }
      // 空叶子（没有直属信号/函数、也没有子模块）没有任何切片可请求：
      // 预取会跳过它，不能让它把祖先的“整选”永久卡成不可用。
      var counts = m.counts || {};
      var emptyLeaf = (m.children || []).length === 0 &&
        (counts.signals || 0) + (counts.funcs || 0) === 0;
      var ok = (loaded.has(moduleId) || (sliced && emptyLeaf)) &&
        (m.children || []).every(subtreeLoaded);
      loadedCache.set(moduleId, ok);
      return ok;
    }

    var visibleKeysCache = new Map();
    function visibleSubtreeKeys(moduleId) {
      if (visibleKeysCache.has(moduleId)) return visibleKeysCache.get(moduleId);
      var keys = new Set();
      var entry = ports.byModule.get(moduleId);
      if (entry !== undefined) {
        entry.outputs.forEach(function (p) {
          if (portMatches(p)) keys.add(p.key);
        });
        entry.inputs.forEach(function (p) {
          if (portMatches(p)) keys.add(p.key);
        });
      }
      var m = moduleId === ORPHAN_MODULE_ID ? undefined : ix.moduleById.get(moduleId);
      if (m !== undefined) {
        (m.children || []).forEach(function (cid) {
          visibleSubtreeKeys(cid).forEach(function (k) { keys.add(k); });
        });
      }
      visibleKeysCache.set(moduleId, keys);
      return keys;
    }

    function pendingContent(m) {
      if (!sliced || loaded.has(m.id)) return false;
      var c = m.counts || {};
      return (c.signals || 0) + (c.funcs || 0) > 0;
    }

    function moduleVisible(m) {
      if (!moduleAllowed(m)) return false;
      if (hasFilter) {
        if (selfHit(m)) return true;
        if (visibleSubtreeKeys(m.id).size > 0) return true;
        // 切片下模块内容还没回来：先保留入口，避免整棵树在加载期间消失。
        return pendingContent(m);
      }
      if (showEmptyModules) return true;
      if (visibleSubtreeKeys(m.id).size > 0) return true;
      return pendingContent(m);
    }

    var rows = [];

    function portFieldsInfo(port) {
      var type = signalType(ix, port.signal);
      var info = resolveCtype(ix, port.signal.ctype);
      return {
        type: type,
        collection: info.collection,
        canFields: type !== null && (type.fields || []).length > 0,
      };
    }

    /**
     * 把模块直属端口按「唯一归属函数」分桶。
     *
     * 为什么需要这一层：
     *   C# 类型里的方法、C 文件里的函数，本来就是这个模块的子结构。旧树把
     *   一个模块的所有端口都平铺在「输出/输入信号」下，读者看不出“这条信号
     *   是哪个函数读写的”，在实时计算机这类有多个函数的模块上尤其明显。
     *
     * 归属规则刻意保守：
     *   - 端口只被一个可见函数读写 → 挂到该函数下；
     *   - 被多个函数共用、或没有任何函数归属（声明端口）→ 留在模块级；
     *   - 只有一个函数拥有专属端口时不建函数层：包一层不增加信息量，
     *     反而让所有端口多缩进一级。
     *
     * 返回值里的 outputs/inputs 是“留在模块级”的端口，函数桶里的端口已经从
     * 这两个列表里剔除，避免同一端口在树里出现两次（行键也就不会冲突）。
     */
    function funcPortLayout(m, outputs, inputs) {
      var ownFuncs = (ix.ownFuncs.get(m.id) || []).filter(function (f) {
        return visibleFunc(f, flags);
      });
      if (ownFuncs.length < 2) return null;

      var buckets = new Map();
      ownFuncs.forEach(function (f) {
        buckets.set(f.id, { func: f, outputs: [], inputs: [] });
      });
      var assigned = new Set();

      function assign(port, dir) {
        var owners = (port.funcIds || []).filter(function (fid) {
          return buckets.has(fid);
        });
        // 共用端口不硬塞给某一个函数：否则读者会误以为它只属于那个函数。
        if (owners.length !== 1) return;
        var bucket = buckets.get(owners[0]);
        if (dir === "out") bucket.outputs.push(port);
        else bucket.inputs.push(port);
        assigned.add(port.key);
      }
      outputs.forEach(function (port) { assign(port, "out"); });
      inputs.forEach(function (port) { assign(port, "in"); });

      var list = [];
      buckets.forEach(function (bucket) {
        if (bucket.outputs.length + bucket.inputs.length > 0) list.push(bucket);
      });
      list.sort(function (a, b) { return byName(a.func, b.func); });
      if (list.length < 2) return null;

      return {
        buckets: list,
        outputs: outputs.filter(function (port) { return !assigned.has(port.key); }),
        inputs: inputs.filter(function (port) { return !assigned.has(port.key); }),
      };
    }

    function pushModule(m, depth, chainGuard) {
      if (chainGuard.indexOf(m.id) >= 0) return;
      var key = "m|" + m.id;
      var entry = ports.byModule.get(m.id);
      var outputs = entry === undefined ? [] : entry.outputs.filter(portMatches);
      var inputs = entry === undefined ? [] : entry.inputs.filter(portMatches);
      var ownFuncs = (ix.ownFuncs.get(m.id) || []).filter(function (f) {
        return visibleFunc(f, flags);
      });
      // 符号表兜底的程序集只有函数名、没有读写关系：这些函数不属于任何端口，
      // 旧树因此把整批函数藏了起来（状态栏显示 63，树上却一个都看不到）。
      var funcsWithPorts = new Set();
      outputs.concat(inputs).forEach(function (p) {
        (p.funcIds || []).forEach(function (fid) { funcsWithPorts.add(fid); });
      });
      var portlessFuncs = ownFuncs.filter(function (f) {
        return !funcsWithPorts.has(f.id);
      });
      // 有多个函数各自拥有专属端口时，函数先作为子模块出现；共用/声明端口
      // 仍留在模块级（funcLayout.outputs/inputs 已经是剔除后的列表）。
      var funcLayout = funcPortLayout(m, outputs, inputs);
      var childIds = (m.children || [])
        .map(function (cid) { return ix.moduleById.get(cid); })
        .filter(moduleVisible)
        .sort(byName);
      var keys = visibleSubtreeKeys(m.id);
      var selected = 0;
      keys.forEach(function (k) { if (checked.has(k)) selected += 1; });
      var hasFieldSel = false;
      fieldCheckedPorts.forEach(function (pk) {
        if (keys.has(pk)) hasFieldSel = true;
      });
      var checkable = keys.size > 0 && subtreeLoaded(m.id);
      var expanded = !collapsed.has(key);
      var pending = pendingContent(m);
      var canExpand = childIds.length > 0 || outputs.length + inputs.length > 0 ||
        portlessFuncs.length > 0 || pending;

      var portCounts = ports.subtreeCounts.get(m.id) || { outputs: 0, inputs: 0 };
      var badges = [];
      // 方向全是推断的模块不能标「出」：符号表只看得到全局变量，看不到谁写。
      var onlyInferredOut = outputs.length > 0 && inputs.length === 0 &&
        outputs.every(function (p) { return p.inferredDir; });
      if (onlyInferredOut) badges.push("信号 " + portCounts.outputs);
      else if (portCounts.outputs > 0) badges.push("出 " + portCounts.outputs);
      if (portCounts.inputs > 0) badges.push("入 " + portCounts.inputs);
      if (portlessFuncs.length > 0) badges.push("函数 " + portlessFuncs.length);

      if (!moduleRowKey.has(m.id)) {
        moduleRowKey.set(m.id, key);
        moduleRowIndex.set(m.id, rows.length);
      }
      rows.push({
        key: key,
        kind: "module",
        index: rows.length,
        depth: depth,
        label: m.name || "（根）",
        // 路径不再挂在行上：它太长，会把信号名挤没。完整路径在下方信息区。
        meta: "",
        badges: badges,
        expandable: canExpand,
        expanded: expanded,
        checkable: checkable,
        checked: checkable && keys.size > 0 && selected === keys.size,
        indeterminate: checkable && (selected > 0 || hasFieldSel) && selected < keys.size,
        portKeys: Array.from(keys),
        moduleId: m.id,
        entityKind: "module",
        entityId: m.id,
      });
      if (!expanded) return;

      // 先子模块、再函数、最后本模块 I/O：树的主干保持“往下钻”的阅读顺序。
      var nextGuard = chainGuard.concat([m.id]);
      childIds.forEach(function (child) { pushModule(child, depth + 1, nextGuard); });
      if (funcLayout !== null) {
        funcLayout.buckets.forEach(function (bucket) {
          pushFunction(m, bucket, depth + 1);
        });
      }
      var directOutputs = funcLayout === null ? outputs : funcLayout.outputs;
      var directInputs = funcLayout === null ? inputs : funcLayout.inputs;
      // 方向未知的端口不混进「输出信号」：那会把符号表兜底的猜测说成事实。
      var unknownOutputs = directOutputs.filter(function (p) { return p.inferredDir; });
      var knownOutputs = directOutputs.filter(function (p) { return !p.inferredDir; });
      pushPortGroup(m, "out", knownOutputs, depth + 1);
      pushPortGroup(m, "in", directInputs, depth + 1);
      pushUnknownGroup(m, unknownOutputs, depth + 1);
      // 无端口函数放最后：它们不是可勾选的端口，63 行不应把信号挤出首屏。
      if (portlessFuncs.length > 0) {
        pushFunctionList(m, portlessFuncs, depth + 1);
      }
    }

    /**
     * 无端口函数的折叠组。
     *
     * 典型的无元数据 ELF：符号表能列出 63 个函数，却没有任何读写关系，
     * 于是每个函数都不拥有端口。函数仍然要能点开看（名称、类型、所属模块），
     * 否则「状态栏有 63、树上没有」会让人以为解析丢了数据。
     */
    function pushFunctionList(m, funcs, depth) {
      var key = "gx|func|" + m.id;
      var expanded = !collapsed.has(key);
      rows.push({
        key: key,
        kind: "group",
        index: rows.length,
        depth: depth,
        dir: "func",
        label: "函数",
        meta: String(funcs.length),
        badges: ["无端口"],
        expandable: true,
        expanded: expanded,
        checkable: false,
        checked: false,
        indeterminate: false,
        portKeys: [],
        moduleId: m.id,
      });
      if (!expanded) return;
      funcs.forEach(function (f) {
        rows.push({
          key: "f|" + m.id + "|" + f.id,
          kind: "func",
          index: rows.length,
          depth: depth + 1,
          label: f.name || f.id,
          meta: "",
          badges: ["函数"],
          expandable: false,
          expanded: false,
          checkable: false,
          checked: false,
          indeterminate: false,
          portKeys: [],
          moduleId: m.id,
          funcId: f.id,
          entityKind: "func",
          entityId: f.id,
        });
      });
    }

    /** 方向未标注的端口组：key 与 out/in 分组不同，勾选与折叠互不影响。 */
    function pushUnknownGroup(m, list, depth) {
      if (list.length === 0) return;
      var row = makePortGroupRow(m, "out", list, depth, "gu|" + m.id, {
        dir: "unknown",
        label: "信号（方向未标注）",
      });
      rows.push(row);
      list.forEach(function (port) { portAnchorKeys.set(port.key, row.key); });
      if (!row.expanded) return;
      list.forEach(function (port) {
        rows.push(makePortRow(port, depth + 1, port.key));
        notePortRow(port.key, port.key, rows.length - 1);
      });
    }

    /**
     * 端口分组行。
     *
     * 普通树与分组模式共用，只是 key 由调用方给：普通树是
     * `g|方向|模块`，分组模式下同一模块可能出现多次，必须带上出现路径。
     */
    function makePortGroupRow(m, dir, list, depth, key, overrides) {
      var keys = list.map(function (p) { return p.key; });
      var selected = keys.filter(function (k) { return checked.has(k); }).length;
      var hasFieldSel = keys.some(function (k) { return fieldCheckedPorts.has(k); });
      var expanded = !collapsed.has(key);
      var viewDir = overrides && overrides.dir ? overrides.dir : dir;
      return {
        key: key,
        kind: "group",
        index: rows.length,
        depth: depth,
        // portDir 保留端口真实方向（unknown 组的端口仍是 out）；dir 决定展示语义。
        portDir: dir,
        dir: viewDir,
        label: overrides && overrides.label ? overrides.label : portDirLabel(dir) + "信号",
        meta: String(list.length),
        badges: [],
        expandable: true,
        expanded: expanded,
        checkable: true,
        checked: selected === list.length,
        indeterminate: (selected > 0 || hasFieldSel) && selected < list.length,
        portKeys: keys,
        moduleId: m.id,
      };
    }

    /** 端口行；行 key 同样交给调用方，分组模式下不能再用 portKey 当行键。 */
    function makePortRow(port, depth, key) {
      var s = port.signal;
      var info = portFieldsInfo(port);
      var portKey = port.key;
      return {
        key: key,
        kind: "port",
        index: rows.length,
        depth: depth,
        dir: port.dir,
        label: signalLabel(s),
        // 类型名不挂在端口行上：基本类型用 `[int]` chip 表达，结构体类型名进
        // groupbox 标题与下方信息区。行尾只留信号名，横向空间还给名字本身。
        meta: "",
        // 基本类型的信号在树行里直接显示 `[int]`，不再占一个字段列/groupbox 位置。
        // 结构体信号不挂 chip：类型名会由 groupbox 标题与下方信息区负责。
        typeChip: basicTypeLabel(ix, s.ctype),
        badges: info.collection ? ["元素"] : [],
        // 端口本身不展开：字段属于右侧 groupbox，不属于树。
        expandable: false,
        expanded: false,
        checkable: true,
        checked: checked.has(portKey),
        indeterminate: !checked.has(portKey) && fieldCheckedPorts.has(portKey),
        portKey: portKey,
        signalId: s.id,
        moduleId: port.moduleId,
        funcIds: port.funcIds.slice(),
        declared: port.declared,
        inferredDir: port.inferredDir === true,
        typeName: info.type === null ? "" : displayTypeName(info, s.ctype),
        collection: info.collection,
      };
    }

    /** 记录端口第一次出现的行；数据流与 groupbox 行号都以它为准。 */
    function notePortRow(portKey, rowKey, index) {
      if (!portRowIndex.has(portKey)) {
        portRowIndex.set(portKey, index);
        portRowKey.set(portKey, rowKey);
      }
    }

    function pushPortGroup(m, dir, list, depth) {
      if (list.length === 0) return;
      var key = "g|" + dir + "|" + m.id;
      var row = makePortGroupRow(m, dir, list, depth, key);
      rows.push(row);
      // 分组折叠时端口行不存在，连线要锚到这一行；展开时端口行会覆盖它。
      list.forEach(function (port) { portAnchorKeys.set(port.key, key); });
      if (!row.expanded) return;
      list.forEach(function (port) {
        rows.push(makePortRow(port, depth + 1, port.key));
        notePortRow(port.key, port.key, rows.length - 1);
      });
    }

    /** 函数行：函数作为模块的子模块出现，只承载“唯一归属它”的端口。 */
    function pushFunction(m, bucket, depth) {
      var f = bucket.func;
      var key = "f|" + m.id + "|" + f.id;
      var keys = bucket.outputs.concat(bucket.inputs).map(function (p) {
        return p.key;
      });
      var selected = keys.filter(function (k) { return checked.has(k); }).length;
      var hasFieldSel = keys.some(function (k) { return fieldCheckedPorts.has(k); });
      var expanded = !collapsed.has(key);
      var badges = ["函数"];
      if (bucket.outputs.length > 0) badges.push("出 " + bucket.outputs.length);
      if (bucket.inputs.length > 0) badges.push("入 " + bucket.inputs.length);

      if (!funcRowKey.has(f.id)) {
        funcRowKey.set(f.id, key);
        funcRowIndex.set(f.id, rows.length);
      }
      rows.push({
        key: key,
        kind: "func",
        index: rows.length,
        depth: depth,
        label: f.name || f.id,
        meta: "",
        badges: badges,
        expandable: keys.length > 0,
        expanded: expanded,
        checkable: keys.length > 0,
        checked: keys.length > 0 && selected === keys.length,
        indeterminate: keys.length > 0 && (selected > 0 || hasFieldSel) && selected < keys.length,
        portKeys: keys,
        moduleId: m.id,
        funcId: f.id,
        entityKind: "func",
        entityId: f.id,
      });

      // 函数折叠时，端口行不存在；锚到这个函数行比锚到整个模块更贴近读者预期。
      keys.forEach(function (k) { portAnchorKeys.set(k, key); });
      if (!expanded) return;
      pushFuncPortGroup(m, f, "out", bucket.outputs, depth + 1, key);
      pushFuncPortGroup(m, f, "in", bucket.inputs, depth + 1, key);
    }

    function pushFuncPortGroup(m, f, dir, list, depth, funcKey) {
      if (list.length === 0) return;
      // 组键必须带函数：同名方向分组在不同函数下要能独立折叠。
      var key = "gf|" + dir + "|" + m.id + "|" + f.id;
      var row = makePortGroupRow(m, dir, list, depth, key);
      row.funcId = f.id;
      rows.push(row);
      list.forEach(function (port) { portAnchorKeys.set(port.key, key); });
      if (!row.expanded) return;
      // 端口在这里最多出现一次（共用端口留在模块级），所以行键仍可用 portKey。
      list.forEach(function (port) {
        rows.push(makePortRow(port, depth + 1, port.key));
        notePortRow(port.key, port.key, rows.length - 1);
      });
    }

    if (!grouping) {
    // ── 顶层模块 ──
    var tops = (model.modules || []).filter(function (m) {
      return !ix.childModuleIds.has(m.id) && moduleVisible(m);
    }).sort(byName);
    tops.forEach(function (m) { pushModule(m, 0, []); });

    // ── 未归属桶 ──
    var orphanEntry = ports.byModule.get(ORPHAN_MODULE_ID);
    var orphanOutputs = orphanEntry === undefined ? [] : orphanEntry.outputs.filter(portMatches);
    var orphanInputs = orphanEntry === undefined ? [] : orphanEntry.inputs.filter(portMatches);
    var orphanVisible = orphanOutputs.length + orphanInputs.length > 0 ||
      (sliced && hasOrphans);
    if (orphanVisible) {
      var orphan = ports.orphanModule;
      var okey = "m|" + ORPHAN_MODULE_ID;
      var okeys = visibleSubtreeKeys(ORPHAN_MODULE_ID);
      var oselected = 0;
      okeys.forEach(function (k) { if (checked.has(k)) oselected += 1; });
      var oexpanded = !collapsed.has(okey);
      if (!moduleRowKey.has(ORPHAN_MODULE_ID)) {
        moduleRowKey.set(ORPHAN_MODULE_ID, okey);
        moduleRowIndex.set(ORPHAN_MODULE_ID, rows.length);
      }
      rows.push({
        key: okey,
        kind: "module",
        index: rows.length,
        depth: 0,
        label: "（未归属）",
        meta: "没有对应模块",
        badges: [],
        expandable: orphanOutputs.length + orphanInputs.length > 0 || (sliced && hasOrphans),
        expanded: oexpanded,
        checkable: okeys.size > 0 && (!sliced || loaded.has(ORPHAN_MODULE_ID)),
        checked: okeys.size > 0 && oselected === okeys.size,
        indeterminate: oselected > 0 && oselected < okeys.size,
        portKeys: Array.from(okeys),
        moduleId: ORPHAN_MODULE_ID,
        entityKind: "module",
        entityId: ORPHAN_MODULE_ID,
      });
      if (oexpanded) {
        pushPortGroup(orphan, "out", orphanOutputs, 1);
        pushPortGroup(orphan, "in", orphanInputs, 1);
      }
    }
    } else {
      buildGroupedRows();
    }

    /**
     * 分组模式的行构建。
     *
     * 与普通树的区别只有两点：
     *   1. 模块不再按父子关系缩进，而是按属性值挂到桶下（扁平化）；
     *   2. 同一模块可能出现在多个桶里，因此所有行 key 都带“出现路径”，
     *      不能让 portKey 直接当行键。
     *
     * 这里先算出每个模块的完整路径，再建一棵值树，最后按可见性渲染。
     * 好处是折叠的桶也能提前登记「展开这个模块要移除哪些 collapsed key」，
     * 定位端口时不必逐层试错。
     */
    function buildGroupedRows() {
      function visiblePortsOf(m) {
        var entry = ports.byModule.get(m.id);
        if (entry === undefined) return { outputs: [], inputs: [] };
        return {
          outputs: entry.outputs.filter(portMatches),
          inputs: entry.inputs.filter(portMatches),
        };
      }

      function byModulePath(a, b) {
        var ap = a.m.path || a.m.name || a.m.id || "";
        var bp = b.m.path || b.m.name || b.m.id || "";
        return ap < bp ? -1 : ap > bp ? 1 : 0;
      }

      // ── 候选模块 ──
      // 分组是“扁平”的：有直属端口的模块才成为叶子，命名空间祖先不参与，
      // 否则每个命名空间都会被算进它所有子模块的属性桶里，噪音翻倍。
      var candidates = [];
      (model.modules || []).forEach(function (m) {
        if (!moduleAllowed(m)) return;
        var vp = visiblePortsOf(m);
        var ownPorts = vp.outputs.length + vp.inputs.length;
        if (ownPorts > 0) {
          candidates.push({ m: m, vp: vp });
          return;
        }
        if (hasFilter && selfHit(m)) {
          candidates.push({ m: m, vp: vp });
          return;
        }
        if (showEmptyModules) {
          candidates.push({ m: m, vp: vp });
          return;
        }
        // 切片还没到的模块先留在未标注桶，切片到达后它会自动归位。
        if (pendingContent(m)) candidates.push({ m: m, vp: vp });
      });

      var orphanEntry = ports.byModule.get(ORPHAN_MODULE_ID);
      var orphanVp = {
        outputs: orphanEntry === undefined ? [] : orphanEntry.outputs.filter(portMatches),
        inputs: orphanEntry === undefined ? [] : orphanEntry.inputs.filter(portMatches),
      };
      if (orphanVp.outputs.length + orphanVp.inputs.length > 0 ||
          (sliced && hasOrphans)) {
        candidates.push({ m: ports.orphanModule, vp: orphanVp });
      }
      candidates.sort(byModulePath);

      /**
       * 收集一个模块在各层分组属性上的值。
       *
       * 取数范围：直属端口（已被过滤）、模块自己的信号/函数/类型标签、以及
       * “类型即模块”时类型自身的标签。裸标签由 facetOfTag 归到「标签」分类，
       * 所以 C/ELF 程序集也能按 telemetry、rmem 这类标签分组。
       */
      function moduleFacetValues(m, vp) {
        var values = new Map();
        groupLevels.forEach(function (name) { values.set(name, new Set()); });
        function addTags(tags) {
          (tags || []).forEach(function (tag) {
            var facet = facetOfTag(tag);
            if (facet === null) return;
            var set = values.get(facet.name);
            if (set !== undefined) set.add(facet.value);
          });
        }
        vp.outputs.forEach(function (p) { addTags(p.signal.tags); });
        vp.inputs.forEach(function (p) { addTags(p.signal.tags); });
        (ix.ownSignals.get(m.id) || []).forEach(function (s) { addTags(s.tags); });
        (ix.ownFuncs.get(m.id) || []).forEach(function (f) { addTags(f.tags); });
        (ix.ownTypes.get(m.id) || []).forEach(function (t) { addTags(t.tags); });
        var typeModule = ix.typeByModuleId.get(m.id);
        if (typeModule !== undefined) addTags(typeModule.tags);
        return values;
      }

      /** 一层的值 → 下一层；缺值时进 `（未标注）` 桶。 */
      function pathsFor(values) {
        var paths = [[]];
        groupLevels.forEach(function (name) {
          var set = values.get(name);
          var list = [];
          if (set !== undefined && set.size > 0) {
            set.forEach(function (value) { list.push(value); });
            list.sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
          } else {
            list.push(GROUP_UNLABELED);
          }
          var next = [];
          paths.forEach(function (prefix) {
            list.forEach(function (value) { next.push(prefix.concat([value])); });
          });
          if (next.length > GROUP_MAX_PATHS_PER_MODULE) {
            groupingTruncated = true;
            next = next.slice(0, GROUP_MAX_PATHS_PER_MODULE);
          }
          paths = next;
        });
        return paths;
      }

      function bucketKeyOf(path) {
        return "gg|" + encodeURIComponent(path.join(GROUP_PATH_SEP));
      }

      function moduleOccurrenceKey(path, moduleId) {
        return "gm|" + encodeURIComponent(path.join(GROUP_PATH_SEP)) +
          "|" + encodeURIComponent(moduleId);
      }

      function noteUncollapse(moduleId, keys) {
        var list = uncollapseByModule.get(moduleId);
        if (list === undefined) {
          list = [];
          uncollapseByModule.set(moduleId, list);
        }
        keys.forEach(function (key) {
          if (list.indexOf(key) < 0) list.push(key);
        });
      }

      function makeBucketNode() {
        return {
          children: new Map(),
          modules: [],
          portKeys: new Set(),
          moduleIds: new Set(),
        };
      }

      // ── 建值树 ──
      var root = makeBucketNode();
      candidates.forEach(function (entry) {
        var values = moduleFacetValues(entry.m, entry.vp);
        var ownPortKeys = entry.vp.outputs.concat(entry.vp.inputs).map(function (p) {
          return p.key;
        });
        pathsFor(values).forEach(function (path) {
          var node = root;
          // 桶的计数与可勾选端口都按“子树聚合”：勾一个桶等于勾它下面所有端口。
          node.moduleIds.add(entry.m.id);
          ownPortKeys.forEach(function (key) { node.portKeys.add(key); });
          path.forEach(function (value) {
            var child = node.children.get(value);
            if (child === undefined) {
              child = makeBucketNode();
              node.children.set(value, child);
            }
            node = child;
            node.moduleIds.add(entry.m.id);
            ownPortKeys.forEach(function (key) { node.portKeys.add(key); });
          });
          node.modules.push({
            module: entry.m,
            vp: entry.vp,
            path: path,
            ownPortKeys: ownPortKeys,
          });

          // 折叠的桶不渲染子行，但定位端口时仍要能一次展开到位。
          var pathKeys = [];
          for (var i = 0; i < path.length; i += 1) {
            pathKeys.push(bucketKeyOf(path.slice(0, i + 1)));
          }
          var moduleKey = moduleOccurrenceKey(path, entry.m.id);
          var chain = pathKeys.concat([
            moduleKey,
            "gpg|" + moduleKey + "|out",
            "gpg|" + moduleKey + "|in",
          ]);
          noteUncollapse(entry.m.id, chain);
          var chains = occurrenceChains.get(entry.m.id);
          if (chains === undefined) {
            chains = [];
            occurrenceChains.set(entry.m.id, chains);
          }
          chains.push(chain);
        });
      });

      var occurrences = 0;

      function pushGroupedPortGroup(m, dir, list, depth, moduleKey) {
        if (list.length === 0) return;
        var key = "gpg|" + moduleKey + "|" + dir;
        var row = makePortGroupRow(m, dir, list, depth, key);
        rows.push(row);
        list.forEach(function (port) { portAnchorKeys.set(port.key, key); });
        if (!row.expanded) return;
        list.forEach(function (port) {
          var portKey = "gport|" + moduleKey + "|" + encodeURIComponent(port.key);
          rows.push(makePortRow(port, depth + 1, portKey));
          notePortRow(port.key, portKey, rows.length - 1);
        });
      }

      /**
       * 分组模式下的函数行。
       *
       * 桶/模块可能出现多次，所以函数行键必须带模块出现键；端口行键带函数键，
       * 保证同一端口在不同桶的两次出现不会互相覆盖。
       */
      function pushGroupedFunction(entry, path, bucket, depth, moduleKey) {
        var m = entry.module;
        var f = bucket.func;
        var key = "gfn|" + moduleKey + "|" + encodeURIComponent(f.id);
        var keys = bucket.outputs.concat(bucket.inputs).map(function (p) {
          return p.key;
        });
        var selected = keys.filter(function (k) { return checked.has(k); }).length;
        var hasFieldSel = keys.some(function (k) { return fieldCheckedPorts.has(k); });
        var expanded = !collapsed.has(key);
        var badges = ["函数"];
        if (bucket.outputs.length > 0) badges.push("出 " + bucket.outputs.length);
        if (bucket.inputs.length > 0) badges.push("入 " + bucket.inputs.length);

        if (!funcRowKey.has(f.id)) {
          funcRowKey.set(f.id, key);
          funcRowIndex.set(f.id, rows.length);
        }
        rows.push({
          key: key,
          kind: "func",
          index: rows.length,
          depth: depth,
          label: f.name || f.id,
          meta: "",
          badges: badges,
          expandable: keys.length > 0,
          expanded: expanded,
          checkable: keys.length > 0,
          checked: keys.length > 0 && selected === keys.length,
          indeterminate: keys.length > 0 && (selected > 0 || hasFieldSel) && selected < keys.length,
          portKeys: keys,
          moduleId: m.id,
          funcId: f.id,
          entityKind: "func",
          entityId: f.id,
          groupPath: path.slice(),
        });
        keys.forEach(function (k) { portAnchorKeys.set(k, key); });
        if (!expanded) return;
        pushGroupedFuncPortGroup(m, f, "out", bucket.outputs, depth + 1, key);
        pushGroupedFuncPortGroup(m, f, "in", bucket.inputs, depth + 1, key);
      }

      function pushGroupedFuncPortGroup(m, f, dir, list, depth, funcKey) {
        if (list.length === 0) return;
        var key = "gpfg|" + funcKey + "|" + dir;
        var row = makePortGroupRow(m, dir, list, depth, key);
        row.funcId = f.id;
        rows.push(row);
        list.forEach(function (port) { portAnchorKeys.set(port.key, key); });
        if (!row.expanded) return;
        list.forEach(function (port) {
          var portKey = "gport|" + funcKey + "|" + encodeURIComponent(port.key);
          rows.push(makePortRow(port, depth + 1, portKey));
          notePortRow(port.key, portKey, rows.length - 1);
        });
      }

      function pushGroupedModule(entry, path, depth) {
        if (occurrences >= GROUP_MAX_OCCURRENCES) {
          groupingTruncated = true;
          return;
        }
        occurrences += 1;
        var m = entry.module;
        var moduleKey = moduleOccurrenceKey(path, m.id);
        var keys = entry.ownPortKeys;
        var funcLayout = funcPortLayout(m, entry.vp.outputs, entry.vp.inputs);
        var selected = keys.filter(function (key) { return checked.has(key); }).length;
        var hasFieldSel = keys.some(function (key) { return fieldCheckedPorts.has(key); });
        var expanded = !collapsed.has(moduleKey);
        var badges = [];
        if (entry.vp.outputs.length > 0) badges.push("出 " + entry.vp.outputs.length);
        if (entry.vp.inputs.length > 0) badges.push("入 " + entry.vp.inputs.length);

        if (!moduleRowKey.has(m.id)) {
          moduleRowKey.set(m.id, moduleKey);
          moduleRowIndex.set(m.id, rows.length);
        }
        rows.push({
          key: moduleKey,
          kind: "module",
          index: rows.length,
          depth: depth,
          label: m.name || "（根）",
          meta: "",
          badges: badges,
          expandable: keys.length > 0,
          expanded: expanded,
          checkable: keys.length > 0,
          checked: keys.length > 0 && selected === keys.length,
          indeterminate: selected > 0 && selected < keys.length,
          portKeys: keys,
          moduleId: m.id,
          entityKind: "module",
          entityId: m.id,
          groupPath: path.slice(),
        });
        if (!expanded) return;
        if (funcLayout !== null) {
          funcLayout.buckets.forEach(function (bucket) {
            pushGroupedFunction(entry, path, bucket, depth + 1, moduleKey);
          });
        }
        var directOutputs = funcLayout === null ? entry.vp.outputs : funcLayout.outputs;
        var directInputs = funcLayout === null ? entry.vp.inputs : funcLayout.inputs;
        pushGroupedPortGroup(m, "out", directOutputs, depth + 1, moduleKey);
        pushGroupedPortGroup(m, "in", directInputs, depth + 1, moduleKey);
      }

      function renderBuckets(node, depth, path) {
        var values = [];
        node.children.forEach(function (_, value) { values.push(value); });
        values.sort(function (a, b) {
          // 未标注永远放最后：它是“缺失值”，不是字典序里的普通值。
          if (a === GROUP_UNLABELED) return 1;
          if (b === GROUP_UNLABELED) return -1;
          return a < b ? -1 : a > b ? 1 : 0;
        });

        values.forEach(function (value) {
          var child = node.children.get(value);
          var nextPath = path.concat([value]);
          var key = bucketKeyOf(nextPath);
          var portKeys = [];
          child.portKeys.forEach(function (portKey) { portKeys.push(portKey); });
          var selected = portKeys.filter(function (portKey) {
            return checked.has(portKey);
          }).length;
          var expanded = !collapsed.has(key);
          var label = value === GROUP_UNLABELED ? GROUP_UNLABELED_LABEL : value;
          rows.push({
            key: key,
            kind: "bucket",
            index: rows.length,
            depth: depth,
            level: groupLevels[depth],
            levelIndex: depth,
            value: value === GROUP_UNLABELED ? "" : value,
            valueLabel: label,
            label: label,
            meta: child.moduleIds.size + " 模块",
            badges: [groupLevels[depth]],
            expandable: true,
            expanded: expanded,
            checkable: portKeys.length > 0,
            checked: portKeys.length > 0 && selected === portKeys.length,
            indeterminate: selected > 0 && selected < portKeys.length,
            portKeys: portKeys,
            moduleIds: Array.from(child.moduleIds),
            pathValues: nextPath.slice(),
          });
          if (!expanded) return;
          if (depth + 1 < groupLevels.length) {
            renderBuckets(child, depth + 1, nextPath);
          } else {
            child.modules.forEach(function (entry) {
              pushGroupedModule(entry, nextPath, depth + 1);
            });
          }
        });
      }

      renderBuckets(root, 0, []);
    }

    var indexByKey = new Map();
    rows.forEach(function (row) { indexByKey.set(row.key, row.index); });

    // ── 端口 → 最近可见行 ──────────────────────────────────────────────
    //
    // 端口行被折叠/过滤掉时，连线不能凭空消失：它应该挂到最近一个还在
    // 列表里的祖先行上（先“输出/输入信号”分组行，再本模块行，再往上
    // 找祖先模块行）。用户看到的是“这条流仍然指向那个收起来的模块”，
    // 而不是“勾了却什么都没画”。
    var rowIndexByPortKey = new Map();
    portRowIndex.forEach(function (index, key) { rowIndexByPortKey.set(key, index); });

    function moduleAnchorIndex(moduleId) {
      var cursor = moduleId;
      var guard = 0;
      // parentById 由 getIndex 建立；根模块没有父条目，循环自然结束。
      while (cursor !== null && cursor !== undefined && guard < 256) {
        if (grouping) {
          // 分组树没有“祖先模块行”。沿该模块的每次出现链，取最深的、
          // 仍在 indexByKey 里的行：桶折叠时是桶行，模块折叠时是模块行，
          // 展开到底时端口行本来就不需要锚定。
          var chains = occurrenceChains.get(cursor);
          if (chains !== undefined) {
            for (var ci = 0; ci < chains.length; ci += 1) {
              var chain = chains[ci];
              var anchor = null;
              for (var ki = 0; ki < chain.length; ki += 1) {
                var chainIndex = indexByKey.get(chain[ki]);
                if (chainIndex === undefined) break;
                anchor = chainIndex;
              }
              if (anchor !== null) return anchor;
            }
            return null;
          }
          // 未归属伪模块没有出现链，仍用首次出现兜底。
          if (moduleRowIndex.has(cursor)) return moduleRowIndex.get(cursor);
        } else {
          if (cursor === ORPHAN_MODULE_ID) {
            return indexByKey.has("m|" + ORPHAN_MODULE_ID)
              ? indexByKey.get("m|" + ORPHAN_MODULE_ID)
              : null;
          }
          var moduleKey = "m|" + cursor;
          if (indexByKey.has(moduleKey)) return indexByKey.get(moduleKey);
        }
        cursor = ix.parentById.get(cursor);
        guard += 1;
      }
      return null;
    }

    ports.byKey.forEach(function (port, key) {
      if (rowIndexByPortKey.has(key)) return;
      // 端口自己所在的分组/函数行还在时，优先锚到它；函数折叠后线不会
      // 一下子跳到模块行，读者仍能看出这条流属于哪个函数。
      var ownAnchorKey = portAnchorKeys.get(key);
      if (ownAnchorKey !== undefined) {
        var ownAnchorIndex = indexByKey.get(ownAnchorKey);
        if (ownAnchorIndex !== undefined) {
          rowIndexByPortKey.set(key, ownAnchorIndex);
          return;
        }
      }
      if (!grouping) {
        var groupKey = "g|" + port.dir + "|" + port.moduleId;
        if (indexByKey.has(groupKey)) {
          rowIndexByPortKey.set(key, indexByKey.get(groupKey));
          return;
        }
      }
      var anchor = moduleAnchorIndex(port.moduleId);
      if (anchor !== null) rowIndexByPortKey.set(key, anchor);
    });

    // groupbox 的行号跟着端口第一次出现的位置走；端口被折叠时落到锚定行。
    var groups = buildGroups(model, state, ix, ports, checked, rowIndexByPortKey);

    var knownLevels = new Set();
    facetGroups(model).forEach(function (group) { knownLevels.add(group.name); });

    return {
      rows: rows,
      groups: groups,
      height: rows.length,
      rowCount: rows.length,
      indexByKey: indexByKey,
      rowIndexByPortKey: rowIndexByPortKey,
      // 端口自身（未被锚定）的行下标。分组模式下 indexByKey 里没有端口键，
      // 数据流要靠这张表区分“端口真的在这一行”与“锚到了祖先行”。
      portRowIndex: portRowIndex,
      portRowKey: portRowKey,
      moduleRowKey: moduleRowKey,
      funcRowKey: funcRowKey,
      funcRowIndex: funcRowIndex,
      uncollapseByModule: uncollapseByModule,
      portCount: ports.byKey.size,
      moduleRows: rows.filter(function (r) { return r.kind === "module"; }).length,
      funcRows: rows.filter(function (r) { return r.kind === "func"; }).length,
      grouping: {
        enabled: grouping,
        levels: groupLevels.slice(),
        missingLevels: groupLevels.filter(function (name) {
          return !knownLevels.has(name);
        }),
        truncated: groupingTruncated,
      },
    };
  }

  /**
   * 经典树形缩进的辅助线信息。
   *
   * 输入是**当前可见的行**（每行带 depth），输出与行等长的数组，
   * 每项 `{guides: boolean[], last: boolean}`。深度为 d 的行有 d 个
   * 缩进格，格子 k 对应深度 k+1 的祖先分支（最后一格是本行的拐角）：
   *   - guides[k]（k < d-1）为真：深度 k+1 的祖先后面还有兄弟，
   *     该格画一条贯穿整行高度的虚线（│）；
   *   - 最后一格（k = d-1）是拐角：竖线从行顶画到中线，再横一段接到
   *     本行的 +/− 框；`last` 为真时竖线止于中线（└），否则画到行底
   *     （├），与下一个兄弟的竖线接上。
   *
   * 注意格子与深度差一位：第 0 格画的是“父辈是否还有兄弟”，不是
   * “根是否有兄弟”——这才是经典文件树的画法。
   *
   * 算法从下往上扫，维护 nextLE[k] = 当前位置之后深度 ≤ k 的最近行号：
   * 那个最近行的深度恰好等于 k+1，就说明深度 k+1 有后续兄弟，该继续
   * 往下画。O(行数 × 深度)，与树的规模线性相关。
   *
   * 放在 logic 层是因为它是纯几何计算、与 DOM 无关，可以直接单测；
   * 左树与右侧 groupbox 共用同一套算法，两处的树形样式才不会走样。
   */
  function treeGuides(rows) {
    var n = rows.length;
    var out = new Array(n);
    var maxDepth = 0;
    for (var i = 0; i < n; i += 1) {
      var d = rows[i].depth || 0;
      if (d > maxDepth) maxDepth = d;
    }
    // 多留一格：depth = maxDepth 的行也要查 nextLE[maxDepth + 1] 不存在，
    // 直接越界返回 -1 即可，这里用 +1 的下标避免分支。
    var nextLE = new Array(maxDepth + 2);
    for (var z = 0; z < nextLE.length; z += 1) nextLE[z] = -1;
    for (var i2 = n - 1; i2 >= 0; i2 -= 1) {
      var depth = rows[i2].depth || 0;
      var guides = new Array(depth);
      for (var k = 0; k < depth; k += 1) {
        var j = nextLE[k + 1];
        guides[k] = j >= 0 && rows[j].depth === k + 1;
      }
      // 最后一格（拐角）的竖线是否继续到行底，等价于本行后面还有兄弟。
      // depth = 0 的根行没有拐角，但 last 仍按“后面还有没有同级行”算，
      // 语义统一，调用方不必为根行特判。
      var jd = nextLE[depth];
      var last = !(jd >= 0 && rows[jd].depth === depth);
      out[i2] = { guides: guides, last: last };
      for (var m = depth; m < nextLE.length; m += 1) nextLE[m] = i2;
    }
    return out;
  }

  /**
   * 由勾选集合生成 groupbox 列表。
   *
   * 排序就是 `checked` 的插入顺序——用户勾选的先后顺序，符合“我刚加的
   * 那个在最下面”的直觉。恢复的存档里数组顺序同样保留。
   */
  function buildGroups(model, state, ix, ports, checked, rowIndexByPortKey) {
    // 默认展开所有层级：state 里只保存用户手动收起的节点。
    var collapsed = asSet(state.groupCollapsed);
    var groups = [];
    var seenPorts = new Set();

    checked.forEach(function (key) {
      var portKey = null;
      if (parsePortKey(key) !== null) {
        portKey = key;
      } else {
        var field = parseFieldKey(key);
        if (field !== null) portKey = field.portKey;
      }
      if (portKey === null || seenPorts.has(portKey)) return;
      var port = ports.byKey.get(portKey);
      if (port === undefined) return;
      // 基本类型没有字段可展开：它只在左侧树里以 `[int]` 出现，
      // 不生成空 groupbox。跨程序集、字段未知的类型同理。
      var signalTypeObj = signalType(ix, port.signal);
      if (signalTypeObj === null || (signalTypeObj.fields || []).length === 0) return;
      seenPorts.add(portKey);
      groups.push(makeGroup(port, portKey));
    });

    function makeGroup(port, portKey) {
      var signal = port.signal;
      var type = signalType(ix, signal);
      var info = resolveCtype(ix, signal.ctype);
      var reveal = new Set();
      // 勾了深层字段时，把它的祖先路径自动展开：否则 groupbox 打开后
      // 用户看不到自己勾的那一行，会以为勾选丢失了。
      checked.forEach(function (key) {
        var field = parseFieldKey(key);
        if (field === null || field.portKey !== portKey) return;
        var parts = field.path.split("/");
        var path = "";
        for (var i = 0; i < parts.length; i += 1) {
          path = path === "" ? parts[i] : path + "/" + parts[i];
          reveal.add(path);
        }
      });

      var fieldRows = [];
      if (type !== null) {
        walk(type, 0, "", [type.id]);
      }

      function walk(typeObj, depth, parentPath, typeChain) {
        (typeObj.fields || []).forEach(function (field) {
          var path = parentPath === "" ? field.name : parentPath + "/" + field.name;
          var target = resolveFieldType(ix, field);
          var targetType = target.type;
          var canDescend = targetType !== null &&
            (targetType.fields || []).length > 0 &&
            typeChain.indexOf(targetType.id) < 0 &&
            depth + 1 < MAX_FIELD_DEPTH;
          // 键里的列号沿用“深度+1”：路径本身已经唯一，列号只用于调试可读。
          var fkey = fieldKeyOf(portKey, depth + 1, path);
          // 默认展开；勾选深层字段时其祖先必须可见，所以 reveal 优先于手动收起。
          var isOpen = reveal.has(fkey) || !collapsed.has(fkey);
          var basic = targetType === null
            ? basicTypeLabel(ix, field.ctype)
            : null;
          var hasInitial = field.initial !== undefined && field.initial !== null && field.initial !== "";
          var node = {
            key: fkey,
            kind: "field",
            groupKey: "gb|" + portKey,
            portKey: portKey,
            signalId: signal.id,
            label: field.name,
            fieldPath: path,
            depth: depth,
            typeName: displayTypeName(target, field.ctype),
            typeChip: basic,
            collection: target.collection,
            badges: target.collection ? ["元素"] : (canDescend ? ["结构"] : []),
            expandable: canDescend,
            expanded: isOpen,
            checked: checked.has(portKey) || checked.has(fkey),
            indeterminate: false,
            field: field,
            // 调试时最常查的三列。0 是合法偏移/大小，不能用 truthy 判断；
            // 负数表示读取器明确知道「布局未知」（如 C# 引用类型字段），显示为 —。
            initialText: hasInitial ? String(field.initial) : "—",
            offsetText: typeof field.offset === "number" && field.offset >= 0
              ? String(field.offset) : "—",
            sizeText: typeof field.size === "number" && field.size >= 0
              ? String(field.size) : "—",
            targetTypeId: targetType === null ? null : targetType.id,
            parentPath: parentPath,
          };
          fieldRows.push(node);
          if (isOpen && canDescend) {
            walk(targetType, depth + 1, path, typeChain.concat([targetType.id]));
          }
        });
      }

      // 序号按“当前可见行”的阅读顺序从 1 重排，不沿用树的全局行号。
      fieldRows.forEach(function (row, i) { row.index = i + 1; });

      // 子字段有勾选、父字段没勾选时，父行显示部分选中。
      fieldRows.forEach(function (row) {
        if (row.checked) return;
        var prefix = row.fieldPath + "/";
        row.indeterminate = fieldRows.some(function (other) {
          return other.fieldPath.indexOf(prefix) === 0 && other.checked;
        });
      });

      // 端口行可能在分组树里出现多次，或因为折叠只留下锚定行：
      // 统一从 rowIndexByPortKey 取第一次可见位置。
      var rowIndex = rowIndexByPortKey.get(portKey);
      return {
        key: "gb|" + portKey,
        portKey: portKey,
        signalId: signal.id,
        moduleId: port.moduleId,
        dir: port.dir,
        title: signalLabel(signal),
        subtitle: moduleNameOf(ix, port.moduleId) +
          (rowIndex === undefined ? "" : " · 行 " + (rowIndex + 1)),
        typeName: type === null ? (signal.ctype || "") : displayTypeName(info, signal.ctype),
        // 类型种类决定标题上的「枚举 / 结构 / 记录」徽标，也决定枚举成员表
        // 是否需要隐藏偏移/大小列——枚举成员不是内存布局。
        typeKind: type === null ? "" : String(type.kind || ""),
        // 枚举信号的初值由读取器补成「值为 0 的成员名」，例如 Idle。
        // 显式写了 Initial 时读到的就是那个字符串，两者都在这里统一展示。
        signalInitial: typeof signal.initial === "string" ? signal.initial : "",
        typeChip: basicTypeLabel(ix, signal.ctype),
        collection: info.collection,
        rowNumber: rowIndex === undefined ? null : rowIndex + 1,
        fields: fieldRows,
        count: fieldRows.length,
      };
    }

    return groups;
  }

  // ── 数据流连线 ────────────────────────────────────────────────────────

  /**
   * 数据流配色。
   *
   * 优先级：
   *   1. 标签里显式写了颜色（`颜色:#e0a` / `color:red`），原样使用；
   *   2. 业务标签 `平面:...` 映射到固定颜色——同一个传输平面一眼可辨；
   *   3. 都没有时按信号 id 稳定散列到调色板，保证同一条信号每次重绘同色。
   *
   * 为什么按信号而不是按边：一个输出可能连多个输入，同一信号的多条流
   * 应该是同一种颜色，否则用户会以为它们是不同的数据。
   */
  var FLOW_PALETTE = ["#d18616", "#3794ff", "#89d185", "#b180d7", "#e06c9f", "#4ec9b0"];

  var PLANE_COLORS = {
    "网络": "#3794ff",
    "共享内存": "#b180d7",
    "硬线": "#d18616",
    "本机": "#89d185",
    "预留": "#9d9d9d",
  };

  function colorOfSignal(signal) {
    var tags = (signal && signal.tags) || [];
    for (var i = 0; i < tags.length; i += 1) {
      var facet = splitFacetTag(tags[i]);
      if (facet === null) continue;
      if (/^(颜色|color)$/i.test(facet.name)) {
        var value = facet.value.trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) ||
            /^[a-z]{3,20}$/i.test(value) ||
            /^(rgb|hsl)a?\(/i.test(value)) {
          return value;
        }
      }
      if (facet.name === "平面" && PLANE_COLORS[facet.value] !== undefined) {
        return PLANE_COLORS[facet.value];
      }
    }
    var id = String((signal && signal.id) || "");
    var hash = 0;
    for (var k = 0; k < id.length; k += 1) {
      hash = (hash * 31 + id.charCodeAt(k)) % 1000003;
    }
    return FLOW_PALETTE[hash % FLOW_PALETTE.length];
  }

  /**
   * 由勾选集合生成「某行 → 某行」的连线。
   *
   * 只产出边的数据，不产出几何：几何（端点在同一栏里的 y 坐标）依赖树的
   * 滚动与行高，由 graph.js 在渲染时算。这样滚动时不必重新跑语义层。
   *
   * 端点行号优先取端口自己的行；端口被折叠/过滤掉时，`rowIndexByPortKey`
   * 会给它一个**最近可见祖先行**（分组行 → 模块行 → 更上层模块行），
   * 连线照样画在那一行上——收起模块只是让线变短，而不是让数据流消失。
   * 两端都找不到可锚的行时 `drawable:false`，边仍保留，供信息面板解释。
   */
  function buildPortFlow(model, checkedIds, options) {
    options = options || {};
    var flags = options.flags || {};
    var ports = getPorts(model, flags);
    var ix = getIndex(model);
    var checked = asSet(checkedIds);
    var indexByKey = options.indexByKey || null;
    var rowIndexByPortKey = options.rowIndexByPortKey || null;
    // 端口自身行下标（分组模式专用）；缺省时退回 indexByKey。
    var portRowIndex = options.portRowIndex || null;

    var explicitPortKeys = new Set();
    var fieldPathsByPort = new Map();
    checked.forEach(function (key) {
      var pk = null;
      if (parsePortKey(key) !== null) {
        pk = key;
      } else {
        var f = parseFieldKey(key);
        if (f !== null) {
          pk = f.portKey;
          var list = fieldPathsByPort.get(pk);
          if (list === undefined) {
            list = [];
            fieldPathsByPort.set(pk, list);
          }
          list.push(f.path);
        }
      }
      if (pk !== null) explicitPortKeys.add(pk);
    });

    var selected = new Map();
    explicitPortKeys.forEach(function (key) {
      var port = ports.byKey.get(key);
      if (port === undefined) return;
      selected.set(key, { port: port, context: false });
      var same = ports.bySignal.get(port.signalId);
      if (same === undefined) return;
      var counterparts = port.dir === "out" ? same.inputs : same.outputs;
      counterparts.forEach(function (other) {
        if (!selected.has(other.key)) selected.set(other.key, { port: other, context: true });
      });
    });

    // 端口自己的行号；被折叠/过滤时回退到最近可见的祖先行。
    function ownRowIndex(portKey) {
      var index;
      if (portRowIndex !== null) {
        index = portRowIndex.get(portKey);
        return index === undefined ? null : index;
      }
      if (indexByKey === null) return null;
      index = indexByKey.get(portKey);
      return index === undefined ? null : index;
    }

    function rowIndex(portKey) {
      if (rowIndexByPortKey !== null) {
        var anchored = rowIndexByPortKey.get(portKey);
        if (anchored !== undefined) return anchored;
      }
      return ownRowIndex(portKey);
    }

    // 行是“借”来的祖先行的：信息面板据此说明“锚到父行”，
    // 别让用户以为端口自己恰好排在那。
    function isAnchored(portKey) {
      return ownRowIndex(portKey) === null && rowIndex(portKey) !== null;
    }

    var nodes = [];
    selected.forEach(function (entry, key) {
      var port = entry.port;
      var s = port.signal;
      var index = rowIndex(key);
      var anchored = isAnchored(key);
      var paths = fieldPathsByPort.get(key);
      nodes.push({
        nodeId: key,
        kind: "port",
        role: port.dir,
        portKey: key,
        entityId: port.signalId,
        moduleId: port.moduleId,
        modulePath: modulePathOf(ix, port.moduleId),
        label: signalLabel(s),
        sublabel: moduleNameOf(ix, port.moduleId) +
          (index === null ? "" : (anchored ? " · 锚到行 " : " · 行 ") + (index + 1)),
        order: index === null ? 1e9 : index,
        anchored: anchored,
        context: entry.context,
        fieldPaths: paths === undefined ? null : paths.slice(),
      });
    });

    var edgeSeen = new Set();
    var edges = [];
    selected.forEach(function (entry, key) {
      var port = entry.port;
      if (port.dir !== "out") return;
      var same = ports.bySignal.get(port.signalId);
      if (same === undefined) return;
      same.inputs.forEach(function (input) {
        if (!selected.has(input.key)) return;
        var ekey = key + ">" + input.key + "|" + port.signalId;
        if (edgeSeen.has(ekey)) return;
        edgeSeen.add(ekey);
        var fromIndex = rowIndex(key);
        var toIndex = rowIndex(input.key);
        edges.push({
          from: key,
          to: input.key,
          kind: "flow",
          signalId: port.signalId,
          label: signalLabel(port.signal),
          color: colorOfSignal(port.signal),
          fromIndex: fromIndex,
          toIndex: toIndex,
          fromRow: fromIndex === null ? null : fromIndex + 1,
          toRow: toIndex === null ? null : toIndex + 1,
          fromAnchored: isAnchored(key),
          toAnchored: isAnchored(input.key),
          drawable: fromIndex !== null && toIndex !== null,
          context: entry.context || selected.get(input.key).context,
          fieldPaths: (fieldPathsByPort.get(key) || []).slice(),
        });
      });
    });

    // ── 同信号关联线 ────────────────────────────────────────────────────
    //
    // 有些信号只有同向端口：例如两个模块都写 `g_filtered` 但没人读，
    // 或两个模块都读 `g_raw` 但程序集里没有写者。它们没有 out → in 的
    // 方向性数据流，但用户勾选同名端口时仍应看到“这两个端口引用同一个
    // 信号”的关系，否则画布只剩一句“没有对端”，很像功能坏了。
    //
    // 这里只连**显式勾选**的同向端口，且只在该信号没有任何方向性边时
    // 才补：有真实数据流时不再画关联线，避免同一条信号出现两套线。
    var explicitBySignal = new Map();
    explicitPortKeys.forEach(function (key) {
      var entry = selected.get(key);
      if (entry === undefined || entry.context) return;
      var list = explicitBySignal.get(entry.port.signalId);
      if (list === undefined) {
        list = [];
        explicitBySignal.set(entry.port.signalId, list);
      }
      list.push(entry.port);
    });

    var directionalSignals = new Set();
    edges.forEach(function (edge) { directionalSignals.add(edge.signalId); });

    var sharedCount = 0;
    explicitBySignal.forEach(function (list, signalId) {
      if (directionalSignals.has(signalId)) return;
      ["out", "in"].forEach(function (dir) {
        var group = list.filter(function (port) { return port.dir === dir; });
        if (group.length < 2) return;

        // 按当前树里的行号排，让关联线始终从上往下画；行号相同再按端口键。
        group.sort(function (a, b) {
          var ai = rowIndex(a.key);
          var bi = rowIndex(b.key);
          if (ai === null) ai = 1e9;
          if (bi === null) bi = 1e9;
          if (ai !== bi) return ai - bi;
          return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
        });

        for (var i = 1; i < group.length; i += 1) {
          var fromPort = group[i - 1];
          var toPort = group[i];
          var fromIndex = rowIndex(fromPort.key);
          var toIndex = rowIndex(toPort.key);
          var fieldPaths = (fieldPathsByPort.get(fromPort.key) || [])
            .concat(fieldPathsByPort.get(toPort.key) || []);
          edges.push({
            from: fromPort.key,
            to: toPort.key,
            kind: "same-signal",
            // 同向端口互连：out↔out 是「都在写」，in↔in 是「都在读」。
            // 界面与导出都据此把线标成「同写/同读」，避免被误读成数据流方向。
            sharedDir: dir,
            signalId: signalId,
            label: signalLabel(fromPort.signal),
            color: colorOfSignal(fromPort.signal),
            fromIndex: fromIndex,
            toIndex: toIndex,
            fromRow: fromIndex === null ? null : fromIndex + 1,
            toRow: toIndex === null ? null : toIndex + 1,
            fromAnchored: isAnchored(fromPort.key),
            toAnchored: isAnchored(toPort.key),
            drawable: fromIndex !== null && toIndex !== null && fromIndex !== toIndex,
            context: false,
            fieldPaths: Array.from(new Set(fieldPaths)),
          });
          sharedCount += 1;
        }
      });
    });

    // 边的顺序决定弧线分层；按起点行号排，同起点的按终点行号排，稳定可复现。
    edges.sort(function (a, b) {
      var af = a.fromIndex === null ? 1e9 : a.fromIndex;
      var bf = b.fromIndex === null ? 1e9 : b.fromIndex;
      if (af !== bf) return af - bf;
      var at = a.toIndex === null ? 1e9 : a.toIndex;
      var bt = b.toIndex === null ? 1e9 : b.toIndex;
      return at - bt;
    });

    return {
      nodes: nodes,
      edges: edges,
      empty: edges.length === 0,
      sharedCount: sharedCount,
      drawableCount: edges.filter(function (e) { return e.drawable; }).length,
    };
  }

  /**
   * 给一组竖直区间（连线两端 y 坐标）分配互不重叠的横向车道。
   *
   * 为什么需要：旧画法用 `18 + |Δy|*0.22` 算弯曲幅度，所有长连线都会撞到
   * 同一个上限，弯曲点落在同一条 x 上，线一多就糊成一束。这里不再按长度
   * 猜幅度，而是先做一次**区间图着色**：
   *   - 按区间上端从上到下扫；
   *   - 每条线放进第一条“已经结束（且留出 GAP）”的车道，否则新开一条；
   *   - 同一车道内的线在竖直方向不重叠，因此它们的竖直段不会互相覆盖。
   *
   * 返回与输入等长的车道号数组；渲染层再把车道号映射成不同的弯曲 x。
   * 纯函数、不碰 DOM，便于单测（也避免把几何决策散落到 graph.js）。
   */
  function assignWireLanes(intervals) {
    var GAP = 2;
    var order = [];
    (intervals || []).forEach(function (pair, index) {
      var a = Number(pair[0]);
      var b = Number(pair[1]);
      if (!isFinite(a) || !isFinite(b)) return;
      order.push({
        index: index,
        top: Math.min(a, b),
        bottom: Math.max(a, b),
      });
    });
    // 上端相同的按下端排，保证同一对行之间的多条信号也能依次分到不同车道。
    order.sort(function (a, b) {
      if (a.top !== b.top) return a.top - b.top;
      if (a.bottom !== b.bottom) return a.bottom - b.bottom;
      return a.index - b.index;
    });

    var laneEnds = [];
    var lanes = new Array((intervals || []).length);
    order.forEach(function (item) {
      var lane = 0;
      while (lane < laneEnds.length && laneEnds[lane] > item.top - GAP) lane += 1;
      if (lane === laneEnds.length) laneEnds.push(item.bottom);
      else laneEnds[lane] = item.bottom;
      lanes[item.index] = lane;
    });
    return lanes;
  }

  // ── 实体查询 ──────────────────────────────────────────────────────────

  /**
   * 任意实体 → 它能落到哪些端口行。定位、ER 反查、诊断跳转共用。
   *
   * 优先级按“读者最可能想去的那一端”排：
   *   信号 → 输出端口在前（生产端，通常是结构定义所在模块）；
   *   函数 → 它写出的信号优先走输出端口，读取的信号走输入端口；
   *   类型 → 所有使用该类型的信号端口。
   */
  function portsForEntity(model, kind, id, flags) {
    flags = flags || {};
    var ix = getIndex(model);
    var ports = getPorts(model, flags);
    var out = [];
    var seen = new Set();

    function add(list, preferDir) {
      (list || []).forEach(function (port) {
        if (preferDir !== undefined && port.dir !== preferDir) return;
        if (seen.has(port.key)) return;
        seen.add(port.key);
        out.push(port);
      });
    }
    function addAll(signalId) {
      var entry = ports.bySignal.get(signalId);
      if (entry === undefined) return;
      add(entry.outputs);
      add(entry.inputs);
    }

    if (kind === "signal") {
      addAll(id);
    } else if (kind === "func") {
      var f = ix.funcById.get(id);
      if (f !== undefined) {
        (f.writes || []).forEach(function (sid) {
          var entry = ports.bySignal.get(sid);
          if (entry !== undefined) add(entry.outputs, "out");
        });
        (f.reads || []).forEach(function (sid) {
          var entry = ports.bySignal.get(sid);
          if (entry !== undefined) add(entry.inputs, "in");
        });
        if (out.length === 0) {
          (f.writes || []).forEach(addAll);
          (f.reads || []).forEach(addAll);
        }
      }
    } else if (kind === "type") {
      (model.signals || []).forEach(function (s) {
        var t = signalType(ix, s);
        if (t !== null && t.id === id) addAll(s.id);
      });
    } else if (kind === "module") {
      var entry = ports.byModule.get(id);
      if (entry !== undefined) {
        add(entry.outputs);
        add(entry.inputs);
      }
    }
    return out;
  }

  function describePort(model, portKey, flags) {
    var ix = getIndex(model);
    var ports = getPorts(model, flags || {});
    var port = ports.byKey.get(portKey);
    if (port === undefined) return null;
    var signal = port.signal;

    function refs(ids) {
      return (ids || []).map(function (fid) {
        var f = ix.funcById.get(fid);
        return f === undefined ? null : { id: f.id, name: f.name, path: f.path || "" };
      }).filter(function (x) { return x !== null; });
    }

    var same = ports.bySignal.get(signal.id);
    return {
      port: port,
      signal: signal,
      module: port.module,
      writers: refs(ix.writersBySignal.get(signal.id)),
      readers: refs(ix.readersBySignal.get(signal.id)),
      counterparts: same === undefined
        ? []
        : (port.dir === "out" ? same.inputs : same.outputs),
      type: signalType(ix, signal),
    };
  }

  function describeSignal(model, signalId) {
    var ix = getIndex(model);
    var s = ix.signalById.get(signalId);
    if (s === undefined) return null;
    function refs(ids) {
      return (ids || []).map(function (fid) {
        var f = ix.funcById.get(fid);
        return f === undefined ? null : { id: f.id, name: f.name, path: f.path || "" };
      }).filter(function (x) { return x !== null; });
    }
    return {
      signal: s,
      writers: refs(ix.writersBySignal.get(signalId)),
      readers: refs(ix.readersBySignal.get(signalId)),
      ownerType: s.ownerType ? ix.typeById.get(s.ownerType) || null : null,
    };
  }

  function describeFunc(model, funcId) {
    var ix = getIndex(model);
    var f = ix.funcById.get(funcId);
    if (f === undefined) return null;
    function names(ids) {
      return (ids || []).map(function (id) {
        var s = ix.signalById.get(id);
        return s === undefined ? null : { id: s.id, name: s.name, alias: s.alias || "" };
      }).filter(function (x) { return x !== null; });
    }
    return { func: f, reads: names(f.reads), writes: names(f.writes) };
  }

  // ── 持久化数据 ────────────────────────────────────────────────────────

  function buildEr(model) {
    var ix = getIndex(model);
    return (model.types || [])
      .filter(function (t) { return t.store === true; })
      .sort(byName)
      .map(function (t) {
        return {
          id: t.id,
          name: t.name,
          path: t.path || "",
          size: t.size || 0,
          tags: t.tags || [],
          fields: (t.fields || []).map(function (f) {
            var target = f.typeId ? ix.typeById.get(f.typeId) : undefined;
            return {
              name: f.name,
              ctype: f.ctype,
              offset: f.offset,
              size: f.size,
              tags: f.tags || [],
              target: target
                ? { id: target.id, name: target.name, store: target.store === true }
                : null,
            };
          }),
        };
      });
  }

  /**
   * ER 字段 → 读写它的函数。
   *
   * 字段与信号不是同一个概念：字段是结构布局，信号是数据流端点。二者只有在
   * 读取器把「字段信号」也建模出来时才连得上（C# 里带 Drawcode 特性的属性/字段）。
   * 所以这里**允许返回空数组**，由调用方显示「该字段没有信号映射」，
   * 而不是拿字段名去猜一条边。
   */
  function erFieldRefs(model, typeId, fieldName) {
    var ix = getIndex(model);
    var type = ix.typeById.get(typeId);
    var suffix = "#" + fieldName;

    function refs(ids) {
      return (ids || []).map(function (fid) {
        var f = ix.funcById.get(fid);
        return f === undefined ? null : { id: f.id, name: f.name, path: f.path || "" };
      }).filter(function (x) { return x !== null; });
    }

    return (model.signals || [])
      .filter(function (s) {
        if (s.ownerType !== undefined) return s.ownerType === typeId && s.name === fieldName;
        if (type === undefined || s.path !== type.path) return false;
        return s.id.length >= suffix.length && s.id.slice(-suffix.length) === suffix;
      })
      .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; })
      .map(function (s) {
        var writers = refs(ix.writersBySignal.get(s.id));
        var readers = refs(ix.readersBySignal.get(s.id));
        var seen = new Set();
        var funcs = [];
        writers.concat(readers).forEach(function (f) {
          if (seen.has(f.id)) return;
          seen.add(f.id);
          funcs.push(f);
        });
        return { signal: s, writers: writers, readers: readers, funcs: funcs };
      });
  }

  function overview(model) {
    var severityRank = { error: 0, warning: 1, info: 2 };
    var diagnostics = (model.diagnostics || []).slice().sort(function (a, b) {
      var sa = severityRank[a.severity] === undefined ? 9 : severityRank[a.severity];
      var sb = severityRank[b.severity] === undefined ? 9 : severityRank[b.severity];
      if (sa !== sb) return sa - sb;
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      return (a.subject || "") < (b.subject || "") ? -1 : 1;
    });
    return {
      info: model.info,
      counts: {
        modules: (model.modules || []).length,
        types: (model.types || []).length,
        signals: (model.signals || []).length,
        funcs: (model.funcs || []).length,
        edges: (model.edges || []).length,
        diagnostics: diagnostics.length,
        storeTypes: (model.types || []).filter(function (t) { return t.store === true; }).length,
      },
      diagnostics: diagnostics,
    };
  }

  // ── 导出 ──────────────────────────────────────────────────────────────

  root.DCLogic = {
    ROW_HEIGHT: ROW_HEIGHT,
    MAX_FIELD_DEPTH: MAX_FIELD_DEPTH,
    ORPHAN_MODULE_ID: ORPHAN_MODULE_ID,
    GROUP_MAX_LEVELS: GROUP_MAX_LEVELS,
    GROUP_MAX_PRESETS: GROUP_MAX_PRESETS,
    GROUP_ALIAS_MAX: GROUP_ALIAS_MAX,
    GROUP_CONFIG_VERSION: GROUP_CONFIG_VERSION,
    getIndex: getIndex,
    getPorts: getPorts,
    buildCascade: buildCascade,
    buildPortFlow: buildPortFlow,
    assignWireLanes: assignWireLanes,
    treeGuides: treeGuides,
    facetGroups: facetGroups,
    splitFacetTag: splitFacetTag,
    facetOfTag: facetOfTag,
    cleanGroupLevels: cleanGroupLevels,
    sanitizeGroupingConfig: sanitizeGroupingConfig,
    findGroupPreset: findGroupPreset,
    resolveGroupLevels: resolveGroupLevels,
    basicTypeLabel: basicTypeLabel,
    displayTypeName: displayTypeName,
    colorOfSignal: colorOfSignal,
    hitSets: hitSets,
    describeSignal: describeSignal,
    describeFunc: describeFunc,
    describePort: describePort,
    portsForEntity: portsForEntity,
    moduleChain: moduleChain,
    resolveCtype: resolveCtype,
    buildEr: buildEr,
    erFieldRefs: erFieldRefs,
    overview: overview,
    portKeyOf: portKeyOf,
    parsePortKey: parsePortKey,
    fieldKeyOf: fieldKeyOf,
    parseFieldKey: parseFieldKey,
    signalLabel: signalLabel,
    portDirLabel: portDirLabel,
    dirLabel: dirLabel,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);

/**
 * 右侧第二列：勾选信号对应的 groupbox 竖向堆叠。
 *
 * 为什么不是“按深度向右加列”：
 *   上一版每点一层字段就多一列，横向空间很快耗尽，而且每个信号的字段
 *   和别的信号混在同一行网格里，读者分不清哪一列属于谁。现在每个勾选的
 *   端口拥有自己的方框，树在方框内向下展开——横向只有两列（序号 / 字段树），
 *   深度只消耗纵向空间，滑一滑就能读完。
 *
 * 编号规则：每个 groupbox 的序号从 1 重新开始，按当前可见行的阅读顺序
 * 编号（logic.buildGroups 已算好）。不沿用左侧树的全局行号，因为
 * groupbox 是独立的阅读单元。
 *
 * 列宽：序号列默认 30px，用户可拖动它与字段树之间的边界。宽度写在
 * 容器的 CSS 变量上，所有 groupbox 共享，避免每个方框宽度不一致。
 */
(function (root) {
  "use strict";

  var INDEX_MIN = 22;
  var INDEX_MAX = 80;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function GroupView(host, handlers) {
    this.host = host;
    this.handlers = handlers || {};
    this.groups = [];
    this.selectedKey = null;
    this.byGroup = new Map();
    this._drag = null;

    var self = this;
    host.addEventListener("click", function (event) {
      var close = event.target.closest("[data-action='close-group']");
      if (close !== null) {
        var box = close.closest(".groupbox");
        var group = box === null ? null : self.byGroup.get(box.getAttribute("data-group"));
        if (group !== null && group !== undefined && self.handlers.onClose) {
          self.handlers.onClose(group);
        }
        return;
      }

      var rowEl = event.target.closest(".group-row");
      if (rowEl === null) return;
      var row = self.rowByKey(rowEl.getAttribute("data-key"));
      if (row === undefined) return;
      if (event.target.closest("[data-action='expand']") !== null) {
        if (self.handlers.onExpand) self.handlers.onExpand(row);
        return;
      }
      if (event.target.closest("input") !== null) return;
      if (self.handlers.onSelect) self.handlers.onSelect(row);
    });

    host.addEventListener("change", function (event) {
      var input = event.target;
      if (input === null || input.tagName !== "INPUT" || input.type !== "checkbox") return;
      var rowEl = input.closest(".group-row");
      if (rowEl === null) return;
      var row = self.rowByKey(rowEl.getAttribute("data-key"));
      if (row === undefined) return;
      if (self.handlers.onCheck) self.handlers.onCheck(row);
    });

    // 列宽拖动：pointer events 同时覆盖鼠标/触控笔，setPointerCapture
    // 保证指针移出 4px 的细边界后仍能继续拖动。
    host.addEventListener("pointerdown", function (event) {
      var handle = event.target.closest(".group-col-resize");
      if (handle === null) return;
      event.preventDefault();
      self._drag = {
        startX: event.clientX,
        startIndex: self.indexWidth(),
      };
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (error) {
        // 老版本 Electron 可能不支持；仍可依赖容器上的 move 监听。
      }
    });
    host.addEventListener("pointermove", function (event) {
      if (self._drag === null) return;
      var next = self._drag.startIndex + (event.clientX - self._drag.startX);
      next = Math.max(INDEX_MIN, Math.min(INDEX_MAX, next));
      self.applyIndexWidth(next);
    });
    function endDrag() {
      if (self._drag === null) return;
      self._drag = null;
      if (self.handlers.onColumns) self.handlers.onColumns(self.indexWidth());
    }
    host.addEventListener("pointerup", endDrag);
    host.addEventListener("pointercancel", endDrag);
  }

  GroupView.prototype.indexWidth = function () {
    var value = parseInt(
      root.getComputedStyle(this.host).getPropertyValue("--group-index-w"),
      10,
    );
    return Number.isFinite(value) && value > 0 ? value : 30;
  };

  GroupView.prototype.applyIndexWidth = function (width) {
    this.host.style.setProperty("--group-index-w", width + "px");
  };

  GroupView.prototype.rowByKey = function (key) {
    for (var i = 0; i < this.groups.length; i += 1) {
      for (var k = 0; k < this.groups[i].fields.length; k += 1) {
        var row = this.groups[i].fields[k];
        if (row.key === key) return row;
      }
    }
    return undefined;
  };

  /** 换一份 groupbox 数据。整块重建：groupbox 数量通常个位数，成本可忽略。 */
  GroupView.prototype.setData = function (groups, options) {
    options = options || {};
    this.groups = groups || [];
    this.selectedKey = options.selectedKey || null;
    if (options.indexWidth > 0) this.applyIndexWidth(options.indexWidth);
    this.byGroup = new Map();
    // 每个 groupbox 是自己的一棵小树：辅助线按组内字段行单独算。
    this.guideByGroup = new Map();
    this.groups.forEach(function (group) {
      this.byGroup.set(group.key, group);
      this.guideByGroup.set(group.key, root.DCLogic.treeGuides(group.fields));
    }, this);
    this.render();
  };

  GroupView.prototype.setSelected = function (key) {
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    this.render();
  };

  GroupView.prototype.render = function () {
    var host = this.host;
    var fragment = document.createDocumentFragment();

    if (this.groups.length === 0) {
      var empty = el("div", "group-empty");
      empty.appendChild(el("div", "group-empty-title", "还没有勾选信号"));
      empty.appendChild(
        el("div", "group-empty-hint",
          "在左侧模块树里勾选输出/输入端口。结构体信号会在这里生成一个 groupbox，" +
          "字段树默认展开全部层级；点行首的 − 可收起，右侧列出初值、偏移与大小。"),
      );
      fragment.appendChild(empty);
      host.replaceChildren(fragment);
      return;
    }

    this.groups.forEach(function (group) {
      fragment.appendChild(this.buildGroup(group));
    }, this);
    host.replaceChildren(fragment);
  };

  // 类型种类的中文短名。只列产物读取器会产出的五种 kind；
  // 空串（类型未解析出来）时不显示徽标，避免把未知类型冒充成 class。
  var TYPE_KIND_LABELS = {
    enum: "枚举",
    struct: "结构",
    record: "记录",
    "class": "类",
    interface: "接口",
  };

  GroupView.prototype.buildGroup = function (group) {
    var box = el("section", "groupbox");
    box.setAttribute("data-group", group.key);
    box.setAttribute("data-port", group.portKey);
    // 枚举成员是「名称 = 值」，没有结构体那种字节偏移；给整框加类名，
    // 由 CSS 隐藏偏移/大小两列，值列则放宽。
    if (group.typeKind === "enum") box.classList.add("is-enum");

    var head = el("header", "groupbox-head");
    var title = el("div", "groupbox-title");
    // 类型 chip 本身已经是蓝字 + 描边，再套方括号只会让标题更吵；直接写类型名。
    if (group.typeChip) title.appendChild(el("span", "type-chip", group.typeChip));
    var kindLabel = TYPE_KIND_LABELS[group.typeKind] || "";
    if (kindLabel) title.appendChild(el("span", "kind-chip", kindLabel));
    title.appendChild(el("span", "groupbox-name", group.title));
    head.appendChild(title);

    // 标题副行：方向 · 模块/行号 · 类型名 · 枚举默认值。
    // 枚举信号的 initial 已经是成员名（如 Idle），这里明确标成「默认」，
    // 避免用户把它误解成当前运行值。
    var sub = el("div", "groupbox-sub",
      (group.dir === "out" ? "输出" : "输入") + " · " + group.subtitle +
        (group.typeName ? " · " + group.typeName : "") +
        (group.signalInitial ? " · 默认 " + group.signalInitial : ""));
    head.appendChild(sub);

    var close = el("button", "groupbox-close", "×");
    close.type = "button";
    close.setAttribute("data-action", "close-group");
    close.title = "取消勾选该端口并关闭此 groupbox";
    head.appendChild(close);
    box.appendChild(head);

    // 列头兼拖拽把手：序号列与字段树之间可调宽。
    // 枚举把同一张表当「定义表」用：字段列是成员名，初值列是枚举值；
    // 偏移/大小对枚举没有意义，下面用 CSS 隐藏。
    var isEnum = group.typeKind === "enum";
    var cols = el("div", "groupbox-cols");
    cols.appendChild(el("span", "group-col-index", "序号"));
    cols.appendChild(el("span", "group-col-name", isEnum ? "成员" : "字段"));
    var initialCol = el("span", "group-col-meta group-col-initial", isEnum ? "值" : "初值");
    initialCol.title = isEnum ? "枚举成员的常量值" : "声明时登记的初始值";
    cols.appendChild(initialCol);
    var offsetCol = el("span", "group-col-meta group-col-offset", "偏移");
    offsetCol.title = "字段相对所在类型的字节偏移";
    cols.appendChild(offsetCol);
    var sizeCol = el("span", "group-col-meta group-col-size", "大小");
    sizeCol.title = "字段占用的字节数";
    cols.appendChild(sizeCol);
    var handle = el("span", "group-col-resize");
    handle.title = "拖动调整序号列宽度";
    cols.appendChild(handle);
    box.appendChild(cols);

    var body = el("div", "groupbox-body");
    if (group.fields.length === 0) {
      body.appendChild(el("div", "group-empty-row", "该类型没有可展开字段。"));
    } else {
      group.fields.forEach(function (row) {
        body.appendChild(this.buildRow(row, group));
      }, this);
    }
    box.appendChild(body);
    return box;
  };

  GroupView.prototype.buildRow = function (row, group) {
    var node = el("div", "group-row");
    node.setAttribute("data-key", row.key);
    if (row.key === this.selectedKey) node.classList.add("is-selected");
    if (row.checked) node.classList.add("is-checked");

    node.appendChild(el("span", "group-index", String(row.index)));

    var nameCell = el("span", "group-name");
    // 与左侧树同一套经典缩进：虚线辅助线 + 实线 +/− 框。
    var indent = el("span", "group-indent");
    var guides = this.guideByGroup.get(group.key) || [];
    var guide = guides[row.index - 1] || { guides: [], last: true };
    for (var level = 0; level < row.depth; level += 1) {
      var cell = el("span", "tree-guide");
      if (level === row.depth - 1) {
        cell.classList.add("tree-elbow");
        if (guide.last) cell.classList.add("is-last");
      } else if (guide.guides[level] !== true) {
        cell.classList.add("is-blank");
      }
      indent.appendChild(cell);
    }
    nameCell.appendChild(indent);

    var caret = el("span", "group-caret");
    if (row.expandable) {
      caret.classList.add("is-open");
      caret.textContent = row.expanded ? "−" : "+";
      caret.setAttribute("data-action", "expand");
      caret.title = row.expanded ? "收起" : "展开";
    } else {
      caret.classList.add("is-leaf");
      caret.textContent = "·";
    }
    nameCell.appendChild(caret);

    var check = document.createElement("input");
    check.type = "checkbox";
    check.className = "group-check";
    check.checked = row.checked === true;
    check.indeterminate = row.indeterminate === true;
    check.title = row.checked ? "取消勾选该字段" : "勾选该字段并画入左侧数据流";
    nameCell.appendChild(check);

    // 蓝色 chip 已经能表达“这是类型”，去掉方括号，字段名更靠左、更清爽。
    if (row.typeChip) nameCell.appendChild(el("span", "type-chip", row.typeChip));
    nameCell.appendChild(el("span", "group-label", row.label));

    (row.badges || []).forEach(function (badge) {
      nameCell.appendChild(el("span", "cascade-badge neutral", badge));
    });

    node.appendChild(nameCell);

    // 三列与表头共用宽度变量，保证每个 groupbox 的列都对齐。
    node.appendChild(el("span", "group-cell-meta group-cell-initial", row.initialText || "—"));
    node.appendChild(el("span", "group-cell-meta group-cell-offset", row.offsetText || "—"));
    node.appendChild(el("span", "group-cell-meta group-cell-size", row.sizeText || "—"));

    node.title = row.fieldPath + (row.typeName ? "  ·  " + row.typeName : "");
    return node;
  };

  /**
   * 把某个端口对应的 groupbox 滚进视野并闪一下。
   * 左侧树里“再次点击信号条目”时调用，满足“右侧定位跳转”。
   */
  GroupView.prototype.reveal = function (portKey) {
    var boxes = this.host.querySelectorAll(".groupbox");
    for (var i = 0; i < boxes.length; i += 1) {
      if (boxes[i].getAttribute("data-port") !== portKey) continue;
      var box = boxes[i];
      if (typeof box.scrollIntoView === "function") {
        box.scrollIntoView({ block: "nearest" });
      }
      box.classList.remove("is-flash");
      // 强制重排后再加类，连续点击同一个 groupbox 也会重新播放动画。
      void box.offsetWidth;
      box.classList.add("is-flash");
      return true;
    }
    return false;
  };

  root.GroupView = GroupView;
})(typeof globalThis !== "undefined" ? globalThis : this);

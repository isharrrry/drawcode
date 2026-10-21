/**
 * 模块树视图（右侧第一列）。
 *
 * 这一版只画**一棵树**：模块 → 输出/输入信号分组 → 端口行。
 * 字段不再按深度向右加列，而是进入每个勾选端口自己的 groupbox（见 groups.js）。
 *
 * 三条刻意保留的性质：
 *   1. 行号是唯一的纵坐标：左侧连线直接按 `index * ROW_H` 找端点，
 *      所以行号必须和树一起滚动，不能固定在表头里。
 *   2. 树指示符是经典样式：+/- 放在**实线**小方框里，祖先列与子节点之间
 *      用**虚线**辅助线相连（├/└）。上一版的实心三角与虚线框在深色主题下
 *      层级感不足，用户点名要“经典的树”。辅助线的几何由 logic.treeGuides
 *      统一算，左侧树与右侧 groupbox 共用，两处样式不会走样。
 *   3. 端口行上的 `[int]` 是**基本类型**才有的；结构体不放类型名，
 *      避免把长路径挤进树里——结构信息在 groupbox 与下方信息区。
 *
 * 本文件只认识 `logic.buildCascade` 产出的行对象，不读模型、不做语义判断。
 */
(function (root) {
  "use strict";

  /** 与 logic.js 的 ROW_HEIGHT、style.css 的 --cascade-row-height 三处一致。 */
  var ROW_H = 22;

  /** 表头高度：sticky 元素占普通文档流，body 从它下面开始。 */
  var HEADER_H = 30;

  /** 视口上下各多渲染几行，快速滚动时不至于看到空白闪一下。 */
  var OVERSCAN = 12;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function CascadeView(host, handlers) {
    this.host = host;
    this.handlers = handlers || {};
    this.data = null;
    this.selectedKey = null;
    this.rowMap = new Map();
    this.canvas = null;
    this.body = null;
    this._raf = 0;
    this._layoutRaf = 0;

    var self = this;
    this._onScroll = function () {
      if (self._raf !== 0) return;
      // 滚动事件一帧可能来几十次；合并到下一帧只重绘一次。
      self._raf = root.requestAnimationFrame(function () {
        self._raf = 0;
        self.renderRows();
        // 连线画在左侧栏，端点 y 依赖这里的 scrollTop。
        if (self.handlers.onScroll) self.handlers.onScroll();
      });
    };
    host.addEventListener("scroll", this._onScroll, { passive: true });

    root.addEventListener("resize", function () {
      self.relayout();
    });

    host.addEventListener("click", function (event) {
      var rowEl = event.target.closest(".cascade-row");
      if (rowEl === null) return;
      var row = self.rowMap.get(rowEl.getAttribute("data-key"));
      if (row === undefined) return;
      if (event.target.closest("[data-action='expand']") !== null) {
        if (self.handlers.onExpand) self.handlers.onExpand(row);
        return;
      }
      // 复选框的点击由 change 处理；这里直接返回，避免“选中行”和“勾选”同时发生。
      if (event.target.closest("input") !== null) return;
      if (self.handlers.onSelect) self.handlers.onSelect(row);
    });

    host.addEventListener("change", function (event) {
      var input = event.target;
      if (input === null || input.tagName !== "INPUT" || input.type !== "checkbox") return;
      var rowEl = input.closest(".cascade-row");
      if (rowEl === null) return;
      var row = self.rowMap.get(rowEl.getAttribute("data-key"));
      if (row === undefined) return;
      // 不读 input.checked：端口整选会拆成字段选择，真实状态由 main.js 重算。
      if (self.handlers.onCheck) self.handlers.onCheck(row);
    });

    host.addEventListener("dblclick", function (event) {
      var rowEl = event.target.closest(".cascade-row");
      if (rowEl === null) return;
      if (event.target.closest("input") !== null) return;
      var row = self.rowMap.get(rowEl.getAttribute("data-key"));
      if (row === undefined || !row.expandable) return;
      if (self.handlers.onExpand) self.handlers.onExpand(row);
    });
  }

  /** 换一份树数据。整表重建，但行仍然按视口懒创建。 */
  CascadeView.prototype.setData = function (data, options) {
    options = options || {};
    this.data = data;
    this.selectedKey = options.selectedKey || null;
    this.rowMap = new Map();
    data.rows.forEach(function (row) {
      if (!this.rowMap.has(row.key)) this.rowMap.set(row.key, row);
    }, this);
    // 辅助线是纯几何信息：与行一一对应，渲染时按 key 取。
    // 只在换数据时算一次，滚动/虚拟化重绘不必重算。
    this.guideByKey = new Map();
    var guides = root.DCLogic.treeGuides(data.rows);
    data.rows.forEach(function (row, i) {
      this.guideByKey.set(row.key, guides[i]);
    }, this);
    this.layout();
    this.renderRows();
  };

  CascadeView.prototype.setSelected = function (key) {
    if (this.selectedKey === key) return;
    this.selectedKey = key;
    this.renderRows();
  };

  /**
   * 重建容器与表头。
   *
   * 表头是 sticky 的普通流元素：它在滚动容器顶部占 30px，body 紧接其后，
   * 所以“第 0 行”初始一定在表头下方，而不是被表头盖住。
   */
  CascadeView.prototype.layout = function () {
    var data = this.data;
    if (this.canvas !== null) this.canvas.remove();

    var bodyHeight = data.height * ROW_H;
    var canvas = el("div", "cascade-canvas");
    canvas.style.height = (HEADER_H + bodyHeight) + "px";

    var head = el("div", "cascade-head");
    head.style.height = HEADER_H + "px";
    var title = el("span", "cascade-head-title", "模块 / 信号端口");
    head.appendChild(title);
    head.appendChild(el("span", "cascade-head-count", String(data.portCount)));

    var body = el("div", "cascade-body");
    body.style.height = bodyHeight + "px";

    canvas.appendChild(head);
    canvas.appendChild(body);
    this.host.appendChild(canvas);
    this.canvas = canvas;
    this.body = body;
    this.renderRows();
  };

  /**
   * 尺寸变化后重排：先记住滚动位置，重建完再恢复。
   * 连续调用（拖分隔条）用 rAF 合并成一帧一次。
   */
  CascadeView.prototype.relayout = function () {
    if (this.data === null || this._layoutRaf !== 0) return;
    var self = this;
    var top = this.host.scrollTop;
    this._layoutRaf = root.requestAnimationFrame(function () {
      self._layoutRaf = 0;
      if (self.data === null) return;
      self.layout();
      self.host.scrollTop = top;
      self.renderRows();
      if (self.handlers.onScroll) self.handlers.onScroll();
    });
  };

  /** 只渲染视口内的行。 */
  CascadeView.prototype.renderRows = function () {
    var data = this.data;
    if (data === null || this.body === null) return;
    var host = this.host;
    var scrollTop = host.scrollTop;
    var top = Math.max(0, scrollTop - HEADER_H);
    var start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    var end = Math.ceil((top + host.clientHeight) / ROW_H) + OVERSCAN;

    var fragment = document.createDocumentFragment();
    for (var i = 0; i < data.rows.length; i += 1) {
      var row = data.rows[i];
      if (row.index < start) continue;
      if (row.index >= end) break; // rows 已按 index 升序
      fragment.appendChild(this.buildRow(row));
    }
    this.body.replaceChildren(fragment);
  };

  CascadeView.prototype.buildRow = function (row) {
    var node = el("div", "cascade-row cascade-row-" + row.kind);
    node.style.top = (row.index * ROW_H) + "px";
    node.setAttribute("data-key", row.key);
    if (row.kind === "bucket") {
      // 分组桶不是模块：它只是“某一层的某个属性值”。未标注桶用弱化样式，
      // 提醒读者这里不是真实标签值，而是“该层没有任何值”的兜底。
      node.classList.add("is-bucket");
      if (row.value === "") node.classList.add("is-unlabeled");
      node.title = "第 " + (row.levelIndex + 1) + " 层 · " + row.level + "：" + row.label +
        (row.meta ? "  " + row.meta : "");
    } else {
      node.title = row.label + (row.meta ? "  " + row.meta : "");
    }
    if (row.dir === "out") node.classList.add("dir-out");
    if (row.dir === "in") node.classList.add("dir-in");
    if (row.key === this.selectedKey) node.classList.add("is-selected");

    // 行号槽：左侧连线的端点就在它的左边缘。
    node.appendChild(el("span", "cascade-index", String(row.index + 1)));

    // 经典树缩进：每一层祖先占一格，格子里画虚线竖线；最后一格是拐角，
    // 竖线画到中线后横向连到本行的 +/− 框。
    var indent = el("span", "cascade-indent");
    var guide = this.guideByKey.get(row.key) || { guides: [], last: true };
    for (var level = 0; level < row.depth; level += 1) {
      var cell = el("span", "tree-guide");
      if (level === row.depth - 1) {
        cell.classList.add("tree-elbow");
        if (guide.last) cell.classList.add("is-last");
      } else if (guide.guides[level] !== true) {
        // 该层祖先后面没有兄弟：这一列到此为止，不画线。
        cell.classList.add("is-blank");
      }
      indent.appendChild(cell);
    }
    node.appendChild(indent);

    var caret = el("span", "cascade-caret");
    if (row.expandable) {
      // 实线小方框 + 符号：用户点名要的“经典树”样式；
      // 层级关系交给左边的虚线辅助线表达。
      caret.classList.add("is-open");
      caret.textContent = row.expanded ? "−" : "+";
      caret.setAttribute("data-action", "expand");
      caret.title = row.expanded ? "收起" : "展开";
    } else {
      caret.classList.add("is-leaf");
      caret.textContent = "·";
    }
    node.appendChild(caret);

    if (row.checkable) {
      var check = document.createElement("input");
      check.type = "checkbox";
      check.className = "cascade-check";
      check.checked = row.checked === true;
      // indeterminate 只能通过属性设置，写成 HTML attribute 不生效。
      check.indeterminate = row.indeterminate === true;
      check.title = row.checked ? "取消勾选" : "勾选并加入左侧数据流与右侧 groupbox";
      node.appendChild(check);
    } else {
      node.appendChild(el("span", "cascade-check-placeholder"));
    }

    (row.badges || []).forEach(function (badge) {
      var cls = "cascade-badge";
      if (badge === "出" || badge === "入") cls += " neutral";
      else if (badge === "输出") cls += " out";
      else if (badge === "输入") cls += " in";
      else cls += " neutral";
      node.appendChild(el("span", cls, badge));
    });
    // 方向标记只加在端口行：分组行本身就叫“输出信号/输入信号”。
    // 方向是推断出来的（无元数据符号表）时不能冒充「输出」。
    if (row.kind === "port" && row.inferredDir) {
      node.appendChild(el("span", "cascade-badge neutral", "方向未知"));
    } else if (row.kind === "port" && row.dir === "out") {
      node.appendChild(el("span", "cascade-badge out", "输出"));
    } else if (row.kind === "port" && row.dir === "in") {
      node.appendChild(el("span", "cascade-badge in", "输入"));
    }

    // `[int]` 放在名字前：用户扫一眼就知道这一行不用再展开。
    if (row.typeChip) {
      node.appendChild(el("span", "type-chip", "[" + row.typeChip + "]"));
    }

    node.appendChild(el("span", "cascade-label", row.label));
    if (row.meta) node.appendChild(el("span", "cascade-meta", row.meta));
    return node;
  };

  /**
   * 把某一行滚到视口中间。
   * 返回 false 表示这一行当前不存在（例如被过滤掉、或模块已折叠）。
   */
  CascadeView.prototype.scrollToKey = function (key) {
    var row = this.rowMap.get(key);
    if (row === undefined) return false;
    var host = this.host;
    var rowTop = HEADER_H + row.index * ROW_H;
    var visibleTop = host.scrollTop + HEADER_H;
    var visibleBottom = host.scrollTop + host.clientHeight;
    if (rowTop < visibleTop || rowTop + ROW_H > visibleBottom) {
      host.scrollTop = Math.max(0, rowTop - HEADER_H - (host.clientHeight - HEADER_H) / 2);
      this.renderRows();
    }
    return true;
  };

  /** 某一行在树视口里的 y 坐标（供左侧连线使用）。 */
  CascadeView.prototype.rowY = function (index) {
    return HEADER_H + index * ROW_H - this.host.scrollTop;
  };

  root.CascadeView = CascadeView;
})(typeof globalThis !== "undefined" ? globalThis : this);

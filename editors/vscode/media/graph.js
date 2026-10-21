/**
 * 左侧连线栏：把「第 16 行」接向「第 72 行」。
 *
 * 为什么不再画矩形节点：模块树里每一行已经有行号，矩形节点只是把行号
 * 又抄了一遍，还把真正的信息（哪一行流到哪一行）挤到画布中央。现在
 * 连线直接锚在行号左侧的边界上——从起点行弯出去、再弯回终点行，
 * 读者顺着树往下扫就能对上号。
 *
 * 坐标系：
 *   - x 固定贴在本栏右缘（`width - EDGE_INSET`），因为行号就在右边栏里；
 *   - y = originY + headerH + index * rowH + rowH/2。`originY` 由 main.js
 *     量出来（树容器与本容器的顶差），这样两边即使顶部工具条高度不同也能对齐；
 *   - 滚动不重建 DOM：整层 `<g>` 用 `translateY(-scrollTop)` 平移，
 *     与模块树逐像素同步，流动动画也不会因为重建而跳帧。
 *
 * 一条边的三件东西：
 *   1. 半透明底线：让交叉的线仍有“实体感”，不靠颜色也看得见；
 *   2. 流动虚线：颜色来自信号标签（`颜色:` / `平面:`）或稳定散列，
 *      `stroke-dashoffset` 动画方向就是数据流方向；
 *   3. 终点箭头 + 两端小圆点：箭头指明“流到哪一行”，圆点标出起止行。
 */
(function (root) {
  "use strict";

  var NS = "http://www.w3.org/2000/svg";

  /** 连线贴右缘留出的空隙：箭头还要再向右探出 3px。 */
  var EDGE_INSET = 8;

  function svg(tag, attrs) {
    var node = document.createElementNS(NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        node.setAttribute(key, String(attrs[key]));
      });
    }
    return node;
  }

  function Graph(host, handlers) {
    this.host = host;
    this.handlers = handlers || {};
    this.edges = [];
    this.options = {};
    this.selectedKey = null;
    this.root = null;
    this.layer = null;
    this.paths = new Map();
    this._scrollTop = 0;
    this._width = 0;

    var self = this;
    // 空白点击：路径与箭头都会 stopPropagation，所以这里只会收到真正的空白。
    host.addEventListener("click", function () {
      if (self.handlers.onBlank) self.handlers.onBlank();
    });

    // 面板宽度变化（拖分隔条、窗口缩放）时端点 x 要跟着变，必须重建。
    // ResizeObserver 比 window.resize 可靠：分栏拖动不触发 window.resize。
    if (typeof root.ResizeObserver === "function") {
      this._observer = new root.ResizeObserver(function () {
        if (self.host.clientWidth !== self._width) self.render(self.edges, self.options);
      });
      this._observer.observe(host);
    }
    this._width = host.clientWidth;
  }

  /** 边键与 logic.js 里的信息面板对齐；同一条边重绘后仍能保持选中。 */
  Graph.prototype.edgeKey = function (edge) {
    return edge.from + ">" + edge.to + "|" + edge.signalId;
  };

  /**
   * 重画所有连线。
   *
   * `edges` 只包含 `drawable === true` 的边（两端都在当前树里）。不可画的边
   * 由信息面板解释，不在画布上留“断头线”。
   */
  Graph.prototype.render = function (edges, options) {
    var host = this.host;
    var opts = options || {};
    this.edges = edges || [];
    this.options = opts;
    this.selectedKey = opts.selectedEdge || null;
    this._width = host.clientWidth;

    while (host.firstChild) host.removeChild(host.firstChild);
    this.paths = new Map();

    var width = Math.max(1, host.clientWidth);
    var height = Math.max(1, host.clientHeight);
    var rootSvg = svg("svg", {
      class: "wire-canvas",
      width: width,
      height: height,
      viewBox: "0 0 " + width + " " + height,
    });
    var layer = svg("g", { class: "wire-layer" });
    rootSvg.appendChild(layer);

    var originY = typeof opts.originY === "number" ? opts.originY : 0;
    var headerH = typeof opts.headerH === "number" ? opts.headerH : 0;
    var rowH = typeof opts.rowH === "number" ? opts.rowH : 22;
    var x0 = Math.max(12, width - EDGE_INSET);

    // 同一对 (起点行, 终点行) 的多条信号如果画同一条曲线会完全重叠；
    // 不同行对的长连线也会因为弯曲幅度同时撞上限，落在同一条 x 上。
    // 先按竖直区间分车道，再让每条车道有自己的弯曲 x：线越多，弯点越往左
    // 依次排开，而不是全部挤在同一个位置。
    var drawable = [];
    this.edges.forEach(function (edge) {
      if (edge.fromIndex === null || edge.toIndex === null) return;
      drawable.push({
        edge: edge,
        y1: originY + headerH + edge.fromIndex * rowH + rowH / 2,
        y2: originY + headerH + edge.toIndex * rowH + rowH / 2,
      });
    });
    var laneFn = root.DCLogic && root.DCLogic.assignWireLanes;
    var lanes = laneFn === undefined
      ? drawable.map(function () { return 0; })
      : laneFn(drawable.map(function (item) { return [item.y1, item.y2]; }));
    var maxLane = 0;
    lanes.forEach(function (lane) { if (lane > maxLane) maxLane = lane; });

    // 左边栏宽度有限：车道间距随最大车道数收缩，但至少留 1.5px，
    // 保证相邻车道的弯点 x 仍然不同（宁可密一点，也不要重新叠在一起）。
    var BASE_BULGE = 18;
    var maxBulge = Math.max(24, x0 - 16);
    var laneGap = maxLane > 0
      ? Math.max(1.5, Math.min(14, (maxBulge - BASE_BULGE) / maxLane))
      : 0;

    var self = this;
    drawable.forEach(function (item, laneIndex) {
      var edge = item.edge;
      var y1 = item.y1;
      var y2 = item.y2;
      var color = edge.color || "var(--vscode-charts-green, #89d185)";
      // 跨度大的线略多弯一点，让短线和长线的弧度有层次；车道偏移才是
      // 防止重叠的主手段。
      var spanBoost = Math.min(20, Math.abs(y2 - y1) * 0.05);
      var bulge = Math.min(maxBulge, BASE_BULGE + lanes[laneIndex] * laneGap + spanBoost);
      var d = "M " + x0 + " " + y1 +
        " C " + (x0 - bulge) + " " + y1 + ", " +
        (x0 - bulge) + " " + y2 + ", " + x0 + " " + y2;

      var key = self.edgeKey(edge);
      // 同信号关联线没有方向：两端都没有箭头，用更短的点线区分。
      // 它只表示“这两个端口引用同一个信号”，不冒充数据流。
      var shared = edge.kind === "same-signal";
      var group = svg("g", {
        class: "wire" + (shared ? " is-shared" : "") + (key === self.selectedKey ? " is-selected" : ""),
        "data-edge": key,
        opacity: shared ? 0.72 : 1,
      });

      // 底线：低不透明度实线。颜色相撞时，靠它仍能看出“这里有线”。
      group.appendChild(svg("path", {
        d: d,
        class: "wire-base",
        stroke: color,
        "stroke-width": shared ? 1.2 : 1.6,
      }));

      var flow = svg("path", {
        d: d,
        class: "wire-flow",
        stroke: color,
        "stroke-width": shared ? 1.4 : 2,
        "stroke-dasharray": shared ? "2 5" : "6 6",
      });
      var tip = svg("title");
      // 同向端口互连不是数据流：out↔out 表示两边都在写，in↔in 表示两边都在读。
      // 说「同信号」太抽象，用户会以为线画错了方向。
      var sharedLabel = edge.sharedDir === "in" ? "同读" : "同写";
      tip.textContent = shared
        ? sharedLabel + " · 行 " + (edge.fromRow === null ? "?" : edge.fromRow) +
          " ↔ 行 " + (edge.toRow === null ? "?" : edge.toRow) +
          " · " + (edge.label || edge.signalId) +
          "（同向端口，无方向性数据流）"
        : "行 " + (edge.fromRow === null ? "?" : edge.fromRow) +
          " → 行 " + (edge.toRow === null ? "?" : edge.toRow) +
          " · " + (edge.label || edge.signalId) +
          (edge.context ? "（对端未显式勾选）" : "");
      flow.appendChild(tip);
      flow.addEventListener("click", function (event) {
        event.stopPropagation();
        if (self.handlers.onEdge) self.handlers.onEdge(edge, key);
      });
      group.appendChild(flow);

      if (!shared) {
        // 箭头指向终点行。路径终点在 x0，箭头再向右探 3px，正好指向行号。
        group.appendChild(svg("path", {
          d: "M " + (x0 - 5) + " " + (y2 - 4) + " L " + (x0 + 3) + " " + y2 +
            " L " + (x0 - 5) + " " + (y2 + 4) + " Z",
          class: "wire-arrow",
          fill: color,
        }));
      }

      // 起点圆点画成空心：方向从“空心”流向“实心箭头”，无需标签也读得懂。
      // 同信号线没有起终点之分，两端都保持空心。
      group.appendChild(svg("circle", {
        cx: x0, cy: y1, r: 2.6,
        class: "wire-dot",
        stroke: color,
      }));
      group.appendChild(svg("circle", {
        cx: x0, cy: y2, r: 2.6,
        class: "wire-dot" + (shared ? "" : " is-end"),
        fill: shared ? "none" : color,
        stroke: color,
      }));

      layer.appendChild(group);
      self.paths.set(key, group);
    });

    host.appendChild(rootSvg);
    this.root = rootSvg;
    this.layer = layer;
    this.setScroll(this._scrollTop);
  };

  /** 与模块树同步滚动：只平移整层，不重建元素。 */
  Graph.prototype.setScroll = function (scrollTop) {
    this._scrollTop = scrollTop;
    if (this.layer !== null) {
      this.layer.setAttribute("transform", "translate(0 " + (-scrollTop) + ")");
    }
  };

  /** 选中态可以在不重建的前提下切换（滚动时不会打断流动动画）。 */
  Graph.prototype.setSelected = function (key) {
    if (this.selectedKey === key) return;
    var previous = this.paths.get(this.selectedKey);
    if (previous !== undefined) previous.classList.remove("is-selected");
    this.selectedKey = key;
    var next = this.paths.get(key);
    if (next !== undefined) next.classList.add("is-selected");
  };

  root.Graph = Graph;
})(globalThis);

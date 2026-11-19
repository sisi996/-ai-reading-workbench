/* ==========================================================
 *  annotate.js — 文本划选 + 标注工具
 *
 *  浮层（借鉴微信读书）——一行三组，全部常驻显示，点一下就是加、再点就是取消：
 *      ⎘ 复制 │ 💭 想法 │ ⌫ 取消标注  ║  🖍 高亮 │ U 实线 │ U 双线 │ U 点线 │ U 波浪  ║  ● ● ● ● ●
 *
 *  ⭐ 标注是「精确到选区」的：
 *      只选中一段已标文字的一部分 → 只有那部分被取消 / 换色，其余原样保留。
 *      做法（carve 算法，不用 extractContents，避免整段被重包）：
 *        1) splitRangeByBlocks  跨块选区按 <p> 拆成若干段，保住段落结构；
 *        2) 逐文本节点 splitText 切出 [起点, 终点)；
 *        3) carveOut            只把这一段外层的 <mark>/<u> 拆开剥掉（其余留着）；
 *        4) 按需 wrapNode 包一层新标注；
 *        5) tidyUp              把切碎的相邻同款标注再合并回去。
 *
 *  ⭐ 所有操作都基于浮层缓存下来的 Range，不依赖 window.getSelection()。
 *      点击浮层时浏览器有可能清掉选区，若这里再去读实时选区就会「点了没反应」。
 *
 *  标注约定：
 *    高亮   → <mark class="hl-yellow|hl-green|hl-blue|hl-pink|hl-purple">
 *    下划线 → <u class="ul-solid|ul-double|ul-dotted|ul-wavy">
 * ========================================================== */
(function (global) {

  /* ---------- 可选样式表 ---------- */
  const HIGHLIGHTS = [
    { cls: "hl-yellow", color: "#ffe266", label: "黄色" },
    { cls: "hl-green",  color: "#b3e6c4", label: "绿色" },
    { cls: "hl-blue",   color: "#b6d9f5", label: "蓝色" },
    { cls: "hl-pink",   color: "#ffc6d3", label: "粉色" },
    { cls: "hl-purple", color: "#dcc9f7", label: "紫色" }
  ];
  const UNDERLINES = [
    { cls: "ul-solid",  label: "实线" },
    { cls: "ul-double", label: "双线" },
    { cls: "ul-dotted", label: "点线" },
    { cls: "ul-wavy",   label: "波浪" }
  ];

  const HL_TAG = "mark";
  const UL_TAG = "u";

  /* ---------- 工具 ---------- */
  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === 3 ? node.parentNode : node;
  }

  /** 找到离节点最近的、可标注的根容器 */
  function annotatableRootOf(node) {
    let n = elementOf(node);
    while (n && n !== document.body) {
      if (n.nodeType === 1 && n.matches && n.matches(".annotatable,[contenteditable='true']")) return n;
      n = n.parentNode;
    }
    return document.body;
  }

  /** 把元素拆掉、只留内容 */
  function unwrapEl(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  /** 选区与哪些同类标签相交（只在 root 范围内找） */
  function intersectingTags(range, tagName, root) {
    const host = root || annotatableRootOf(range.commonAncestorContainer);
    const out = [];
    if (!host || !host.querySelectorAll) return out;
    Array.prototype.forEach.call(host.querySelectorAll(tagName), (el) => {
      try { if (range.intersectsNode(el)) out.push(el); } catch (e) {}
    });
    return out;
  }

  /* =========================================================
   *  核心：精确应用 / 取消标注
   * ========================================================= */

  /** 最近的块级祖先（用于把跨块选区切成一段一段） */
  function blockAncestorOf(node, root) {
    let n = elementOf(node);
    while (n && n !== root) {
      let d = "";
      try { d = getComputedStyle(n).display; } catch (e) {}
      if (d === "block" || d === "list-item" || d === "flex" || d === "grid" || d === "table") return n;
      n = n.parentNode;
    }
    return root;
  }

  /**
   * 把选区按「块」拆成若干子 Range。
   * 笔记编辑器的内容是一段一个 <p>，跨块选区很常见；
   * 直接 extractContents 会把 <p> 包进 <mark>，破坏排版，所以先切块再逐段处理。
   */
  function splitRangeByBlocks(range) {
    const common = range.commonAncestorContainer;
    const startEl = elementOf(common) || document.body;
    const scanRoot = startEl.nodeType === 1 ? startEl : startEl.parentNode || document.body;

    const nodes = [];
    const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT, null);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue || !n.nodeValue.trim()) continue;
      const el = elementOf(n);
      /* 想法块内部不参与标注（它是一个独立的小卡片） */
      if (el && el.closest && el.closest(".ti-thought,[data-thought]")) continue;
      try { if (!range.intersectsNode(n)) continue; } catch (e) { continue; }
      nodes.push(n);
    }
    if (!nodes.length) return [];

    const groups = [];
    let cur = null;
    nodes.forEach((tn) => {
      const blk = blockAncestorOf(tn, scanRoot);
      if (!cur || cur.blk !== blk) { cur = { blk, nodes: [] }; groups.push(cur); }
      cur.nodes.push(tn);
    });

    return groups.map((g) => {
      const first = g.nodes[0];
      const last = g.nodes[g.nodes.length - 1];
      const r = document.createRange();
      const s = first === range.startContainer ? range.startOffset : 0;
      const e = last === range.endContainer ? range.endOffset : last.nodeValue.length;
      r.setStart(first, Math.min(s, first.nodeValue.length));
      r.setEnd(last, Math.min(e, last.nodeValue.length));
      return r;
    }).filter((r) => !r.collapsed && r.toString().trim());
  }

  /**
   * 在 range 上添加或取消一类标注，**只影响选区覆盖到的那部分**。
   * 自动处理跨块选区（逐块精确处理，不会破坏段落结构）。
   * @param {Range}  range
   * @param {string} tagName  'mark' | 'u'
   * @param {string} cls      目标 class（mode='remove' 时忽略）
   * @param {string} mode     'add' | 'remove'
   * @returns {Range|null}    操作后的新选区（失败返回 null）
   */
  function applyMark(range, tagName, cls, mode) {
    if (!range || range.collapsed) return null;
    const segs = splitRangeByBlocks(range);
    if (!segs.length) return null;

    const out = [];
    segs.forEach((r) => {
      const nr = applySeg(r, tagName, cls, mode);
      if (nr) out.push(nr);
    });
    if (!out.length) return null;

    let result = out[0];
    if (out.length > 1) {
      /* 多段 → 合并成一个跨段 Range 返回 */
      const merged = document.createRange();
      try {
        merged.setStart(out[0].startContainer, out[0].startOffset);
        const lastR = out[out.length - 1];
        merged.setEnd(lastR.endContainer, lastR.endOffset);
        result = merged;
      } catch (e) { /* 用第一段兜底 */ }
    }

    /* 重设选区到处理过的内容上，便于连续操作 */
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      try { sel.addRange(result); } catch (e) {}
    }
    return result;
  }

  /**
   * 把一个文本节点上同类标注的外壳逐层切掉，只留它自己（变成裸文本）。
   * 例：<mark>ABCD</mark> 里把 "BC" 切出来 → <mark>A</mark>BC<mark>D</mark>
   */
  function carveOut(textNode, tagName) {
    const UP = tagName.toUpperCase();
    let cursor = textNode;
    let guard = 0;
    while (guard++ < 30) {
      const el = cursor.parentNode;
      if (!el || el.nodeType !== 1 || el === document.body) break;
      if (el.tagName === UP) {
        /* 左半：cursor 之前的兄弟 */
        const before = el.cloneNode(false);
        let c = el.firstChild;
        while (c && c !== cursor) { const nxt = c.nextSibling; before.appendChild(c); c = nxt; }
        if (before.firstChild) el.parentNode.insertBefore(before, el);

        /* 右半：cursor 之后的兄弟 */
        const after = el.cloneNode(false);
        c = el.lastChild;
        while (c && c !== cursor) { const prv = c.previousSibling; after.insertBefore(c, after.firstChild); c = prv; }
        if (after.firstChild) el.parentNode.insertBefore(after, el.nextSibling);

        /* 此时 el 里只剩 cursor → 拆掉外壳 */
        unwrapEl(el);
        cursor = textNode;                 // 文本节点还在，只是往上挪了一层
        continue;
      }
      cursor = el;
    }
    return textNode;
  }

  /** 用一个新元素把节点包起来 */
  function wrapNode(node, tagName, cls) {
    const w = document.createElement(tagName);
    if (cls) w.className = cls;
    node.parentNode.insertBefore(w, node);
    w.appendChild(node);
    return w;
  }

  /** 收尾整理：把被切碎的相邻同款标注合回去，并合并相邻文本节点 */
  function tidyUp(parent) {
    if (!parent || parent.nodeType !== 1) return;
    const isMark = (n) => n.nodeType === 1 && (n.tagName === HL_TAG.toUpperCase() || n.tagName === UL_TAG.toUpperCase());
    let c = parent.firstChild;
    let guard = 0;
    while (c && guard++ < 500) {
      const n = c.nextSibling;
      if (n && isMark(c) && isMark(n) && c.tagName === n.tagName && (c.className || "") === (n.className || "")) {
        while (n.firstChild) c.appendChild(n.firstChild);
        parent.removeChild(n);
        continue;                 // 不前进，继续尝试与下一个兄弟合并
      }
      c = n;
    }
    if (parent.normalize) parent.normalize();
  }

  /** 处理一个「块内」的 range：逐文本节点精确标注 */
  function applySeg(range, tagName, cls, mode) {
    const common = range.commonAncestorContainer;
    const el0 = elementOf(common) || document.body;
    const scanRoot = el0.nodeType === 1 ? el0 : (el0.parentNode || document.body);

    const nodes = [];
    const walker = document.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT, null);
    let t;
    while ((t = walker.nextNode())) {
      if (!t.nodeValue || !t.nodeValue.length) continue;
      try { if (!range.intersectsNode(t)) continue; } catch (e) { continue; }
      nodes.push(t);
    }
    if (!nodes.length) return null;

    /* 先把每段的 [s, e) 算好，避免处理过程中参考点被改动 */
    const pieces = [];
    nodes.forEach((n) => {
      const len = n.nodeValue.length;
      let s = 0, e = len;
      if (n === range.startContainer) s = Math.max(0, Math.min(range.startOffset, len));
      if (n === range.endContainer) e = Math.max(0, Math.min(range.endOffset, len));
      if (e > s) pieces.push({ node: n, s, e });
    });
    if (!pieces.length) return null;

    const anchors = [];
    pieces.forEach((p) => {
      let mid = p.node;
      if (p.e < mid.nodeValue.length) mid.splitText(p.e);   // 切出右边界
      if (p.s > 0) mid = mid.splitText(p.s);                // 切出左边界
      if (!mid.nodeValue.length) return;

      carveOut(mid, tagName);                               // 抠掉同类外壳

      anchors.push(mode === "remove" ? mid : wrapNode(mid, tagName, cls));
    });
    if (!anchors.length) return null;

    const nr = document.createRange();
    nr.setStartBefore(anchors[0]);
    nr.setEndAfter(anchors[anchors.length - 1]);

    /* 整理：把切碎的相邻同款标注再合起来（B|B → BB） */
    const touched = new Set();
    anchors.forEach((a) => {
      let p = a.parentNode, d = 0;
      while (p && p.nodeType === 1 && d++ < 3) { touched.add(p); p = p.parentNode; }
    });
    touched.forEach(tidyUp);

    return nr;
  }

  /**
   * 读取选区上的标注状态。
   * 返回 { mark: {count, cls}, u: {count, cls} }
   *   cls === null → 该类标注不存在
   *   cls === ""   → 存在但样式/颜色不统一
   */
  function markStateOf(range, root) {
    function one(tag) {
      if (!range) return { count: 0, cls: null };
      const hits = intersectingTags(range, tag, root);
      if (!hits.length) return { count: 0, cls: null };
      const seen = {};
      hits.forEach((el) => { seen[el.className || ""] = 1; });
      const keys = Object.keys(seen);
      return { count: hits.length, cls: keys.length === 1 ? keys[0] : "" };
    }
    return { mark: one(HL_TAG), u: one(UL_TAG) };
  }

  /* ---------- 兼容旧 API ---------- */
  function selectionHas(tagName) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
    return intersectingTags(sel.getRangeAt(0), tagName).length > 0;
  }

  /** 开关式：选区无标注 → 添加；同款 → 取消；不同款 → 换样式 */
  function toggleMark(tagName, cls) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { action: null };
    const range = sel.getRangeAt(0);
    if (range.collapsed) return { action: null };
    const st = markStateOf(range);
    const cur = tagName === HL_TAG ? st.mark : st.u;
    if (cur.count > 0 && cur.cls === cls) {
      const r = applyMark(range, tagName, null, "remove");
      return { action: r ? "remove" : null };
    }
    const r = applyMark(range, tagName, cls, "add");
    return { action: r ? (cur.count > 0 ? "update" : "add") : null };
  }

  function unwrapTagInSelection(tagName) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    const hits = intersectingTags(range, tagName);
    if (!hits.length) return 0;
    return applyMark(range, tagName, null, "remove") ? hits.length : 0;
  }

  function getSelectionText() {
    const sel = window.getSelection();
    return sel ? sel.toString().trim() : "";
  }

  /* =========================================================
   *  划选浮层 SelectionToolbar
   *  用法：
   *    const tb = createSelectionToolbar({
   *      selector: ".annotatable",
   *      onAction: (action, payload) => {}
   *        // action: 'mark' | 'clear' | 'thought' | 'copy'
   *        // payload: { text, host, tag?, cls?, what? }
   *    });
   * ========================================================= */
  function createSelectionToolbar(options) {
    const opts = Object.assign({
      container: null,
      selector: null,
      onAction: () => {}
    }, options);

    const bar = document.createElement("div");
    bar.className = "sel-toolbar";
    bar.setAttribute("role", "toolbar");
    bar.innerHTML = `
      <div class="st-grp st-grp--act">
        <button class="st-btn" data-act="copy" type="button" title="复制选中文字"><span class="ic">⎘</span>复制</button>
        <button class="st-btn" data-act="thought" type="button" title="针对选中文字写想法"><span class="ic">💭</span>想法</button>
        <button class="st-btn st-btn--danger" data-act="clear" type="button" title="取消选中文字上的全部标注"><span class="ic">⌫</span>取消标注</button>
      </div>
      <span class="st-sep"></span>
      <div class="st-grp st-grp--style">
        <button class="st-btn" data-mark="${HL_TAG}" type="button" title="高亮（再点一次取消）"><span class="ic">🖍</span>高亮</button>
        ${UNDERLINES.map((u) => `<button class="st-btn" data-mark="${UL_TAG}" data-cls="${u.cls}" type="button" title="${u.label}下划线（再点一次取消）"><span class="ul-prev ${u.cls}">U</span>${u.label}</button>`).join("")}
      </div>
      <span class="st-sep"></span>
      <div class="st-grp st-grp--color">
        ${HIGHLIGHTS.map((h) => `<button class="st-sw" data-hl="${h.cls}" type="button" style="--sw:${h.color}" title="${h.label}高亮（再点一次取消）"></button>`).join("")}
      </div>
    `;
    document.body.appendChild(bar);

    let visible = false;
    let currentRange = null;
    let currentHost = null;
    let lastRect = null;
    let lastText = "";
    let lastHl = HIGHLIGHTS[0].cls;

    /* ---------- 定位：默认落在选区「下方」 ---------- */
    function place(rect) {
      const r = rect || lastRect;
      if (!r) return;
      lastRect = r;
      const w = bar.offsetWidth;
      const h = bar.offsetHeight;
      let left = r.left + r.width / 2 - w / 2;
      left = Math.max(8, Math.min(left, window.innerWidth - w - 8));

      let below = true;
      let top = r.bottom + 12;
      if (top + h > window.innerHeight - 8) {
        below = false;
        top = r.top - h - 12;
      }
      if (top < 8) top = 8;

      bar.classList.toggle("is-below", below);
      bar.style.left = left + "px";
      bar.style.top = top + "px";
    }

    function show(rect) {
      bar.classList.add("is-show");
      visible = true;
      place(rect);
      requestAnimationFrame(() => { if (visible) place(rect); });
    }

    function hide() {
      bar.classList.remove("is-show");
      visible = false;
      currentRange = null;
      currentHost = null;
      lastRect = null;
      lastText = "";
    }

    function mkPayload(extra) {
      return Object.assign({
        text: (currentRange ? currentRange.toString() : "").trim(),
        host: currentHost
      }, extra || {});
    }

    /** 用「操作后返回的新选区」刷新缓存，保证连续点击都对 */
    function adoptRange(nr) {
      if (!nr) return;
      currentRange = nr.cloneRange();
      lastRect = nr.getBoundingClientRect();
      place(lastRect);
    }

    /** 刷新按钮的激活态（选区已有该标注 → 点亮；颜色圆点带 ✓） */
    function syncActive() {
      const st = markStateOf(currentRange, currentHost);
      bar.querySelectorAll(".st-btn[data-mark]").forEach((b) => {
        const tag = b.dataset.mark;
        if (tag === HL_TAG) {
          b.classList.toggle("is-on", st.mark.count > 0);
        } else {
          b.classList.toggle("is-on", st.u.count > 0 && st.u.cls === b.dataset.cls);
        }
      });
      bar.querySelectorAll(".st-sw").forEach((sw) => {
        const on = st.mark.count > 0 && st.mark.cls === sw.dataset.hl;
        sw.classList.toggle("is-on", on);
      });
    }

    function evaluate() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { hide(); return; }
      const range = sel.getRangeAt(0);

      let host = null;
      if (opts.selector) {
        let node = elementOf(range.commonAncestorContainer);
        while (node && node !== document.body) {
          if (node.nodeType === 1 && node.matches && node.matches(opts.selector)) { host = node; break; }
          node = node.parentNode;
        }
        if (!host) { hide(); return; }
      } else if (opts.container && opts.container !== document.body) {
        const node = elementOf(range.commonAncestorContainer);
        if (!opts.container.contains(node)) { hide(); return; }
        host = opts.container;
      }
      const text = sel.toString().trim();
      if (!text) { hide(); return; }

      lastText = text;
      currentHost = host;
      currentRange = range.cloneRange();
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { hide(); return; }
      show(rect);
      syncActive();
    }

    const onMouseUp = () => setTimeout(evaluate, 0);
    const onTouchEnd = () => setTimeout(evaluate, 30);
    const onKeyUp = (e) => {
      if (e.key === "Escape") hide();
      else if (e.shiftKey) setTimeout(evaluate, 0);
    };
    const onScroll = () => { if (visible) hide(); };
    const onDownOutside = (e) => {
      if (!bar.contains(e.target)) {
        setTimeout(() => { if (!window.getSelection().toString().trim()) hide(); }, 0);
      }
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("touchend", onTouchEnd);
    document.addEventListener("keyup", onKeyUp);
    window.addEventListener("scroll", onScroll, true);
    document.addEventListener("mousedown", onDownOutside);

    /* 点按钮时不要丢掉选区（否则取不到 range） */
    bar.addEventListener("mousedown", (e) => e.preventDefault());

    bar.addEventListener("click", (e) => {
      const range = currentRange;
      if (!range) return;

      /* ---- 复制 ---- */
      const actBtn = e.target.closest("[data-act]");
      if (actBtn) {
        const act = actBtn.dataset.act;
        if (act === "copy") {
          opts.onAction("copy", mkPayload());
          return;
        }
        if (act === "thought") {
          opts.onAction("thought", mkPayload());
          hide();
          return;
        }
        if (act === "clear") {
          /* 一键清掉选区上的所有标注 */
          const st = markStateOf(range, currentHost);
          let nr = null;
          if (st.mark.count) nr = applyMark(range, HL_TAG, null, "remove");
          if (st.u.count) nr = applyMark(nr || range, UL_TAG, null, "remove");
          if (nr) adoptRange(nr);
          syncActive();
          opts.onAction("clear", mkPayload({ what: "all" }));
          return;
        }
      }

      /* ---- 颜色圆点：同色 → 取消；其它色 → 换色 / 新增 ---- */
      const sw = e.target.closest("[data-hl]");
      if (sw) {
        const cls = sw.dataset.hl;
        const st = markStateOf(range, currentHost);
        if (st.mark.count > 0 && st.mark.cls === cls) {
          adoptRange(applyMark(range, HL_TAG, null, "remove"));
          opts.onAction("clear", mkPayload({ what: "mark" }));
        } else {
          adoptRange(applyMark(range, HL_TAG, cls, "add"));
          lastHl = cls;
          opts.onAction("mark", mkPayload({ tag: HL_TAG, cls }));
        }
        syncActive();
        setTimeout(() => place(), 0);
        return;
      }

      /* ---- 样式按钮 ---- */
      const stBtn = e.target.closest("[data-mark]");
      if (stBtn) {
        const tag = stBtn.dataset.mark;
        const st = markStateOf(range, currentHost);
        if (tag === HL_TAG) {
          if (st.mark.count > 0) {
            adoptRange(applyMark(range, HL_TAG, null, "remove"));
            opts.onAction("clear", mkPayload({ what: "mark" }));
          } else {
            adoptRange(applyMark(range, HL_TAG, lastHl, "add"));
            opts.onAction("mark", mkPayload({ tag: HL_TAG, cls: lastHl }));
          }
        } else {
          const cls = stBtn.dataset.cls;
          if (st.u.count > 0 && st.u.cls === cls) {
            adoptRange(applyMark(range, UL_TAG, null, "remove"));
            opts.onAction("clear", mkPayload({ what: "u" }));
          } else {
            adoptRange(applyMark(range, UL_TAG, cls, "add"));
            opts.onAction("mark", mkPayload({ tag: UL_TAG, cls }));
          }
        }
        syncActive();
        setTimeout(() => place(), 0);
        return;
      }
    });

    return {
      el: bar,
      hide,
      show,
      hasSelection: () => !!currentRange,
      refresh: syncActive,
      destroy() {
        document.removeEventListener("mouseup", onMouseUp);
        document.removeEventListener("touchend", onTouchEnd);
        document.removeEventListener("keyup", onKeyUp);
        window.removeEventListener("scroll", onScroll, true);
        document.removeEventListener("mousedown", onDownOutside);
        if (bar.parentNode) bar.parentNode.removeChild(bar);
      }
    };
  }

  global.Annotate = {
    HIGHLIGHTS,
    UNDERLINES,
    HL_TAG,
    UL_TAG,
    applyMark,
    markStateOf,
    intersectingTags,
    splitRangeByBlocks,
    wrapSelection: function (tagName, attrs) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return null;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return null;
      return applyMark(range, tagName, attrs && attrs["class"], "add");
    },
    unwrapTagInSelection,
    toggleMark,
    selectionHas,
    getSelectionText,
    createSelectionToolbar
  };
})(window);

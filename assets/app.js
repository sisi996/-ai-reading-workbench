/* ==========================================================
 *  app.js — AI 读书笔记工作台 SPA 主逻辑
 *  视图：overview（总览·右侧抽屉）/ reading（在读·即见笔记）/ todo（未读）/ treasure（宝藏）
 * ========================================================== */
(function () {
  const $  = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const API = window.WEREAD_API;

  /* 公网部署的「展示版」判定：
   *   只有 server.js 在跑（本机 / 局域网）时才连得上微信读书代理。
   *   放到公网静态托管后，页脚再去引导「点击配置真实数据」只会让人点进死路，
   *   所以这里识别出来，换成「展示版 · 示例数据」，并隐藏同步 / 连接按钮。 */
  const IS_SHOWCASE = (() => {
    if (typeof location === "undefined" || !/^https?:$/.test(location.protocol)) return false;
    const h = location.hostname;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1|\[::1\])$/.test(h)) return false;
    // 局域网自用（手机访问自己电脑）也当成正常环境
    if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  })();
  if (IS_SHOWCASE) document.body.classList.add("is-showcase");

  /* =========================================================
   *  全局状态
   * ========================================================= */
  const store = {
    view: "overview",
    keyword: "",
    activeReadingId: null,   // 在读视图当前打开的书
    drawerBookId: null,      // 总览右侧抽屉当前书
    draftDoc: {},            // { bookId: html } 未保存的笔记草稿
    dirty: {},
    tcats: [],               // 宝藏分类
    tFilter: "all",          // 宝藏当前筛选：'all' | 'uncat' | 分类 id
    catFilter: "",           // 书籍分类筛选：'' = 全部，'__none__' = 未分类
    catBarOpen: false,       // 分类筛选条是否展开全部（分类多时默认折叠）
    groupByCat: false,       // 书籍总览：按分类分块显示
    noteKeyword: "",         // 「我的笔记」页内的搜索词（与顶栏搜索互不影响）
    noteSrc: "all",          // 「我的笔记」页的来源筛选：all|quote|thought|weread|local
    noteOpenAll: {},         // 「我的笔记」页：哪些书的笔记已展开全部
    _lastView: "",           // 切视图时用于重置分类筛选
    lastSyncAt: ""           // 最近一次同步时间（侧边栏展示）
  };

  const ROUTES = {
    overview: { title: "书籍总览", sub: "全部书籍" },
    reading:  { title: "我的在读", sub: "正在读" },
    done:     { title: "我的读完", sub: "已读完" },
    todo:     { title: "我的未读", sub: "待读" },
    notes:    { title: "我的笔记", sub: "全部划线 / 想法" },
    treasure: { title: "我的宝藏", sub: "图文收藏" },
    trash:    { title: "宝藏回收", sub: "30 天回收期" }
  };

  /* =========================================================
   *  小工具
   * ========================================================= */
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));

  /* 封面加载失败兜底：用书名首字生成 SVG，不依赖外部网络 */
  function coverFallback(img) {
    img.onerror = null;
    const title = (img.dataset.title || img.alt || "书").trim();
    const ch = title.charAt(0) || "书";
    const palette = ["#1aad8f", "#2f6fb5", "#8a5a2b", "#6b4fa8", "#b5563f", "#3f7d4e", "#a8763f", "#4a7f9e"];
    let sum = 0;
    for (let i = 0; i < title.length; i++) sum += title.charCodeAt(i);
    const bg = palette[sum % palette.length];
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="280">' +
      '<rect width="200" height="280" fill="' + bg + '"/>' +
      '<text x="100" y="158" font-size="80" fill="#ffffff" fill-opacity="0.92" ' +
      'text-anchor="middle" font-family="serif">' + ch + "</text></svg>";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  window.__coverFallback = coverFallback;

  /* =========================================================
   *  图片下载 / 可编辑内容的「装饰 ⇄ 序列化」
   *  · ensureContentUI() 渲染后补齐下载按钮、想法删除按钮（幂等）
   *  · bindContentActions() 用事件委托接管这些按钮的点击
   * ========================================================= */
  async function downloadImage(src, name) {
    if (!src) { toast("没有可下载的图片", "err"); return; }
    const fname = (String(name || "image").replace(/[\\/:*?"<>|]/g, "_") || "image") + ".png";
    try {
      let href = src;
      let revoke = false;
      if (!/^data:/i.test(src)) {
        const res = await fetch(src, { mode: "cors" });
        const blob = await res.blob();
        href = URL.createObjectURL(blob);
        revoke = true;
      }
      const a = document.createElement("a");
      a.href = href;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (revoke) setTimeout(() => URL.revokeObjectURL(href), 4000);
      toast("图片已开始下载", "ok");
    } catch (e) {
      toast("下载失败，可右键图片「另存为」", "err");
    }
  }

  /* 下载按钮只负责「长什么样」；点击统一由 bindContentActions 事件委托处理 */
  function imgDownloadBtn(src, nameBase) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "img-dl";
    btn.title = "下载这张图片";
    btn.setAttribute("contenteditable", "false");
    btn.dataset.name = nameBase || "image";
    btn.innerHTML = "⤓";
    return btn;
  }

  /** 给容器里的图片补下载按钮、给想法补删除按钮（幂等，可重复调用） */
  function ensureContentUI(root, nameBase) {
    if (!root) return;
    $$(".ti-thought, [data-thought]", root).forEach((d) => {
      if (d.querySelector(".th-del")) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "th-del";
      btn.title = "删除这条想法";
      btn.setAttribute("contenteditable", "false");
      btn.textContent = "×";
      d.appendChild(btn);
    });
    $$("img", root).forEach((img) => {
      const p = img.parentNode;
      if (!p) return;
      const src = img.getAttribute("src") || "";
      if (!src) return;
      // 已经有包裹层 → 只补按钮
      if (p.classList && p.classList.contains("img-wrap")) {
        if (!p.querySelector(".img-dl")) p.appendChild(imgDownloadBtn(src, nameBase));
        return;
      }
      const wrap = document.createElement("span");
      wrap.className = "img-wrap";
      p.insertBefore(wrap, img);
      wrap.appendChild(img);
      wrap.appendChild(imgDownloadBtn(src, nameBase));
    });
    $$(".img-dl", root).forEach((b) => { b.dataset.name = nameBase || "image"; });
  }

  /**
   * 内容区的交互委托（删除想法 / 下载图片）。
   * 用委托而不是逐个绑事件：DOM 被重排后依然有效。
   */
  function bindContentActions(host, onChange) {
    if (!host) return;
    host.addEventListener("mousedown", (e) => {
      if (e.target.closest(".th-del, .img-dl")) e.preventDefault(); // 别把光标抢走
    });
    host.addEventListener("click", (e) => {
      const del = e.target.closest(".th-del");
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        const th = del.closest(".ti-thought, [data-thought]");
        if (th) { th.remove(); if (onChange) onChange("thought-deleted"); }
        return;
      }
      const dl = e.target.closest(".img-dl");
      if (dl) {
        e.preventDefault();
        e.stopPropagation();
        const wrap = dl.parentNode;
        const img = wrap && wrap.querySelector("img");
        downloadImage(img ? img.getAttribute("src") : "", dl.dataset.name || "image");
      }
    });
  }

  /** 想法：自动用中文双引号包起来，样式与笔记正文有区分 */
  function thoughtHTML(text) {
    const t = String(text == null ? "" : text).trim().replace(/^[“"]+|[”"]+$/g, "");
    return `<div class="ti-thought" data-thought>“${esc(t)}”</div>`;
  }

  /** 分类名（找不到时返回「未分类」） */
  function catName(id) {
    if (!id) return "未分类";
    const c = (store.tcats || []).find((x) => x.id === id);
    return c ? c.name : "未分类";
  }

  function toast(msg, type = "info") {
    let host = $(".toast-host");
    if (!host) { host = document.createElement("div"); host.className = "toast-host"; document.body.appendChild(host); }
    const el = document.createElement("div");
    el.className = "toast";
    if (type === "err") el.style.background = "rgba(190,60,60,.94)";
    if (type === "ok")  el.style.background = "rgba(17,144,122,.94)";
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  /* 复制纯文本到剪贴板（非安全上下文 / 无权限时用 execCommand 兜底） */
  function copyText(text) {
    const t = String(text == null ? "" : text);
    if (!t.trim()) return Promise.resolve(false);
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        const okFlag = document.execCommand("copy");
        ta.remove();
        return okFlag;
      } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(() => true).catch(fallback);
    }
    return Promise.resolve(fallback());
  }

  /* HTML → 纯文本（保留换行，只留文字，不带图片/标注标签） */
  function htmlToText(html) {
    return String(html == null ? "" : html)
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(div|p|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<button[\s\S]*?<\/button>/gi, "")   // 去掉下载 / 删除等界面按钮
      .replace(/<img[^>]*>/gi, "")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  /* 触发一次本地文件下载（纯前端，不发网络请求） */
  function downloadFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  function stampNow() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  /* 应用内确认框：不依赖可能被浏览器屏蔽的原生 confirm */
  function confirmDialog(opts) {
    const o = typeof opts === "string" ? { message: opts } : (opts || {});
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `
        <div class="modal confirm-modal" role="dialog" aria-modal="true">
          <div class="modal__head"><h3>${esc(o.title || "请确认")}</h3></div>
          <div class="modal__body">
            <div class="confirm-msg">${esc(o.message || "")}</div>
            ${o.hint ? `<div class="confirm-hint">${esc(o.hint)}</div>` : ""}
          </div>
          <div class="modal__foot">
            ${o.okOnly ? "" : `<button class="btn btn-ghost" data-act="cancel" type="button">${esc(o.cancelText || "取消")}</button>`}
            <button class="btn ${o.danger ? "btn-danger" : "btn-primary"}" data-act="ok" type="button">${esc(o.okText || "确定")}</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add("is-open"));

      const done = (v) => { document.removeEventListener("keydown", onKey); mask.remove(); resolve(v); };
      function onKey(e) { if (e.key === "Escape") done(false); }
      mask.querySelector('[data-act="ok"]').addEventListener("click", () => done(true));
      const cancelBtn = mask.querySelector('[data-act="cancel"]');
      cancelBtn && cancelBtn.addEventListener("click", () => done(false));
      mask.addEventListener("click", (e) => { if (e.target === mask) done(false); });
      document.addEventListener("keydown", onKey);
      setTimeout(() => { const b = mask.querySelector('[data-act="ok"]'); if (b) b.focus(); }, 40);
    });
  }

  /* 应用内输入框：替代可能被浏览器屏蔽的原生 prompt */
  function promptDialog(opts) {
    const o = typeof opts === "string" ? { title: opts } : (opts || {});
    return new Promise((resolve) => {
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `
        <div class="modal confirm-modal" role="dialog" aria-modal="true">
          <div class="modal__head"><h3>${esc(o.title || "输入")}</h3></div>
          <div class="modal__body">
            <textarea class="prompt-input" rows="4" placeholder="${esc(o.placeholder || "")}">${esc(o.value || "")}</textarea>
          </div>
          <div class="modal__foot">
            <button class="btn btn-ghost" data-act="cancel" type="button">取消</button>
            <button class="btn btn-primary" data-act="ok" type="button">保存</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add("is-open"));

      const input = mask.querySelector(".prompt-input");
      const done = (v) => { document.removeEventListener("keydown", onKey); mask.remove(); resolve(v); };
      function onKey(e) {
        if (e.key === "Escape") done(null);
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) done(input.value.trim() || null);
      }
      mask.querySelector('[data-act="ok"]').addEventListener("click", () => done(input.value.trim() || null));
      mask.querySelector('[data-act="cancel"]').addEventListener("click", () => done(null));
      mask.addEventListener("click", (e) => { if (e.target === mask) done(null); });
      document.addEventListener("keydown", onKey);
      setTimeout(() => { try { input.focus(); } catch (e) {} }, 40);
    });
  }


  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const statusLabel = (s) => ({ reading: "在读", finished: "已读", unread: "未读" }[s] || s);

  function fmtDays(n) { return n > 0 ? `${n} 天` : "—"; }
  function fmtDate(s) {
    if (!s) return "—";
    return String(s).slice(0, 10);
  }
  /** 18420 → 1.8万 */
  function fmtCount(n) {
    const v = Number(n) || 0;
    if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, "") + "万";
    return String(v);
  }
  function nowClock() {
    const d = new Date();
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /**
   * 五星评分（支持半星）
   * 微信读书的评分是 0~10 分制（9.2），这里换算成 5 星，
   * 用「底星 + 按宽度裁切的实星」做出 0.5 星的精度，不依赖特殊字体。
   */
  function ratingHTML(book, opts) {
    const o = opts || {};
    const r = Number(book && book.rating) || 0;
    if (!r) return `<span class="rate-none">${esc(o.emptyText || "暂无评分")}</span>`;
    const v = Math.max(0, Math.min(5, r / 2));
    const cnt = Number(book.ratingCount) || 0;
    return `<span class="stars" style="--v:${v.toFixed(2)}" title="${r.toFixed(1)} 分">` +
      `<span class="stars__bg">★★★★★</span><span class="stars__fg">★★★★★</span></span>` +
      `<b class="rate-num">${r.toFixed(1)}</b>` +
      (o.hideCount || !cnt ? "" : `<span class="rate-count">${fmtCount(cnt)} 人评价</span>`);
  }

  /**
   * 卡片底部那行时间
   * · 微信读书只给「最近阅读」，我们拿它占位时打的是 guess 标记 → 如实显示「最近阅读」；
   * · 本地记录过 / 用户手工改过 → 才是真正的「首次阅读」。
   */
  function readWhenHTML(book) {
    const d = fmtDate(book.firstReadTime);
    if (!book.firstReadTime) return "尚未开始";
    const tip = book.firstReadGuess
      ? "微信读书只提供最近阅读；天数是自然日，不是实际翻开的天数"
      : "天数是自首次阅读起的自然日，不是实际翻开的天数";
    if (book.firstReadGuess) {
      return `<span title="${esc(tip)}">最近阅读 ${esc(d)} · ${fmtDays(book.readingDays)}前</span>`;
    }
    return `<span title="${esc(tip)}">首次阅读 ${esc(d)} · 已读 ${fmtDays(book.readingDays)}</span>`;
  }

  /** 进度百分比：一律夹到 0~100，上游给了脏数据也不会把进度条撑爆 */
  function pctOf(b) {
    return Math.max(0, Math.min(100, Math.round(Number(b && b.progress) || 0)));
  }

  /** 读完 = 进度到 100%。status 可能被手工改过，所以两个条件取并集，避免漏掉 */
  function isFinished(b) {
    return pctOf(b) >= 100 || b.status === "finished";
  }

  /* =========================================================
   *  书籍分类（来自微信读书）
   *  来源优先级：手工指定 > 微信读书书架分组(archive) > 书籍品类(category)
   *  都没有 → 归到「未分类」
   * ========================================================= */
  const NONE_CAT = "__none__";

  function catName(b) {
    const v = (typeof API.catOf === "function") ? API.catOf(b) : (b.category || "");
    return String(v || "").trim();
  }
  function catLabel(b) { return catName(b) || "未分类"; }
  function catKey(b) { return catName(b) || NONE_CAT; }

  /** 统计一批书里各分类的册数；「未分类」永远排最后 */
  function catStats(list) {
    const m = new Map();
    list.forEach((b) => {
      const k = catKey(b);
      m.set(k, (m.get(k) || 0) + 1);
    });
    return Array.from(m.entries())
      .map(([key, n]) => ({ key, name: key === NONE_CAT ? "未分类" : key, n }))
      .sort((a, b) => (a.key === NONE_CAT ? 1 : 0) - (b.key === NONE_CAT ? 1 : 0) || b.n - a.n || a.name.localeCompare(b.name));
  }

  /**
   * 分类筛选条：全部 + 各分类（带册数）。只有一种分类时不显示，免得白占一行。
   * 分类多（> CAT_CHIP_LIMIT）时先收起，点「更多 N 个 ▾」再展开 ——
   * 书架有一百多本时分类能有十几个，全平铺会把卡片挤到看不见。
   */
  const CAT_CHIP_LIMIT = 6;

  function catBarHTML(list, sel) {
    const stats = catStats(list);
    if (stats.length <= 1) return "";
    const chip = (key, n, name) =>
      `<button type="button" class="cat-chip${sel === key ? " is-on" : ""}" data-cat="${esc(key)}">${esc(name)}<i>${n}</i></button>`;

    const head = stats.slice(0, CAT_CHIP_LIMIT);
    const rest = stats.slice(CAT_CHIP_LIMIT);
    // 选中的分类如果被折起来了，自动展开，不然用户会以为筛选丢了
    if (!store.catBarOpen && rest.some((s) => s.key === sel)) store.catBarOpen = true;

    let more = "";
    if (rest.length) {
      more = store.catBarOpen
        ? rest.map((s) => chip(s.key, s.n, s.name)).join("") +
          `<button type="button" class="cat-chip cat-more" data-more="0">收起 ▴</button>`
        : `<button type="button" class="cat-chip cat-more" data-more="1">更多 ${rest.length} 个 ▾</button>`;
    }

    return `<div class="cat-bar">${chip("", list.length, "全部")}${
      head.map((s) => chip(s.key, s.n, s.name)).join("")}${more}</div>`;
  }

  function attachCatBar(host, repaint) {
    const bar = $(".cat-bar", host);
    if (!bar) return;
    bar.addEventListener("click", (e) => {
      const btn = e.target.closest ? e.target.closest(".cat-chip") : null;
      if (!btn) return;
      const more = btn.getAttribute("data-more");
      if (more !== null && more !== undefined && more !== "") {
        store.catBarOpen = more === "1";
        repaint();
        return;
      }
      const key = btn.getAttribute("data-cat") || "";
      store.catFilter = (store.catFilter === key) ? "" : key;   // 再点一次取消筛选
      repaint();
    });
  }

  /** 把一批书画进网格；groupBy=true 时按分类分块 */
  function paintBookGrid(grid, arr, { groupBy = false, makeCard = bookCard, emptyText = "没有匹配的书籍" } = {}) {
    grid.innerHTML = "";
    if (!arr.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="icon">📭</div><div>${esc(emptyText)}</div></div>`;
      return;
    }
    if (!groupBy) { arr.forEach((b) => grid.appendChild(makeCard(b))); return; }
    catStats(arr).forEach((s) => {
      const items = arr.filter((b) => catKey(b) === s.key);
      const sec = document.createElement("div");
      sec.className = "cat-section";
      sec.innerHTML = `<div class="cat-section__head"><h4>${esc(s.name)}</h4><i>${items.length} 本</i></div>`;
      const inner = document.createElement("div");
      inner.className = "book-grid";
      items.forEach((b) => inner.appendChild(makeCard(b)));
      sec.appendChild(inner);
      grid.appendChild(sec);
    });
  }

  /* =========================================================
   *  启动
   * ========================================================= */
  async function boot() {
    buildShellExtras();
    bindShell();

    store.books = await API.loadBooks();
    store.treasures = await API.loadTreasures();
    store.tcats = await API.listCategories();
    store.trash = await API.listTrash();
    if (API.state.connected) store.lastSyncAt = nowClock();

    applyRoute();
    window.addEventListener("hashchange", applyRoute);
    fillRatings();      // 首屏先出来，评分放后台慢慢补
    fillNotes();        // 再后台把微信读书的划线 / 想法同步进来
  }

  /**
   * 笔记同步的自动策略：
   *  · 从没同步过 → 连上就全量同步一次（不然书架里永远看不到笔记）；
   *  · 同步过了 → 超过 12 小时才在后台静默补一次，避免每次开页面都几百个请求。
   * 手动入口：顶栏「⟳ 同步笔记」按钮 / 设置弹窗里的按钮。
   */
  const NOTE_SYNC_TTL = 12 * 3600 * 1000;
  async function fillNotes({ force = false } = {}) {
    if (API.state.mode !== "real" || !API.state.connected) return;
    const last = API.state.lastNoteSync;
    if (!force && last && last.at && (Date.now() - last.at) < NOTE_SYNC_TTL) return;
    await syncNotes({ silent: true });
  }

  /**
   * 补评分：微信读书的 /shelf/sync（书架）不含评分，只有 /book/info 才有。
   * 所以首屏渲染完之后，在后台逐本补拉一次并落盘，补完再局部重渲染。
   * （在宝藏 / 回收站视图里不要 render，否则会把正在编辑的编辑器冲掉）
   */
  let ratingsBusy = false;
  async function fillRatings() {
    if (ratingsBusy) return;
    if (API.state.mode !== "real" || !API.state.connected) return;
    ratingsBusy = true;
    try {
      const hit = await API.enrichRatings();
      if (hit > 0) {
        if (["overview", "todo", "reading", "done", "notes"].includes(store.view)) render();
        else updateNavBadges();
        toast(`已补齐 ${hit} 本书的评分`, "ok");
      }
    } catch (e) {
      /* 网络抖动就算了，下次同步再补 */
    } finally {
      ratingsBusy = false;
    }
  }

  function applyRoute() {
    const hash = (location.hash || "#/overview").replace(/^#\/?/, "");
    const view = ROUTES[hash] ? hash : "overview";
    store.view = view;
    render();
    // 进入回收站时刷新一次：自动清理已过期项，并同步最新倒计时 / 数量
    if (view === "trash") {
      API.listTrash().then((list) => {
        store.trash = list;
        if (store.view === "trash") render();
      });
    }
  }

  /* =========================================================
   *  构建抽屉 / 弹窗 / Toast 宿主
   * ========================================================= */
  function buildShellExtras() {
    if (!$(".toast-host")) {
      const t = document.createElement("div"); t.className = "toast-host"; document.body.appendChild(t);
    }
    if (!$("#drawerMask")) {
      const mask = document.createElement("div");
      mask.className = "drawer-mask"; mask.id = "drawerMask";
      document.body.appendChild(mask);

      const drawer = document.createElement("aside");
      drawer.className = "drawer"; drawer.id = "drawer";
      drawer.innerHTML = `<div class="drawer__head" id="drawerHead"></div><div class="drawer__body" id="drawerBody"></div>`;
      document.body.appendChild(drawer);

      mask.addEventListener("click", closeDrawer);
    }
    if (!$("#settingsMask")) {
      const m = document.createElement("div");
      m.className = "modal-mask"; m.id = "settingsMask";
      document.body.appendChild(m);
      m.addEventListener("click", (e) => { if (e.target === m) closeSettings(); });
    }
  }

  /* =========================================================
   *  抽屉控制
   * ========================================================= */
  function openDrawer(bookId) {
    store.drawerBookId = bookId;
    $("#drawerMask").classList.add("is-open");
    $("#drawer").classList.add("is-open");
    renderDrawer();
  }
  function closeDrawer() {
    $("#drawerMask").classList.remove("is-open");
    $("#drawer").classList.remove("is-open");
    store.drawerBookId = null;
    destroyToolbar();
  }
  /**
   * AI 面板（建议文档里的「本书问答 / AI 总结 / 思维导图」）。
   * 上下文**只取这本书的笔记**（按书隔离的 RAG），所以：
   *   - 问《置身事内》不会拿《活着》的笔记来答；
   *   - 答案会带 [1] [2] 编号，对应本书的片段。
   * 没配 Key 时给的是明确占位 + 配置入口，不是假装算出来的假结果。
   */
  function buildAIPanel(book) {
    const sec = document.createElement("section");
    sec.className = "ai-panel";
    const ready = window.AI && (window.AI.hasKey() || window.AI._serverKey);
    const noteN = (book.notes || []).length;

    sec.innerHTML = `
      <div class="ai-panel__head">
        <h5>✨ AI 阅读助理</h5>
        <span class="hint">只基于《${esc(book.title)}》的 ${noteN} 条笔记回答（按书隔离，不混别的书）</span>
      </div>
      <div class="ai-panel__body" id="aiBody"></div>
    `;
    const body = $(".ai-panel__body", sec);

    const paint = (isReady) => {
      if (!isReady) {
        body.innerHTML = `
          <div class="ai-empty">
            <div class="t">接一个 DeepSeek Key，就能针对这本书的笔记提问、生成总结和思维导图。</div>
            <div class="s">不填也完全不影响使用：笔记、同步、备份都是本地能力。</div>
            <div class="acts">
              <button class="btn btn-primary" id="aiGoCfg">去设置填入 Key</button>
            </div>
          </div>`;
        $("#aiGoCfg", body).addEventListener("click", () => { openSettings(); });
        return;
      }
      body.innerHTML = `
        <div class="ai-ask">
          <input id="aiQ" placeholder="关于这本书，问点什么…（例：这本书对「风险」的核心观点是什么？）">
          <button class="btn btn-primary" id="aiAsk">提问</button>
        </div>
        <div class="ai-acts">
          <button class="btn btn-ghost" id="aiSum">📝 AI 总结本书</button>
          <button class="btn btn-ghost" id="aiMap">🗺 生成思维导图</button>
        </div>
        <div class="ai-out" id="aiOut"></div>
      `;

      const out = $("#aiOut", body);
      const q = $("#aiQ", body);

      const run = async (kind) => {
        const question = kind === "ask" ? String(q.value || "").trim() : "";
        if (kind === "ask" && !question) { toast("先写个问题", "err"); return; }
        if (!noteN) { toast("这本书还没有笔记", "err"); return; }

        $("#aiAsk", body).disabled = true;
        $("#aiSum", body).disabled = true;
        $("#aiMap", body).disabled = true;
        out.className = "ai-out is-busy";
        out.innerHTML = `<div class="ai-thinking">正在本书笔记里检索相关片段，并交给模型…</div>`;

        const r = kind === "ask" ? await window.AI.ask(book, question)
          : kind === "sum" ? await window.AI.summarize(book)
          : await window.AI.mindmap(book);

        $("#aiAsk", body).disabled = false;
        $("#aiSum", body).disabled = false;
        $("#aiMap", body).disabled = false;
        out.className = "ai-out";

        if (!r.ok) {
          out.innerHTML = `<div class="ai-err">${esc(r.error || "调用失败")}</div>`;
          toast(r.error || "调用失败", "err");
          return;
        }
        const meta = `<div class="ai-meta">上下文：本书 ${r.used || 0} 条笔记 · 模型 deepseek-chat · 回答只依据这些笔记</div>`;

        if (kind === "map") {
          const tree = window.AI.mermaidToTreeHTML(r.content);
          out.innerHTML = meta + (tree || "") + `
            <details class="ai-src"><summary>查看 Mermaid 源码（可粘到支持 Mermaid 的编辑器）</summary>
              <pre>${esc(r.content)}</pre>
              <button class="btn btn-ghost" id="aiCopyMmd">⎘ 复制源码</button>
            </details>`;
          const cp = $("#aiCopyMmd", out);
          if (cp) cp.addEventListener("click", async () => {
            const ok = await copyText(r.content);
            toast(ok ? "已复制 Mermaid 源码" : "复制失败", ok ? "ok" : "err");
          });
          return;
        }
        out.innerHTML = meta + window.AI.mdToHTML(r.content);
      };

      $("#aiAsk", body).addEventListener("click", () => run("ask"));
      q.addEventListener("keydown", (e) => { if (e.key === "Enter") run("ask"); });
      $("#aiSum", body).addEventListener("click", () => run("sum"));
      $("#aiMap", body).addEventListener("click", () => run("map"));
    };

    paint(ready);
    // 服务端可能用环境变量预置了 Key，探测一次
    if (window.AI && !window.AI.hasKey()) {
      window.AI.ping().then((p) => {
        window.AI._serverKey = !!(p && p.hasServerKey);
        if (window.AI._serverKey && sec.isConnected) paint(true);
      });
    }
    return sec;
  }

  function renderDrawer() {
    const book = API.state.books.find((b) => b.bookId === store.drawerBookId);
    const head = $("#drawerHead"), body = $("#drawerBody");
    if (!book) { head.innerHTML = ""; body.innerHTML = ""; return; }

    head.innerHTML = `
      <img class="cover" src="${esc(book.cover)}" alt="${esc(book.title)}" data-title="${esc(book.title)}" onerror="window.__coverFallback&&window.__coverFallback(this)">
      <div class="info">
        <h4>${esc(book.title)}</h4>
        <p>${esc(book.author)}${book.publisher ? " · " + esc(book.publisher) : ""}</p>
        <div class="book-rate">${ratingHTML(book)}</div>
      </div>
      <span class="days-badge" title="${book.firstReadGuess
        ? "口径：从「最近阅读」这天算到今天（微信读书不提供首次阅读时间）"
        : "口径：从首次阅读那天算到今天的自然天数，不是实际翻开的天数"}">已读 ${fmtDays(book.readingDays)}</span>
      ${IS_SHOWCASE || !window.AI ? "" : `<button class="btn btn-ghost ai-jump" title="跳到 AI 阅读助理">✨ AI</button>`}
      <button class="close" title="关闭">×</button>
    `;
    $(".close", head).addEventListener("click", closeDrawer);
    body.innerHTML = "";
    body.appendChild(buildNoteWorkspace(book, { compact: true }));
    if (!IS_SHOWCASE && window.AI) body.appendChild(buildAIPanel(book));
    const jump = $(".ai-jump", head);
    if (jump) jump.addEventListener("click", () => {
      const p = $(".ai-panel", body);
      if (p) p.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    body.scrollTop = 0;
  }

  /* =========================================================
   *  笔记工作区（核心组件）
   * ========================================================= */
  /** 关闭抽屉时顺手收起浮层（浮层是全局单例，只隐藏不销毁） */
  function destroyToolbar() { destroyTreasureToolbars(); }

  function buildNoteWorkspace(book, opts = {}) {
    const wrap = document.createElement("div");

    // 拉取深度数据（真实模式下拉微信读书的划线/想法/评论）
    API.fetchBookDeep(book.bookId).then(() => {
      if (wrap.isConnected) {
        const list = $("#noteList", wrap);
        if (list) renderNoteList(list, book);
        const meta = $("#metaStrip", wrap);
        if (meta) meta.innerHTML = metaStripHTML(book);
      }
    });

    wrap.innerHTML = `
      <div class="meta-strip" id="metaStrip">${metaStripHTML(book)}</div>

      <div class="progress-ctl">
        <span style="font-size:12px;color:#9a958c;">阅读进度</span>
        <input type="range" min="0" max="100" value="${book.progress}" id="progRange">
        <span class="pct" id="progPct">${book.progress}%</span>
      </div>

      <div class="note-panel__bar">
        <h5>我的笔记 · 思考</h5>
      </div>

      <div class="annotatable" id="annot" contenteditable="true"
           data-placeholder="在这里粘贴书摘，或选中文字点「高亮 / 下划线」…"></div>

      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" id="btnSaveDoc">保存笔记</button>
        <button class="btn btn-ghost" id="btnThought">＋ 个人想法</button>
        <button class="btn btn-ghost" id="btnPaste">⎘ 粘贴</button>
        <button class="btn btn-ghost" id="btnAddExcerpt">＋ 新增摘录</button>
      </div>

      <div class="note-panel__bar" style="margin-top:22px;">
        <h5>摘录卡片</h5>
        <span class="hint" id="noteCount"></span>
      </div>
      <div class="note-list" id="noteList"></div>
    `;

    /* ---- 渲染文档内容 ---- */
    const annot = $("#annot", wrap);
    annot.innerHTML = getDocHTML(book);

    /* ---- 图片 / 富文本粘贴去格式 ---- */
    annot.addEventListener("paste", (e) => {
      const items = (e.clipboardData || window.clipboardData).items || [];
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          const file = it.getAsFile();
          const reader = new FileReader();
          reader.onload = () => {
            document.execCommand("insertHTML", false,
              `<img src="${reader.result}" style="max-width:100%;border-radius:6px;margin:6px 0;">`);
          };
          reader.readAsDataURL(file);
          return;
        }
      }
      // 纯文本：去掉外部样式
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      document.execCommand("insertText", false, text);
      markDirty(book.bookId);
    });

    annot.addEventListener("input", () => markDirty(book.bookId));

    /* ---- 划选浮层（复用全局那一个） ---- */
    attachTreasureToolbar(annot, async (action, payload) => {
        if (action === "mark") {
          markDirty(book.bookId);
          const sel = (payload && payload.text) || "";
          if (sel) persistInline(book, payload && payload.tag === "u" ? "underline" : "highlight", sel);
          toast(payload && payload.tag === "u" ? "已加下划线" : "已加高亮", "ok");
        } else if (action === "clear") {
          markDirty(book.bookId);
          toast("已取消标注");
        } else if (action === "thought") {
          const quoted = (payload && payload.text) || window.getSelection().toString().trim();
          const thought = await promptDialog({ title: "添加想法", placeholder: "写下你的想法…", value: "" });
          if (!thought) return;
          annot.insertAdjacentHTML("beforeend",
            `<div data-thought>“${esc(thought)}”${quoted ? `<div class="thought-ref">—— 针对「${esc(quoted.slice(0, 40))}${quoted.length > 40 ? "…" : ""}」</div>` : ""}</div>`);
          markDirty(book.bookId);
          API.saveNote(book.bookId, { type: "thought", text: thought, chapter: quoted.slice(0, 40) });
          refreshNoteList(wrap, book);
          toast("想法已添加", "ok");
        } else if (action === "copy") {
          const txt = (payload && payload.text) || window.getSelection().toString();
          copyText(txt).then((okFlag) => toast(okFlag ? "已复制选中文字" : "复制失败", okFlag ? "ok" : "err"));
        }
    });

    /* ---- 进度滑块：未读 → 在读 自动流转 ---- */
    const range = $("#progRange", wrap), pct = $("#progPct", wrap);
    range.addEventListener("input", () => { pct.textContent = range.value + "%"; });
    range.addEventListener("change", async () => {
      const v = +range.value;
      await API.setProgress(book.bookId, v);
      pct.textContent = v + "%";
      $("#metaStrip", wrap).innerHTML = metaStripHTML(book);
      updateNavBadges();
      if (v > 0 && book.status === "reading" && opts.onStatusChange) opts.onStatusChange();
      toast(`进度已更新为 ${v}%`, "ok");
      if (opts.onStatusChange) opts.onStatusChange();
    });

    /* ---- 保存 ---- */
    $("#btnSaveDoc", wrap).addEventListener("click", async () => {
      await API.saveNoteDoc(book.bookId, annot.innerHTML);
      store.dirty[book.bookId] = false;
      store.draftDoc[book.bookId] = annot.innerHTML;
      toast("笔记已保存", "ok");
      refreshNoteList(wrap, book);
    });

    /* ---- 想法 ---- */
    $("#btnThought", wrap).addEventListener("click", async () => {
      const thought = await promptDialog({ title: "添加想法", placeholder: "写下你的想法…" });
      if (!thought) return;
      annot.insertAdjacentHTML("beforeend", `<div data-thought>“${esc(thought)}”</div>`);
      ensureContentUI(annot, book.title || "note");
      markDirty(book.bookId);
      API.saveNote(book.bookId, { type: "thought", text: thought });
      refreshNoteList(wrap, book);
      toast("想法已添加", "ok");
    });

    /* ---- 粘贴按钮 ---- */
    $("#btnPaste", wrap).addEventListener("click", async () => {
      try {
        const txt = await navigator.clipboard.readText();
        annot.insertAdjacentHTML("beforeend", `<p>${esc(txt).replace(/\n/g, "<br>")}</p>`);
        markDirty(book.bookId);
        toast("已粘贴", "ok");
      } catch (e) { toast("浏览器未授权读取剪贴板", "err"); }
    });

    /* ---- 新增摘录 ---- */
    $("#btnAddExcerpt", wrap).addEventListener("click", async () => {
      const txt = await promptDialog({ title: "新增摘录", placeholder: "粘贴或输入这段摘录…" });
      if (!txt || !txt.trim()) return;
      await API.saveNote(book.bookId, { type: "highlight", text: txt.trim() });
      refreshNoteList(wrap, book);
      toast("已添加摘录", "ok");
    });

    /* ---- 笔记正文里的图片下载 / 想法删除 ---- */
    ensureContentUI(annot, book.title || "note");
    bindContentActions(annot, () => markDirty(book.bookId));

    renderNoteList($("#noteList", wrap), book);
    bindFirstReadEdit(wrap, book, () => render());
    return wrap;
  }

  function metaStripHTML(book) {
    const guess = !!book.firstReadGuess;
    return `
      <div class="meta-chip" data-edit="first"
           title="${guess ? "微信读书只提供「最近阅读」；点这里可以手工改成真正的首次阅读时间" : "点击可修正首次阅读时间"}"
           style="cursor:pointer;">
        <span class="k">${guess ? "最近阅读 ✎" : "首次阅读 ✎"}</span>
        <span class="v">${esc(fmtDate(book.firstReadTime))}</span>
      </div>
      <div class="meta-chip" title="口径：从${guess ? "最近阅读" : "首次阅读"}那天算到今天的自然天数；微信读书不提供「实际翻开过的天数」">
        <span class="k">${guess ? "距今" : "阅读天数"}</span>
        <span class="v accent">${esc(fmtDays(book.readingDays))}</span>
      </div>
      <div class="meta-chip">
        <span class="k">阅读进度</span>
        <span class="v accent">${Math.max(0, Math.min(100, Math.round(Number(book.progress) || 0)))}%</span>
      </div>
      <div class="meta-chip">
        <span class="k">评分 / 评价</span>
        <span class="v">${book.rating ? "★ " + book.rating.toFixed(1) + (book.ratingCount ? `（${fmtCount(book.ratingCount)} 人）` : "") : "暂无"}</span>
      </div>
      <div class="meta-chip">
        <span class="k">状态</span>
        <span class="v">${esc(statusLabel(book.status))}</span>
      </div>
      <div class="meta-chip" title="共几条笔记，其中几条是从微信读书同步过来的">
        <span class="k">笔记数</span>
        <span class="v accent">${(book.notes || []).length}${
          wxNoteCount(book) ? ` <em style="font-style:normal;font-size:11px;opacity:.7">· 微信 ${wxNoteCount(book)}</em>` : ""
        }</span>
      </div>
      <div class="meta-chip" data-edit="cat"
           title="点击修改分类（默认取微信读书的分类，改过之后以你指定的为准）" style="cursor:pointer;">
        <span class="k">分类 ✎</span>
        <span class="v">${esc(catLabel(book))}${book.catManual ? " <em style=\"font-style:normal;opacity:.6\">· 手工</em>" : ""}</span>
      </div>
    `;
  }

  /** 元信息条里可点的两项：首次阅读时间（微信读书没给）+ 书籍分类 */
  function bindFirstReadEdit(container, book, onChange) {
    const strip = $("#metaStrip", container);
    if (!strip) return;
    strip.addEventListener("click", async (e) => {
      /* ---- 首次阅读时间 ---- */
      const first = e.target.closest('[data-edit="first"]');
      if (first) {
        const cur = (book.firstReadTime || "").slice(0, 10);
        const input = await promptDialog({ title: "首次阅读日期", placeholder: "YYYY-MM-DD", value: cur });
        if (!input) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) { toast("日期格式应为 YYYY-MM-DD", "err"); return; }
        API.setFirstReadTime(book.bookId, input.trim() + " 00:00");
        strip.innerHTML = metaStripHTML(book);
        onChange && onChange();
        toast("首次阅读时间已更新", "ok");
        return;
      }
      /* ---- 分类 ---- */
      const cat = e.target.closest('[data-edit="cat"]');
      if (cat) {
        const picked = await catPickerDialog(book);
        if (picked === null) return;                 // 取消
        API.setBookCategory(book.bookId, picked);    // 空串 = 清掉手工指定，回到微信读书的分类
        strip.innerHTML = metaStripHTML(book);
        onChange && onChange();
        toast(picked ? `已归到「${picked}」` : "已恢复微信读书的分类", "ok");
      }
    });
  }

  /** 分类选择器：现成的分类点一下就用，也可以自己新建一个；还能还原成微信读书的分类 */
  function catPickerDialog(book) {
    return new Promise((resolve) => {
      const all = catStats(API.state.books).filter((c) => c.key !== NONE_CAT).map((c) => c.name);
      const cur = catName(book);
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      mask.innerHTML = `
        <div class="modal confirm-modal" role="dialog" aria-modal="true">
          <div class="modal__head"><h3>书籍分类</h3></div>
          <div class="modal__body">
            <div class="confirm-hint" style="margin-bottom:10px;">
              默认用微信读书的分类${book.group ? `（书架分组：${esc(book.group)}）` : ""}。改过之后以你指定的为准。
            </div>
            <div class="cat-picker">
              ${all.map((n) => `<button type="button" class="cat-chip${n === cur ? " is-on" : ""}" data-pick="${esc(n)}">${esc(n)}</button>`).join("") || '<span class="muted">还没有现成的分类，在下面新建一个</span>'}
            </div>
            <input class="prompt-input" id="catNew" rows="1" placeholder="或输入一个新分类，例如：心理学" value="">
          </div>
          <div class="modal__foot">
            <button class="btn btn-ghost" data-act="reset" type="button">恢复默认</button>
            <button class="btn btn-ghost" data-act="cancel" type="button">取消</button>
            <button class="btn btn-primary" data-act="ok" type="button">保存</button>
          </div>
        </div>`;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add("is-open"));

      const input = mask.querySelector("#catNew");
      const done = (v) => { document.removeEventListener("keydown", onKey); mask.remove(); resolve(v); };
      function onKey(e) {
        if (e.key === "Escape") done(null);
        if (e.key === "Enter") done((input.value || "").trim() || null);
      }
      const picker = mask.querySelector(".cat-picker");
      picker.addEventListener("click", (e) => {
        const b = e.target.closest ? e.target.closest("[data-pick]") : null;
        if (!b) return;
        done(b.getAttribute("data-pick") || "");
      });
      mask.querySelector('[data-act="ok"]').addEventListener("click", () => done((input.value || "").trim() || null));
      mask.querySelector('[data-act="cancel"]').addEventListener("click", () => done(null));
      mask.querySelector('[data-act="reset"]').addEventListener("click", () => done(""));
      mask.addEventListener("click", (e) => { if (e.target === mask) done(null); });
      document.addEventListener("keydown", onKey);
      setTimeout(() => { if (input) input.focus(); }, 40);
    });
  }

  /* ---- 文档 HTML 的读取 / 保存 ---- */
  function docKey(bookId) { return `weread.noteDoc.v1.${bookId}`; }
  function getDocHTML(book) {
    if (store.draftDoc[book.bookId] != null) return store.draftDoc[book.bookId];
    try {
      const saved = localStorage.getItem(docKey(book.bookId));
      if (saved) return saved;
    } catch (e) {}
    // 从结构化笔记生成初始文档
    if (book.notes && book.notes.length) {
      return book.notes.map((n) => {
        if (n.type === "highlight") return `<p><mark class="hl-yellow">${esc(n.text)}</mark></p>`;
        if (n.type === "underline") return `<p><u class="ul-solid">${esc(n.text)}</u></p>`;
        return `<div data-thought>“${esc(n.text)}”</div>`;
      }).join("");
    }
    return "";
  }
  function saveDocFallback(bookId, html) { /* 已由 API.saveNoteDoc 接管，保留兼容 */ }
  function markDirty(bookId) {
    store.dirty[bookId] = true;
    const annot = $("#annot");
    if (annot) store.draftDoc[bookId] = annot.innerHTML;
  }

  /* ---- 选中即落库为摘录卡片 ---- */
  function persistInline(book, type, text) {
    if (!text || !text.trim()) return;
    API.saveNote(book.bookId, { type, text: text.trim() });
    const list = $("#noteList");
    if (list) renderNoteList(list, book);
  }

  function refreshNoteList(wrap, book) {
    const list = $("#noteList", wrap);
    if (list) renderNoteList(list, book);
  }

  /* ---- 摘录卡片列表 ---- */
  function renderNoteList(host, book) {
    if (!host) return;
    host.innerHTML = "";
    const notes = book.notes || [];
    const counter = $("#noteCount");
    if (counter) counter.textContent = notes.length ? `共 ${notes.length} 条` : "";

    if (!notes.length) {
      host.innerHTML = `<div class="muted" style="text-align:center;padding:18px 0;font-size:12.5px;">还没有笔记，选中文字或点「＋ 新增摘录」开始吧。</div>`;
      return;
    }
    notes.forEach((n) => host.appendChild(noteCard(n, book, host)));
  }

  function noteCard(note, book, listHost) {
    const el = document.createElement("div");
    el.className = `note-item ${note.type}`;
    const tag = { highlight: "划线", underline: "下划线", thought: "个人想法" }[note.type] || note.type;
    const thought = String(note.comment || "").trim();   // 微信读书里写在划线下面的想法
    el.innerHTML = `
      <div class="note-item__meta">
        <span class="pill">${tag}</span>
        ${note.chapter ? `<span class="chap">· ${esc(note.chapter)}</span>` : ""}
        ${note.source === "weread" ? `<span class="src">· 来自微信读书</span>` : ""}
        ${thought ? `<span class="pill pill-thought">含想法</span>` : ""}
        <span style="margin-left:auto;">${esc(note.createdAt || "")}</span>
      </div>
      <div class="note-item__content">${note.type === "highlight"
        ? `<mark class="hl-yellow">${esc(note.text)}</mark>`
        : note.type === "underline"
          ? `<u class="ul-solid">${esc(note.text)}</u>`
          : `<span class="note-thought">“${esc(note.text)}”</span>`}</div>
      ${thought ? `<div class="note-item__thought">💭 “${esc(thought)}”</div>` : ""}
      <div class="note-item__actions">
        <button class="copy" title="复制">⎘</button>
        <button class="del" title="删除">×</button>
      </div>
    `;
    el.querySelector(".copy").addEventListener("click", (e) => {
      e.stopPropagation();
      const plain = [note.text, note.comment].filter((s) => s && String(s).trim()).join("\n");
      copyText(htmlToText(plain)).then((okFlag) => toast(okFlag ? "已复制文字" : "复制失败", okFlag ? "ok" : "err"));
    });
    el.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        await API.deleteNote(book.bookId, note.id);
        store.trash = await API.listTrash();
        renderNoteList(listHost || el.parentNode, book);
        updateNavBadges();
        document.dispatchEvent(new CustomEvent("notes-changed"));   // 「我的笔记」页据此刷新总账
        toast(note.source === "weread"
          ? "已移入「宝藏回收」；这条来自微信读书，下次同步笔记会重新拉回来"
          : "已移入「宝藏回收」，30 天内可还原", "ok");
      } catch (err) {
        toast("删除失败：" + (err && err.message ? err.message : "未知错误"), "err");
      }
    });
    return el;
  }

  /* =========================================================
   *  视图 1：书籍总览（点开 → 右侧抽屉）
   * ========================================================= */
  /**
   * 阅读统计看板（优化建议文档里的「统计看板」）。
   * 所有数字都来自本机现有数据，**没有的就不显示** —— 微信读书不提供
   * 「实际阅读天数」「读完日期」，所以这里只用「今年开始读」这种能算准的口径，
   * 不拿「首读到今天的天数」冒充「有效阅读天数」。
   */
  function statStripHTML() {
    const books = store.books || [];
    const st = API.noteStats ? API.noteStats() : { notes: 0, books: 0, wxNotes: 0 };
    const year = String(new Date().getFullYear());
    const yearOf = (t) => { if (!t) return ""; const d = new Date(t); return isNaN(d.getTime()) ? "" : String(d.getFullYear()); };
    const startedThisYear = books.filter((b) => yearOf(b.firstReadTime) === year).length;
    const finished = books.filter((b) => isFinished(b)).length;

    const cell = (k, v, unit, note) =>
      `<div class="stat-cell"><div class="k">${esc(k)}</div>` +
      `<div class="v">${esc(v)}<span class="u">${esc(unit || "")}</span></div>` +
      (note ? `<div class="s">${esc(note)}</div>` : "") + `</div>`;

    return cell("书架", books.length, "本")
      + cell("在读", books.filter((b) => b.status === "reading").length, "本")
      + cell("已读完", finished, "本")
      + cell("今年开读", startedThisYear, "本")
      + cell("笔记", st.notes || 0, "条", st.wxNotes ? `微信读书 ${st.wxNotes} 条` : "")
      + cell("宝藏", (store.treasures || []).length, "条");
  }

  function renderOverview(root) {
    const stat = (s) => store.books.filter((b) => b.status === s).length;
    const cats = catStats(filterBooks(store.books)).filter((c) => c.key !== NONE_CAT).length;

    root.innerHTML = `
      <div class="view-head">
        <div>
          <h3>书架总览</h3>
          <div class="sub">共 ${store.books.length} 本 · 在读 ${stat("reading")} · 已读 ${stat("finished")} · 未读 ${stat("unread")}${
            cats ? ` · ${cats} 个分类` : ""}</div>
        </div>
        <div class="view-head__tools">
          <select id="ovFilter" class="btn btn-ghost" style="font-size:12px;">
            <option value="all">全部状态</option>
            <option value="reading">在读</option>
            <option value="finished">已读</option>
            <option value="unread">未读</option>
          </select>
          <button class="btn btn-ghost" id="ovGroup" style="font-size:12px;"
                  title="按微信读书的分类分块显示">${store.groupByCat ? "▤ 平铺显示" : "▦ 按分类分组"}</button>
          <button class="btn btn-ghost" id="ovSync">⟳ 同步微信读书</button>
        </div>
      </div>
      <div class="stat-strip" id="ovStats">${statStripHTML()}</div>
      <div id="ovBar"></div>
      <div class="book-grid" id="ovGrid"></div>
    `;

    const grid = $("#ovGrid", root);
    const barHost = $("#ovBar", root);
    let statusFilter = "all";

    const repaint = () => {
      const base = statusFilter === "all"
        ? filterBooks(store.books)
        : store.books.filter((b) => b.status === statusFilter);
      // 选中的分类若在当前结果里一本都没有，就当成「全部」，避免莫名其妙空白
      const sel = catStats(base).some((s) => s.key === store.catFilter) ? store.catFilter : "";
      barHost.innerHTML = catBarHTML(base, sel);
      attachCatBar(barHost, repaint);
      const arr = sel ? base.filter((b) => catKey(b) === sel) : base;
      paintBookGrid(grid, arr, { groupBy: store.groupByCat && !sel });
    };
    repaint();

    $("#ovFilter", root).addEventListener("change", (e) => { statusFilter = e.target.value; repaint(); });
    $("#ovGroup", root).addEventListener("click", () => {
      store.groupByCat = !store.groupByCat;
      $("#ovGroup", root).textContent = store.groupByCat ? "▤ 平铺显示" : "▦ 按分类分组";
      repaint();
    });
    $("#ovSync", root).addEventListener("click", () => syncNow());
  }

  /** 这本书里有多少条笔记来自微信读书 */
  function wxNoteCount(book) {
    return (book.notes || []).filter((n) => n.source === "weread").length;
  }

  function bookCard(book, opts = {}) {
    const el = document.createElement("div");
    el.className = "book-card";
    const pct = pctOf(book);   // 已夹到 0~100
    el.innerHTML = `
      <div class="book-card__cover">
        <img src="${esc(book.cover)}" alt="${esc(book.title)}" data-title="${esc(book.title)}" loading="lazy"
             onerror="window.__coverFallback&&window.__coverFallback(this)">
        <div class="badge-status ${book.status}">${statusLabel(book.status)}</div>
      </div>
      <div class="book-card__body">
        <h4 class="book-card__title">${esc(book.title)}</h4>
        <div class="book-card__author">${esc(book.author)}</div>
        <div class="book-card__tags">
          <span class="tag tag-cat" data-cat="${esc(catKey(book))}" title="点击只看「${esc(catLabel(book))}」">${esc(catLabel(book))}</span>
          ${(book.notes || []).length
            ? `<span class="tag tag-note" title="已有 ${wxNoteCount(book)} 条来自微信读书">✎ ${(book.notes || []).length}</span>`
            : ""}
          ${book.ratingLabel ? `<span class="tag tag-label">${esc(book.ratingLabel)}</span>` : ""}
        </div>
        <div class="book-rate">${ratingHTML(book)}</div>
        ${book.status !== "unread" ? `
          <div class="book-progress"><div class="book-progress__bar" style="width:${pct}%"></div></div>
          <div class="book-progress__txt"><span>进度</span><span>${pct}%</span></div>
          <div class="book-card__notes-info">${readWhenHTML(book)}</div>
        ` : `<div class="book-card__notes-info">尚未开始</div>`}
      </div>
    `;
    el.addEventListener("click", (e) => {
      // 点分类标签 = 按这个分类筛选（不要顺手把抽屉打开）
      const tag = e.target.closest ? e.target.closest(".tag-cat") : null;
      if (tag) {
        e.stopPropagation();
        store.catFilter = tag.getAttribute("data-cat") || "";
        if (store.view !== "overview") { location.hash = "#/overview"; } else { render(); }
        return;
      }
      if (typeof opts.onClick === "function") { opts.onClick(book); return; }
      openDrawer(book.bookId);
    });
    return el;
  }

  /* =========================================================
   *  视图 2：我的在读（打开即见笔记）
   * ========================================================= */
  function renderReading(root) {
    // 在读按「最近阅读」倒序 —— 跟微信读书的书架排序一致，刚读过的排最前
    const list = filterBooks(
      store.books
        .filter((b) => b.status === "reading")
        .sort((a, b) => (b.lastReadTime || 0) - (a.lastReadTime || 0))
    );
    if (!list.length) {
      root.innerHTML = `
        <div class="view-head"><div><h3>我的在读</h3><div class="sub">暂时没有在读书籍</div></div>
          <div style="margin-left:auto;"><button class="btn btn-ghost" id="rdSync2">⟳ 同步微信读书</button></div>
        </div>
        <div class="empty"><div class="icon">📖</div><div>${
          store.books.length ? "暂时没有在读的书：去「我的未读」挑一本开始吧" : "还没有同步到书籍，点右上角「⟳ 同步微信读书」试试"
        }</div></div>`;
      const b = $("#rdSync2", root);
      if (b) b.addEventListener("click", () => syncNow());
      return;
    }
    // 默认打开第一本
    if (!store.activeReadingId || !list.some((b) => b.bookId === store.activeReadingId)) {
      store.activeReadingId = list[0].bookId;
    }
    const active = list.find((b) => b.bookId === store.activeReadingId);

    root.innerHTML = `
      <div class="view-head">
        <div>
          <h3>我的在读</h3>
          <div class="sub">共 ${list.length} 本进行中</div>
        </div>
        <div style="margin-left:auto;"><button class="btn btn-ghost" id="rdSync">⟳ 同步微信读书</button></div>
      </div>
      <div class="book-rail" id="rail"></div>
      <div id="readingWork"></div>
    `;

    const rail = $("#rail", root);
    list.forEach((b) => {
      const card = document.createElement("div");
      card.className = "rail-card" + (b.bookId === active.bookId ? " is-active" : "");
      const pct = pctOf(b);
      card.innerHTML = `
        <img src="${esc(b.cover)}" alt="${esc(b.title)}" data-title="${esc(b.title)}" onerror="window.__coverFallback&&window.__coverFallback(this)">
        <div class="rc-body">
          <h5>${esc(b.title)}</h5>
          <div class="p">${pct}% · ${b.rating ? "★ " + b.rating.toFixed(1) : "暂无评分"}</div>
        </div>
      `;
      card.addEventListener("click", () => {
        store.activeReadingId = b.bookId;
        render();
      });
      rail.appendChild(card);
    });

    const work = $("#readingWork", root);
    work.appendChild(readingHero(active));
    work.appendChild(buildNoteWorkspace(active, {
      onStatusChange: () => { updateNavBadges(); render(); }
    }));

    $("#rdSync", root).addEventListener("click", () => syncNow());
  }

  function readingHero(book) {
    const el = document.createElement("div");
    el.className = "reading-hero";
    const pct = Math.max(0, Math.min(100, Math.round(Number(book.progress) || 0)));
    el.innerHTML = `
      <img src="${esc(book.cover)}" alt="${esc(book.title)}" data-title="${esc(book.title)}" onerror="window.__coverFallback&&window.__coverFallback(this)">
      <div class="rh-body">
        <h3>${esc(book.title)}</h3>
        <div class="au">${esc(book.author)}${book.publisher ? " · " + esc(book.publisher) : ""}</div>
        <div class="rh-rate">${ratingHTML(book)}</div>
        <div class="meta-strip" style="margin-bottom:0;">
          <div class="meta-chip"><span class="k">${book.firstReadGuess ? "最近阅读" : "首次阅读"}</span><span class="v">${esc(fmtDate(book.firstReadTime))}</span></div>
          <div class="meta-chip"><span class="k">${book.firstReadGuess ? "距今" : "阅读天数"}</span><span class="v accent">${esc(fmtDays(book.readingDays))}</span></div>
          <div class="meta-chip"><span class="k">阅读进度</span><span class="v accent">${pct}%</span></div>
          <div class="meta-chip"><span class="k">笔记数</span><span class="v">${(book.notes || []).length}</span></div>
        </div>
      </div>
    `;
    return el;
  }

  /* =========================================================
   *  视图 3：我的未读（开启即转入在读）
   * ========================================================= */
  function renderTodo(root) {
    const list = filterBooks(store.books.filter((b) => b.status === "unread"));
    root.innerHTML = `
      <div class="view-head">
        <div>
          <h3>我的未读</h3>
          <div class="sub">共 ${list.length} 本待开启</div>
        </div>
        <div style="margin-left:auto;"><button class="btn btn-ghost" id="tdSync">⟳ 同步微信读书</button></div>
      </div>
      <div id="tdBar"></div>
      <div class="book-grid" id="tdGrid"></div>
    `;
    const grid = $("#tdGrid", root);
    const barHost = $("#tdBar", root);
    const repaint = () => {
      const sel = catStats(list).some((s) => s.key === store.catFilter) ? store.catFilter : "";
      barHost.innerHTML = catBarHTML(list, sel);
      attachCatBar(barHost, repaint);
      const arr = sel ? list.filter((b) => catKey(b) === sel) : list;
      paintBookGrid(grid, arr, { makeCard: todoCard, emptyText: "未读列表空空如也" });
    };
    if (list.length) repaint();
    else grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="icon">🎉</div><div>未读列表空空如也</div></div>`;
    $("#tdSync", root).addEventListener("click", () => syncNow());
  }

  /* =========================================================
   *  视图 3：我的读完（进度 100% 的书）
   * ========================================================= */
  function renderDone(root) {
    // 读完 = 进度到 100%；按「最近阅读」倒序，刚读完的排最前
    const list = filterBooks(
      store.books
        .filter(isFinished)
        .sort((a, b) => (b.lastReadTime || 0) - (a.lastReadTime || 0))
    );

    // 平均分只统计真有评分的书，没有就干脆不显示，不编一个数
    const rated = list.filter((b) => Number(b.rating) > 0);
    const avg = rated.length
      ? (rated.reduce((s, b) => s + Number(b.rating), 0) / rated.length).toFixed(1)
      : "";

    root.innerHTML = `
      <div class="view-head">
        <div>
          <h3>我的读完</h3>
          <div class="sub">共 ${list.length} 本已读完${avg ? ` · 平均 ${avg} 分（${rated.length} 本有评分）` : ""}</div>
        </div>
        <div style="margin-left:auto;"><button class="btn btn-ghost" id="dnSync">⟳ 同步微信读书</button></div>
      </div>
      <div id="dnBar"></div>
      <div class="book-grid" id="dnGrid"></div>
    `;

    const grid = $("#dnGrid", root);
    const barHost = $("#dnBar", root);
    if (!list.length) {
      grid.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="icon">🏁</div><div>${
        store.books.length ? "还没有进度到 100% 的书，读完一本就会出现在这里" : "还没有同步到书籍，点右上角「⟳ 同步微信读书」试试"
      }</div></div>`;
    } else {
      const repaint = () => {
        const sel = catStats(list).some((s) => s.key === store.catFilter) ? store.catFilter : "";
        barHost.innerHTML = catBarHTML(list, sel);
        attachCatBar(barHost, repaint);
        const arr = sel ? list.filter((b) => catKey(b) === sel) : list;
        paintBookGrid(grid, arr, { makeCard: doneCard });
      };
      repaint();
    }
    $("#dnSync", root).addEventListener("click", () => syncNow());
  }

  /** 读完卡 = 通用书卡 + 一行笔记条数（时间/评分/进度书卡里已有，这里不重复） */
  function doneCard(book) {
    const card = bookCard(book);
    const n = (book.notes || []).length;
    if (!n) return card;
    const info = document.createElement("div");
    info.className = "book-card__notes-info";
    info.style.marginTop = "2px";
    info.innerHTML = `笔记 ${n} 条 · 点开可回看`;
    card.querySelector(".book-card__body").appendChild(info);
    return card;
  }

  function todoCard(book) {
    const card = bookCard(book, {
      onClick: () => {
        store.activeReadingId = book.bookId;
        location.hash = "#/reading";
        if (location.hash === "#/reading") render();
      }
    });
    const body = card.querySelector(".book-card__body");

    /* 评分已经在 bookCard 里统一渲染（星级 + 分数 + 评价数），这里只补评论 */
    const reviews = (book.reviews || []).slice(0, 2);
    if (reviews.length) {
      const rw = document.createElement("div");
      rw.style.cssText = "margin-top:8px;font-size:11.5px;color:#5a5a5a;";
      rw.innerHTML = `<div style="margin-bottom:4px;color:#9a958c;font-size:11px;">读者评论（${(book.reviews || []).length}）</div>` +
        reviews.map((r) => `
          <div style="border-left:2px solid #e7e3d8;padding:4px 8px;margin-bottom:4px;background:#f8f6f1;border-radius:0 6px 6px 0;">
            <span style="color:#11907a;font-weight:600">${esc(r.user)}：</span>
            <span>${esc(r.content.length > 34 ? r.content.slice(0, 34) + "…" : r.content)}</span>
          </div>`).join("");
      body.appendChild(rw);
    }

    // 开始阅读按钮 → 自动流转到在读
    const btn = document.createElement("button");
    btn.className = "btn btn-primary";
    btn.style.cssText = "margin-top:10px;align-self:flex-start;";
    btn.textContent = "▶ 开始阅读";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await API.startReading(book.bookId);
      updateNavBadges();
      toast(`《${book.title}》已移入「我的在读」`, "ok");
      store.activeReadingId = book.bookId;
      render();
    });
    body.appendChild(btn);
    return card;
  }

  /* =========================================================
   *  视图 4：我的宝藏（自定义分类 · 单一新建入口）
   * ========================================================= */
  /* =========================================================
   *  视图：我的笔记（全部划线 / 想法，按书分组）
   *
   *  为什么单独做一页？
   *    「笔记同步到了没有」在书卡上是看不出来的 —— 只有点开抽屉才看得到几本书。
   *    这一页把**所有书的所有笔记**摊平列出，顶部给出总账（条数 / 本数 / 上次同步），
   *    用户可以直接跟微信读书「我的」页上的「1474 个笔记 · 97 本书」对数字。
   * ========================================================= */
  const NOTE_PREVIEW = 6;      // 每本书先露 6 条，剩下的点「展开」

  function noteMatches(note, book, kw) {
    if (!kw) return true;
    return [note.text, note.comment, note.chapter, book.title, book.author]
      .some((f) => String(f || "").toLowerCase().includes(kw));
  }

  function renderNotes(root) {
    const stat = API.noteStats();
    const books = (store.books || []).filter((b) => (b.notes || []).length);
    const offTxt = stat.official && stat.official !== stat.notes
      ? ` · 微信读书口径 ${stat.official} 条` : "";

    root.innerHTML = `
      <div class="view-head">
        <div>
          <h3>我的笔记</h3>
          <div class="sub" id="ntSub">共 ${stat.notes} 条 · 覆盖 ${stat.books} 本书${offTxt}${
            stat.wxNotes ? ` · 微信读书 ${stat.wxNotes} 条` : ""
          }</div>
        </div>
        <div class="notes-actions">
          <button class="btn btn-ghost" id="ntFill" title="只重新拉取「本机还没有笔记」的书，比全量同步快">↻ 补同步</button>
          <button class="btn btn-primary" id="ntSync">⟳ 同步全部笔记</button>
        </div>
      </div>

      <div class="notes-ledger" id="ntLedger"></div>

      <div class="notes-search">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="ntSearch" placeholder="在笔记里搜索：原文 / 想法 / 章节 / 书名…" value="${esc(store.noteKeyword || "")}">
      </div>

      <div class="cat-bar notes-src" id="ntSrc"></div>

      <div id="ntList" class="notes-list"></div>
    `;

    /* ---- 对账行：把「上次同步干了什么」写清楚 ---- */
    const ledger = $("#ntLedger", root);
    if (!API.state.connected) {
      ledger.className = "notes-ledger is-demo";
      ledger.innerHTML = IS_SHOWCASE
        ? `这是<b>展示版</b>，笔记为示例数据：接入自己的微信读书后，书架里每本书的划线 / 想法都会被拉下来，按书归档、可搜索。`
        : `当前是<b>演示模式</b>：连上微信读书后，书架里每一本书的划线 / 想法都会被拉下来并按书归档。`;
    } else if (!stat.at) {
      ledger.className = "notes-ledger is-warn";
      ledger.innerHTML = `还没有同步过笔记。点右上角<b>「⟳ 同步全部笔记」</b>开始 —— ${
        books.length ? `会逐本扫描 ${store.books.length} 本书。` : "先同步书架。"
      }`;
    } else {
      const d = new Date(stat.at);
      const p = (n) => String(n).padStart(2, "0");
      const when = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
      const fail = (stat.failed || []).length;
      ledger.className = "notes-ledger" + (fail ? " is-warn" : "");
      ledger.innerHTML = `上次同步 <b>${when}</b> · 扫描 ${stat.scanned || 0} 本 · 命中 <b>${stat.books}</b> 本 / <b>${stat.notes}</b> 条` +
        (fail ? ` · <span class="warn">${fail} 本没取到</span>（点「补同步」再试）` : "") +
        `<span class="tip">官方总数按「划线 + 想法」分别计数；这里按卡片计数（一条划线带想法算 1 条），略少是正常的。</span>`;
    }

    /* ---- 列表：搜索只重画列表，不整页重渲染（否则输入框会丢焦点） ---- */
    const listHost = $("#ntList", root);
    let kw = (store.noteKeyword || "").toLowerCase();

    /* ---- 来源筛选：区分「摘抄原文」和「我的想法 / AI 产出」，也区分来源 ---- */
    const SRC = [
      { k: "all", name: "全部" },
      { k: "quote", name: "摘抄" },
      { k: "thought", name: "想法" },
      { k: "weread", name: "来自微信读书" },
      { k: "local", name: "本地手写" }
    ];
    const srcHost = $("#ntSrc", root);
    const paintSrc = () => {
      srcHost.innerHTML = SRC.map((s) =>
        `<button type="button" class="cat-chip${store.noteSrc === s.k ? " is-on" : ""}" data-src="${s.k}">${esc(s.name)}</button>`
      ).join("");
    };
    srcHost.addEventListener("click", (e) => {
      const btn = e.target.closest ? e.target.closest(".cat-chip") : null;
      if (!btn) return;
      const k = btn.getAttribute("data-src");
      if (!k) return;
      store.noteSrc = k;
      paintSrc();
      paint();
    });
    paintSrc();

    /**
     * 笔记是否命中当前的来源筛选。
     * 「摘抄」= 有原文且不是纯想法；「想法」= type 是 thought 或带 comment。
     * 一条划线下面写了想法（微信读书的 mixed）两边都算 —— 它本来就有两种成分。
     */
    const noteSrcHit = (n) => {
      const hasText = !!String(n.text || "").replace(/<[^>]*>/g, "").trim();
      switch (store.noteSrc) {
        case "quote":   return hasText && n.type !== "thought";
        case "thought": return n.type === "thought" || !!String(n.comment || "").trim();
        case "weread":  return n.source === "weread";
        case "local":   return n.source !== "weread";
        default:        return true;
      }
    };
    const srcOn = () => store.noteSrc && store.noteSrc !== "all";

    const paint = () => {
      // 本地检索（BM25，离线计算）：按相关度筛 + 排序；没命中时内部会回退到子串匹配
      const base = books
        .map((b) => ({ book: b, notes: (b.notes || []).filter(noteSrcHit) }))
        .filter((g) => g.notes.length);

      const groups = window.LOCAL_SEARCH
        ? window.LOCAL_SEARCH.rankNoteGroups(base, kw)
        : base
            .map((b) => ({ book: b.book, notes: b.notes.filter((n) => noteMatches(n, b.book, kw)) }))
            .filter((g) => g.notes.length)
            .sort((a, b) => b.notes.length - a.notes.length);

      const total = groups.reduce((s, g) => s + g.notes.length, 0);
      const srcName = (SRC.find((s) => s.k === store.noteSrc) || {}).name || "";
      $("#ntSub", root).textContent = (kw || srcOn())
        ? `筛选出 ${total} 条 · 来自 ${groups.length} 本书（共 ${stat.notes} 条${srcOn() ? " · " + srcName : ""}）`
        : `共 ${stat.notes} 条 · 覆盖 ${stat.books} 本书${offTxt}${stat.wxNotes ? ` · 微信读书 ${stat.wxNotes} 条` : ""}`;

      listHost.innerHTML = "";
      if (!groups.length) {
        listHost.innerHTML = `<div class="empty">
          <div class="icon">✍️</div>
          <div>${kw ? `没有匹配「${esc(kw)}」的笔记`
            : srcOn() ? `没有「${esc(srcName)}」类型的笔记，换个筛选看看`
            : (API.state.connected
              ? "还没有笔记：点右上角「⟳ 同步全部笔记」，把微信读书里的划线和想法拉进来"
              : "演示模式没有同步笔记，连上微信读书后才能看到你的全部笔记")}</div>
        </div>`;
        return;
      }
      groups.forEach((g) => listHost.appendChild(noteGroupEl(g.book, g.notes, kw)));
    };

    $("#ntSearch", root).addEventListener("input", debounce((e) => {
      kw = e.target.value.trim().toLowerCase();
      store.noteKeyword = e.target.value;
      paint();
    }));

    $("#ntSync", root).addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      await syncNotes();
      btn.disabled = false;
      if (store.view === "notes") render();
    });
    $("#ntFill", root).addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      await syncNotes({ onlyMissing: true });
      btn.disabled = false;
      if (store.view === "notes") render();
    });

    paint();
  }

  /** 一本书 = 一张分组卡（书头 + 笔记列表 + 展开更多） */
  function noteGroupEl(book, notes, kw) {
    const wrap = document.createElement("section");
    wrap.className = "note-group";

    const head = document.createElement("div");
    head.className = "note-group__head";
    head.innerHTML = `
      <img class="note-group__cover" src="${esc(book.cover)}" alt="${esc(book.title)}"
           data-title="${esc(book.title)}" loading="lazy"
           onerror="window.__coverFallback&&window.__coverFallback(this)">
      <div class="note-group__meta">
        <div class="note-group__title">${esc(book.title)}
          <span class="note-group__cnt">${notes.length} 条</span>
        </div>
        <div class="note-group__sub">${esc(book.author || "未知作者")}${
          book.category ? ` · ${esc(book.category)}` : ""
        }${book.status ? ` · ${esc(statusLabel(book.status))}` : ""}</div>
      </div>
      <button class="btn btn-ghost note-group__open">打开这本书 →</button>
    `;
    head.querySelector(".note-group__open").addEventListener("click", () => openDrawer(book.bookId));
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "note-list note-group__body";
    wrap.appendChild(body);

    const paint = () => {
      body.innerHTML = "";
      const open = !!store.noteOpenAll[book.bookId];
      const shown = open ? notes : notes.slice(0, NOTE_PREVIEW);
      shown.forEach((n) => body.appendChild(noteCard(n, book, body)));

      const rest = notes.length - shown.length;
      if (rest > 0 || (open && notes.length > NOTE_PREVIEW)) {
        const btn = document.createElement("button");
        btn.className = "note-more";
        btn.textContent = rest > 0 ? `展开剩余 ${rest} 条 ▾` : `收起 ▴`;
        btn.addEventListener("click", () => {
          store.noteOpenAll[book.bookId] = !open;
          paint();
        });
        body.appendChild(btn);
      }
    };
    paint();
    return wrap;
  }

  function renderTreasure(root) {
    const all = store.treasures;
    const cats = store.tcats || [];
    const cur = store.tFilter || "all";
    const countOf = (id) => id === "all"
      ? all.length
      : id === "uncat"
        ? all.filter((t) => !t.category).length
        : all.filter((t) => t.category === id).length;

    root.innerHTML = `
      <div class="view-head">
        <div>
          <h3>我的宝藏</h3>
          <div class="sub">共 ${all.length} 条 · ${cats.length} 个分类</div>
        </div>
        <div style="margin-left:auto;display:flex;gap:8px;">
          <button class="btn btn-ghost" id="tNewCat">＋ 新建分类</button>
          <button class="btn btn-primary" id="tNew">＋ 新建宝藏</button>
        </div>
      </div>
      <div class="cat-bar" id="catBar"></div>
      <div id="tFormSlot"></div>
      <div class="treasure-wrap" id="tList"></div>
    `;

    /* ---------- 分类胶囊 ---------- */
    const bar = $("#catBar", root);
    function chip(id, label, n, closable) {
      const el = document.createElement("div");
      el.className = "cat-chip" + (cur === id ? " is-active" : "");
      el.dataset.cat = id;
      el.innerHTML = `<span class="cn">${esc(label)}</span><span class="cc">${n}</span>`
        + (closable ? `<button class="cat-edit" title="重命名">✎</button><button class="cat-del" title="删除分类">×</button>` : "");
      el.addEventListener("click", (e) => {
        if (e.target.closest(".cat-edit") || e.target.closest(".cat-del")) return;
        store.tFilter = id;
        render();
      });
      if (closable) {
        el.querySelector(".cat-edit").addEventListener("click", async (e) => {
          e.stopPropagation();
          const name = await promptDialog({ title: "重命名分类", value: label, placeholder: "分类名称" });
          if (!name) return;
          await API.renameCategory(id, name);
          store.tcats = await API.listCategories();
          render();
          toast("分类已重命名", "ok");
        });
        el.querySelector(".cat-del").addEventListener("click", async (e) => {
          e.stopPropagation();
          const yes = await confirmDialog({
            title: "删除分类",
            message: `删除分类「${label}」？`,
            hint: `该分类下的 ${n} 条内容不会被删除，会自动归入「未分类」。`,
            okText: "删除分类",
            danger: true
          });
          if (!yes) return;
          await API.removeCategory(id);
          store.tcats = await API.listCategories();
          store.treasures = await API.listTreasures();
          if (store.tFilter === id) store.tFilter = "all";
          render();
          toast("分类已删除", "ok");
        });
      }
      return el;
    }
    bar.appendChild(chip("all", "全部", countOf("all"), false));
    cats.forEach((c) => bar.appendChild(chip(c.id, c.name, countOf(c.id), true)));
    if (countOf("uncat")) bar.appendChild(chip("uncat", "未分类", countOf("uncat"), false));

    $("#tNewCat", root).addEventListener("click", async () => {
      const name = await promptDialog({ title: "新建分类", placeholder: "例如：金句摘抄 / 读书方法" });
      if (!name) return;
      const c = await API.addCategory(name);
      store.tcats = await API.listCategories();
      if (c) store.tFilter = c.id;
      render();
      toast("分类已创建", "ok");
    });

    /* ---------- 列表：全部 → 按分类分组；单类 → 直接列出 ---------- */
    const host = $("#tList", root);
    const shown = cur === "all"
      ? all
      : cur === "uncat"
        ? all.filter((t) => !t.category)
        : all.filter((t) => t.category === cur);

    if (!shown.length) {
      host.innerHTML = `<div class="empty"><div class="icon">🗒️</div><div>${all.length ? "这个分类下还没有内容" : "还没有宝藏，点右上角「＋ 新建宝藏」收藏第一条吧"}</div></div>`;
    } else if (cur === "all") {
      const groups = cats.map((c) => ({ id: c.id, name: c.name, items: all.filter((t) => t.category === c.id) }));
      const rest = all.filter((t) => !t.category || !cats.some((c) => c.id === t.category));
      if (rest.length) groups.push({ id: "uncat", name: "未分类", items: rest });
      groups.filter((g) => g.items.length).forEach((g) => {
        const sec = document.createElement("section");
        sec.className = "cat-group";
        sec.innerHTML = `<div class="cat-group__head"><span class="dot"></span><h4>${esc(g.name)}</h4><span class="n">${g.items.length}</span></div>`;
        const box = document.createElement("div");
        box.className = "treasure-list";
        g.items.forEach((t) => box.appendChild(treasureCard(t, openComposer)));
        sec.appendChild(box);
        host.appendChild(sec);
      });
    } else {
      const box = document.createElement("div");
      box.className = "treasure-list";
      shown.forEach((t) => box.appendChild(treasureCard(t, openComposer)));
      host.appendChild(box);
    }

    const slot = $("#tFormSlot", root);
    function openComposer(initial) {
      slot.innerHTML = "";
      const preset = (!initial && cur !== "all" && cur !== "uncat") ? cur : "";
      const f = treasureComposer(initial, () => render(), preset);
      slot.appendChild(f);
      if (typeof f.scrollIntoView === "function") {
        try { f.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (e) {}
      }
    }
    $("#tNew", root).addEventListener("click", () => {
      if (slot.querySelector(".treasure-composer")) { slot.innerHTML = ""; return; }
      openComposer(null);
    });
  }

  /* ---- 分类下拉菜单（点卡片上的分类标签即可快速改归类）---- */
  function openCatMenu(anchor, currentId, onPick) {
    const old = $(".cat-menu");
    if (old) old.remove();
    const menu = document.createElement("div");
    menu.className = "cat-menu";
    const items = [{ id: "", name: "未分类" }].concat(store.tcats || []);
    menu.innerHTML = items.map((c) =>
      `<div class="cat-menu__item${c.id === currentId ? " is-on" : ""}" data-id="${esc(c.id)}">${esc(c.name)}</div>`
    ).join("") + `<div class="cat-menu__item is-new" data-new="1">＋ 新建分类…</div>`;
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 10)) + "px";
    menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 10) + "px";

    function close() {
      if (!menu.isConnected) return;
      menu.remove();
      document.removeEventListener("mousedown", onDoc, true);
      document.removeEventListener("keydown", onKey);
    }
    function onDoc(e) {
      if (menu.contains(e.target) || e.target === anchor) return;
      close();
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    // 用 mousedown（捕获）判断「点到外面了」，这样不会干扰菜单项自己的 click
    setTimeout(() => {
      document.addEventListener("mousedown", onDoc, true);
      document.addEventListener("keydown", onKey);
    }, 0);

    /* 用 mousedown 触发选择：比 click 更稳（不受关闭逻辑/焦点变化影响） */
    menu.addEventListener("mousedown", async (e) => {
      const it = e.target.closest(".cat-menu__item");
      if (!it) return;
      e.preventDefault();
      e.stopPropagation();
      if (it.dataset.new) {
        const name = await promptDialog({ title: "新建分类", placeholder: "分类名称" });
        close();
        if (!name) return;
        const c = await API.addCategory(name);
        store.tcats = await API.listCategories();
        onPick(c ? c.id : "");
        return;
      }
      close();
      onPick(it.dataset.id);
    });
  }

  /* ---- 宝藏条目：分类标签 + 图文 + 想法 + 图片下载 ---- */
  function treasureCard(t, onEdit) {
    const el = document.createElement("article");
    el.className = "treasure-item";
    const nameBase = t.title || "treasure";
    el.innerHTML = `
      <div class="ti-accent" style="background:${esc(t.color || "#1aad8f")}"></div>
      <div class="ti-main">
        <div class="ti-top">
          <h5 class="${t.title ? "" : "ti-untitled"}">${esc(t.title || "未命名")}</h5>
          <button class="ti-cat${t.category ? "" : " is-none"}" type="button" title="点击更改分类">${esc(catName(t.category))}</button>
        </div>
        ${t.image ? `<img class="ti-img" src="${esc(t.image)}" alt="" data-name="${esc(nameBase)}">` : ""}
        <div class="ti-content annotatable" data-annotatable>${t.content || ""}</div>
        <div class="ti-meta"><span class="ti-date">${esc(t.createdAt || "")}</span></div>
      </div>
      <div class="ti-actions">
        <button class="ti-btn edit" title="编辑">✎</button>
        <button class="ti-btn copy" title="复制文字（只复制纯文字）">⎘</button>
        <button class="ti-btn del" title="删除（移入宝藏回收，30 天内可还原）">🗑</button>
      </div>
    `;

    const contentEl = el.querySelector(".ti-content");

    /* 保存正文 */
    async function persist() {
      await API.updateTreasure(t.id, { content: contentEl.innerHTML });
    }

    /* 选中标注：点一下加、再点一下取消；「取消标注」一键清 */
    attachTreasureToolbar(contentEl, async (action, payload) => {
      if (action === "mark") {
        await persist();
        toast(payload && payload.tag === "u" ? "已加下划线" : "已加高亮", "ok");
      } else if (action === "clear") {
        await persist();
        toast("已取消标注");
      } else if (action === "copy") {
        const txt = (payload && payload.text) || window.getSelection().toString();
        copyText(txt).then((okFlag) => toast(okFlag ? "已复制选中文字" : "复制失败", okFlag ? "ok" : "err"));
      } else if (action === "thought") {
        const txt = await promptDialog({
          title: "添加想法",
          placeholder: "写下你的想法…",
          value: (payload && payload.text) || ""
        });
        if (!txt) return;
        contentEl.insertAdjacentHTML("beforeend", thoughtHTML(txt));
        ensureContentUI(contentEl, nameBase);
        await persist();
        toast("想法已添加", "ok");
      }
    });

    /* 装饰：图片下载按钮 + 想法删除按钮，并接管它们的点击 */
    ensureContentUI(el, nameBase);
    bindContentActions(el, (why) => {
      persist().then(() => { if (why === "thought-deleted") toast("想法已删除", "ok"); });
    });

    /* 分类标签 → 快速改归类 */
    el.querySelector(".ti-cat").addEventListener("click", (e) => {
      e.stopPropagation();
      openCatMenu(e.currentTarget, t.category || "", async (cid) => {
        await API.updateTreasure(t.id, { category: cid });
        store.treasures = await API.listTreasures();
        render();
        toast("已移到「" + catName(cid) + "」", "ok");
      });
    });

    /* 删除 → 宝藏回收 */
    el.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        await API.deleteTreasure(t.id);
        store.treasures = await API.listTreasures();
        store.trash = await API.listTrash();
        updateNavBadges();
        render();
        toast("已移入「宝藏回收」，30 天内可还原", "ok");
      } catch (err) {
        toast("删除失败：" + (err && err.message ? err.message : "未知错误"), "err");
      }
    });

    /* 复制：只把文字放进剪贴板（不是新建副本） */
    el.querySelector(".copy").addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const plain = [t.title, htmlToText(contentEl.innerHTML)].filter((s) => s && s.trim()).join("\n").trim();
      if (!plain) { toast("这条宝藏没有文字可复制", "err"); return; }
      const okFlag = await copyText(plain);
      toast(okFlag ? "已复制文字" : "复制失败：请手动选中后复制", okFlag ? "ok" : "err");
    });

    el.querySelector(".edit").addEventListener("click", (e) => {
      e.stopPropagation();
      onEdit && onEdit(t);
    });

    return el;
  }

  /* =========================================================
   *  全局唯一的划选浮层
   *  任何 .annotatable 区域里选中文字都会弹出「这一个」浮层，
   *  具体动作由宿主元素的 _onAnnotate 回调处理。
   *  只有一个浮层 → 绝不会出现两个框叠在一起。
   * ========================================================= */
  let globalToolbar = null;
  function ensureGlobalToolbar() {
    if (globalToolbar) return globalToolbar;
    globalToolbar = window.Annotate.createSelectionToolbar({
      selector: ".annotatable",
      onAction: (action, payload) => {
        const host = payload && payload.host;
        if (host && typeof host._onAnnotate === "function") host._onAnnotate(action, payload || {});
      }
    });
    return globalToolbar;
  }
  /** 关掉浮层（切换视图 / 关闭抽屉时调用） */
  function destroyTreasureToolbars() {
    if (globalToolbar) globalToolbar.hide();
  }
  /** 给一个可标注区域绑定回调（浮层是全局的，只是换个回调） */
  function attachTreasureToolbar(host, onAction) {
    if (!host) return null;
    host._onAnnotate = (action, payload) => onAction(action, payload || {});
    return ensureGlobalToolbar();
  }

  /* ---- 宝藏编辑器：打字 / 粘贴 二合一 ---- */
  const COLORS = ["#1aad8f", "#2f6fb5", "#8a5a2b", "#6b4fa8", "#b5563f", "#3f7d4e"];

  function readImageFile(file) {
    return new Promise((resolve) => {
      if (!file || !file.type || !file.type.startsWith("image/")) { resolve(""); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve("");
      reader.readAsDataURL(file);
    });
  }

  function caretRangeIn(container) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (container.contains(r.commonAncestorContainer)) return r;
    }
    const r = document.createRange();
    r.selectNodeContents(container);
    r.collapse(false);
    return r;
  }

  function placeCaretAfter(node) {
    if (!node) return;
    const sel = window.getSelection();
    const r = document.createRange();
    r.setStartAfter(node);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  function insertImageAtCaret(container, src, nameBase) {
    container.focus();
    const range = caretRangeIn(container);
    range.deleteContents();
    const wrap = document.createElement("span");
    wrap.className = "img-wrap";
    const img = document.createElement("img");
    img.src = src;
    img.className = "tc-img";
    wrap.appendChild(img);
    wrap.appendChild(imgDownloadBtn(src, nameBase));
    range.insertNode(wrap);
    placeCaretAfter(wrap);
    container.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function insertTextAtCaret(container, text) {
    container.focus();
    const range = caretRangeIn(container);
    range.deleteContents();
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const frag = document.createDocumentFragment();
    lines.forEach((ln, i) => {
      if (i) frag.appendChild(document.createElement("br"));
      frag.appendChild(document.createTextNode(ln));
    });
    const last = frag.lastChild;
    range.insertNode(frag);
    placeCaretAfter(last);
    container.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function treasureComposer(initial, onDone, presetCat) {
    const isEdit = !!(initial && initial.id);
    const data = initial || { title: "", content: "", image: "", color: COLORS[0], category: presetCat || "" };
    let color = data.color || COLORS[0];
    let image = data.image || "";
    let category = data.category || presetCat || "";

    const f = document.createElement("div");
    f.className = "treasure-composer";
    f.innerHTML = `
      <div class="tc-head">
        <span class="tc-badge">${isEdit ? "编辑宝藏" : "新建宝藏"}</span>
        <button class="tc-close" type="button" title="收起">×</button>
      </div>
      <input class="tc-title" placeholder="标题（可选）" value="${esc(data.title || "")}">
      <div class="tc-content annotatable" id="tcContent" contenteditable="true"
           data-placeholder="在这里写点什么，也可以直接粘贴文字或图片…">${data.content || ""}</div>
      <div class="tc-foot">
        <div class="tc-cat-row">
          <select class="tc-cat" id="tcCat" title="选择分类"></select>
          <button class="btn btn-ghost" id="tcNewCat" type="button" title="新建分类">＋</button>
        </div>
        <div class="tc-swap">
          ${COLORS.map((c) => `<span data-color="${c}" style="background:${c}${c === color ? ";box-shadow:0 0 0 2px #fff,0 0 0 3px " + c : ""}"></span>`).join("")}
        </div>
        <button class="btn btn-ghost" id="tcImg" type="button">🖼️ 插入图片</button>
        <input type="file" accept="image/*" hidden>
        <div class="tc-actions">
          <button class="btn btn-ghost" id="tcCancel" type="button">取消</button>
          <button class="btn btn-primary" id="tcSave" type="button">${isEdit ? "保存修改" : "保存"}</button>
        </div>
      </div>
    `;

    const nameBase = data.title || "treasure";
    const contentEl = $("#tcContent", f);
    ensureContentUI(contentEl, nameBase);
    bindContentActions(contentEl, () => {});

    /* ---- 分类选择 ---- */
    const catSel = $("#tcCat", f);
    function fillCats() {
      const cats = store.tcats || [];
      catSel.innerHTML = `<option value="">未分类</option>` +
        cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("");
      catSel.value = category || "";
    }
    fillCats();
    catSel.addEventListener("change", () => { category = catSel.value; });
    $("#tcNewCat", f).addEventListener("click", async () => {
      const name = await promptDialog({ title: "新建分类", placeholder: "分类名称" });
      if (!name) return;
      const c = await API.addCategory(name);
      store.tcats = await API.listCategories();
      if (c) category = c.id;
      fillCats();
      toast("分类已创建", "ok");
    });

    /* ---- 选区标注 ---- */
    attachTreasureToolbar(contentEl, async (action, payload) => {
      if (action === "mark" || action === "clear") {
        /* 编辑器里直接改 DOM，保存时随 innerHTML 一起落盘，无需额外动作 */
        return;
      }
      if (action === "copy") {
        const txt = (payload && payload.text) || window.getSelection().toString();
        copyText(txt).then((okFlag) => toast(okFlag ? "已复制选中文字" : "复制失败", okFlag ? "ok" : "err"));
      } else if (action === "thought") {
        const txt = await promptDialog({
          title: "添加想法",
          placeholder: "写下你的想法…",
          value: (payload && payload.text) || ""
        });
        if (!txt) return;
        contentEl.insertAdjacentHTML("beforeend", thoughtHTML(txt));
        ensureContentUI(contentEl, nameBase);
      }
    });

    f.querySelectorAll(".tc-swap span").forEach((sw) => {
      sw.addEventListener("click", () => {
        color = sw.dataset.color;
        f.querySelectorAll(".tc-swap span").forEach((s) => { s.style.boxShadow = "none"; });
        sw.style.boxShadow = `0 0 0 2px #fff, 0 0 0 3px ${color}`;
      });
    });

    /* 粘贴：图片直接插入正文；文字若焦点不在正文则手动落进去 */
    f.addEventListener("paste", async (e) => {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd) return;
      const items = cd.items || [];
      for (const it of items) {
        if (it.type && it.type.startsWith("image/")) {
          e.preventDefault();
          const src = await readImageFile(it.getAsFile());
          if (src) insertImageAtCaret(contentEl, src, $(".tc-title", f).value.trim() || "treasure");
          return;
        }
      }
      if (document.activeElement !== contentEl) {
        const txt = cd.getData("text/plain");
        if (txt) { e.preventDefault(); insertTextAtCaret(contentEl, txt); }
      }
    });

    const fileInput = $("input[type=file]", f);
    $("#tcImg", f).addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (e) => {
      const src = await readImageFile(e.target.files[0]);
      if (src) insertImageAtCaret(contentEl, src, $(".tc-title", f).value.trim() || "treasure");
      fileInput.value = "";
    });
    f.addEventListener("dragover", (e) => { e.preventDefault(); f.classList.add("is-drag"); });
    f.addEventListener("dragleave", () => f.classList.remove("is-drag"));
    f.addEventListener("drop", async (e) => {
      e.preventDefault(); f.classList.remove("is-drag");
      const src = await readImageFile(e.dataTransfer.files[0]);
      if (src) insertImageAtCaret(contentEl, src, $(".tc-title", f).value.trim() || "treasure");
    });

    $(".tc-close", f).addEventListener("click", () => f.remove());
    $("#tcCancel", f).addEventListener("click", () => { f.remove(); onDone && onDone(); });
    $("#tcSave", f).addEventListener("click", async () => {
      const title = $(".tc-title", f).value.trim();
      const content = contentEl.innerHTML.trim();
      const hasText = contentEl.textContent.trim().length > 0;
      const hasImg = !!contentEl.querySelector("img") || !!image;
      if (!hasText && !hasImg) { toast("写点什么，或粘贴一张图片", "err"); return; }
      // 标题改了 → 同步图片下载名
      ensureContentUI(contentEl, title || "treasure");
      if (isEdit) {
        await API.updateTreasure(initial.id, { title, content, image, color, category });
        toast("已保存修改", "ok");
      } else {
        await API.addTreasure({ title, content, image, color, category });
        toast("已收藏 ✨", "ok");
      }
      store.treasures = await API.listTreasures();
      store.tcats = await API.listCategories();
      f.remove();
      onDone && onDone();
    });

    setTimeout(() => { try { contentEl.focus(); } catch (e) {} }, 30);
    return f;
  }

  /* =========================================================
   *  视图 5：宝藏回收（30 天回收期）
   * ========================================================= */
  function remainingDays(expireTs) {
    return Math.max(0, Math.ceil((expireTs - Date.now()) / 86400000));
  }
  function expireDateStr(expireTs) {
    const d = new Date(expireTs);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function renderTrash(root) {
    const list = store.trash || [];
    const ttl = API.TRASH_TTL_DAYS || 30;
    root.innerHTML = `
      <div class="view-head">
        <div>
          <h3>宝藏回收</h3>
          <div class="sub">共 ${list.length} 项 · 回收期 ${ttl} 天</div>
        </div>
        <div style="margin-left:auto;display:flex;gap:8px;">
          <button class="btn btn-ghost" id="trEmpty" type="button">清空回收站</button>
        </div>
      </div>
      <div class="trash-list" id="trList"></div>
    `;
    const host = $("#trList", root);
    if (!list.length) {
      host.innerHTML = `<div class="empty"><div class="icon">♻️</div><div>回收站是空的。删除的内容会在这里保留 ${ttl} 天</div></div>`;
    } else {
      list.forEach((it) => host.appendChild(trashCard(it)));
    }
    $("#trEmpty", root).addEventListener("click", async () => {
      if (!store.trash.length) { toast("回收站已经是空的"); return; }
      const yes = await confirmDialog({
        title: "清空回收站",
        message: `彻底删除回收站中的全部 ${store.trash.length} 项？`,
        hint: "此操作不可恢复，回收项将立即从本地永久清除。",
        okText: "彻底删除",
        danger: true
      });
      if (!yes) return;
      await API.emptyTrash();
      store.trash = await API.listTrash();
      render();
      toast("回收站已清空");
    });
  }

  function trashCard(it) {
    const el = document.createElement("div");
    el.className = "trash-item";
    const days = remainingDays(it.expireTs);
    const urgency = days <= 3 ? "is-urgent" : days <= 7 ? "is-warn" : "";
    const isNote = it.type === "note";
    el.innerHTML = `
      <div class="tr-icon">${isNote ? "✎" : "🗒️"}</div>
      <div class="tr-main">
        <div class="tr-title">${esc(it.title || "未命名")}</div>
        ${it.preview ? `<div class="tr-preview">${esc(it.preview)}</div>` : ""}
        <div class="tr-meta">
          <span class="tr-from">${esc(it.from || (isNote ? "读书笔记" : "我的宝藏"))}</span>
          <span>删除于 ${esc(it.deletedAt || "")}</span>
        </div>
      </div>
      <div class="tr-side">
        <span class="tr-count ${urgency}">剩余 ${days} 天</span>
        <span class="tr-expire">${esc(expireDateStr(it.expireTs))} 清除</span>
        <div class="tr-btns">
          <button class="btn btn-ghost tr-restore" type="button">还原</button>
          <button class="btn btn-ghost tr-remove" type="button">彻底删除</button>
        </div>
      </div>
    `;
    el.querySelector(".tr-restore").addEventListener("click", async () => {
      const r = await API.restoreTrash(it.id);
      if (r && r.ok) {
        store.treasures = await API.listTreasures();
        store.trash = await API.listTrash();
        render();
        toast("已还原到原来的位置", "ok");
        return;
      }
      store.trash = await API.listTrash();
      render();
      toast("该项已过期，无法还原", "err");
    });
    el.querySelector(".tr-remove").addEventListener("click", async () => {
      const yes = await confirmDialog({
        title: "彻底删除",
        message: `确定彻底删除「${it.title || "这一项"}」？`,
        hint: "删除后不可恢复，也不会再保存在回收站。",
        okText: "彻底删除",
        danger: true
      });
      if (!yes) return;
      await API.removeTrash(it.id);
      store.trash = await API.listTrash();
      render();
      toast("已彻底删除");
    });
    return el;
  }

  /* =========================================================
   *  设置弹窗（微信读书 Cookie 配置）
   * ========================================================= */
  /** 设置弹窗里的「笔记同步」状态行：上次同步到什么时候、多少本书、多少条 */
  function paintNoteSyncLine(mask) {
    const line = $("#noteSyncLine", mask || document);
    if (!line) return;
    if (API.state.notesSyncing) {
      line.className = "status-line";
      line.textContent = "正在同步笔记…";
      return;
    }
    const st = API.noteStats ? API.noteStats() : { notes: 0, books: 0, wxNotes: 0, failed: [], at: 0 };
    const last = API.state.lastNoteSync;
    if (!last || !last.at) {
      line.className = "status-line err";
      line.textContent = st.notes
        ? `本机已存 ${st.notes} 条笔记（${st.books} 本）· 还没做过全量同步`
        : "还没同步过笔记";
      return;
    }
    const d = new Date(last.at);
    const p = (n) => String(n).padStart(2, "0");
    const fail = (st.failed || []).length;
    line.className = "status-line " + (fail ? "err" : "ok");
    line.textContent = `上次同步 ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())} · 扫描 ${st.scanned || 0} 本 → ` +
      `命中 ${st.books} 本 / ${st.notes} 条（微信读书来的 ${st.wxNotes} 条）` +
      (fail ? ` · ${fail} 本没取到，点「立即同步笔记」可重试` : "") +
      (API.state.connected ? "" : "（演示模式下不会同步）");
  }

  function openSettings() {
    const mask = $("#settingsMask");
    const cookie = window.WeReadClient.getCookie();
    const mode = window.WeReadClient.getMode();
    const connected = API.state.connected;

    mask.innerHTML = `
      <div class="modal">
        <div class="modal__head">
          <h3>连接微信读书</h3>
          <button class="close">×</button>
        </div>
        <div class="modal__body">
          <div class="form-row">
            <label>当前状态</label>
            <div class="status-line ${connected ? "ok" : "err"}" id="connStatus">
              ${connected ? "✅ 已连接微信读书，数据为实时同步" : "⚠️ 当前为演示模式（使用内置样例数据）"}
            </div>
            <div class="desc" id="diagLine" style="margin-top:6px;">正在检查代理…</div>
          </div>

          <div class="form-row">
            <label>获取 Cookie 的步骤</label>
            <ol class="steps">
              <li>在电脑浏览器打开 <code>weread.qq.com</code> 并扫码登录</li>
              <li>按 <code>F12</code> 打开开发者工具 → 切到 <code>Network（网络）</code></li>
              <li>刷新页面，点任意一个 <code>weread.qq.com</code> 的请求</li>
              <li>在 <code>Request Headers</code> 中找到 <code>Cookie</code>，复制<strong>整行</strong>值</li>
              <li>粘贴到下面输入框，点「测试连接」→「保存」</li>
            </ol>
          </div>

          <div class="form-row">
            <label>微信读书 Cookie</label>
            <textarea id="cookieInput" rows="5" placeholder="wr_vid=...; wr_skey=...; wr_rt=...; ...">${esc(cookie)}</textarea>
            <div class="desc">Cookie 只保存在你自己的浏览器本地（localStorage），不会上传到任何服务器。</div>
          </div>

          <div class="form-row">
            <label>运行模式</label>
            <select id="modeSelect" class="btn btn-ghost" style="width:100%;font-size:13px;padding:10px;">
              <option value="real" ${mode === "real" ? "selected" : ""}>联动模式（读取微信读书真实数据）</option>
              <option value="demo" ${mode === "demo" ? "selected" : ""}>演示模式（使用内置样例数据）</option>
            </select>
            <div class="desc">联动模式需要本地代理服务处于运行状态（见下方说明）。</div>
          </div>

          <div class="form-row">
            <label>微信读书笔记（划线 / 下划线 / 想法）</label>
            <div class="status-line" id="noteSyncLine">读取中…</div>
            <div class="steps" style="margin-top:8px;">
              书架接口不带笔记，所以划线和想法要逐本读取一次，并按 <code>bookId</code> 归到各自的书。<br>
              同步结果存在本机，下次打开页面直接显示；想更新就再同步一次。
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
              <button class="btn btn-ghost" id="btnSyncNotes2">⟳ 立即同步笔记</button>
              <button class="btn btn-ghost" id="btnClearNotes">清除已同步的笔记</button>
            </div>
          </div>

          <div class="status-line" id="testResult" style="display:none;"></div>

          <div class="form-row" style="margin-top:18px;">
            <label>数据备份与迁移</label>
            <div class="desc" id="bkInfo">统计中…</div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
              <button class="btn btn-ghost" id="btnExport" type="button">⤓ 导出备份</button>
              <button class="btn btn-ghost" id="btnImport" type="button">⤒ 导入备份</button>
              <button class="btn btn-ghost" id="btnUndoImport" type="button" style="display:none;">↺ 撤销上次导入</button>
            </div>
            <label class="bk-check">
              <input type="checkbox" id="ckCookie">
              <span>备份里带上微信读书 Cookie（只有本机换浏览器才需要；这个文件别发给别人）</span>
            </label>
            <div class="desc" style="margin-top:8px;">
              数据只存在这个浏览器里，换浏览器 / 换电脑 / 清缓存就会丢 —— 导出的 JSON 存一份，换设备时导入就能接上。
            </div>
            <input type="file" id="importFile" accept="application/json,.json" style="display:none;">
          </div>

          ${IS_SHOWCASE ? "" : `
          <div class="form-row" style="margin-top:18px;">
            <label>AI 阅读助理（可选）</label>
            <div class="status-line" id="aiStatus">读取中…</div>
            <input id="aiKey" type="password" placeholder="sk-…（DeepSeek API Key）"
                   style="width:100%;font-size:13px;padding:10px;border:1px solid var(--line,#e3ded4);border-radius:8px;background:#fff;"
                   value="${esc(window.AI ? window.AI.getKey() : "")}">
            <div class="desc" style="margin-top:6px;">
              Key 只存在本机浏览器，请求时发给你自己电脑上的 <code>server.js</code> 再转给 DeepSeek；
              <b>不会</b>写进备份文件，也不会出现在公网展示版里。留空 = 关闭 AI 功能。
            </div>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
              <button class="btn btn-ghost" id="btnAiSave" type="button">保存 Key</button>
              <button class="btn btn-ghost" id="btnAiTest" type="button">测试连接</button>
              <button class="btn btn-ghost" id="btnAiClear" type="button">清除 Key</button>
            </div>
            <div class="steps" style="margin-top:8px;">
              拿 Key：打开 <code>platform.deepseek.com</code> → API Keys → 创建（新账号有赠送额度）。<br>
              更干净的做法：启动服务前设环境变量 <code>DEEPSEEK_API_KEY</code>，这样 Key 完全不进浏览器。
            </div>
          </div>`}

          <div class="form-row" style="margin-top:18px;">
            <label>本地代理服务（联动模式必需）</label>
            <div class="steps">
              双击项目里的 <strong>启动工作台.bat</strong>（会自动起服务并打开浏览器）；<br>
              或手动在项目目录执行 <code>node server.js</code>，再用 <code>http://localhost:8787</code> 打开。<br>
              <span class="desc">若你直接双击 <code>index.html</code>（地址栏是 <code>file://</code>），
              程序会尝试自动改连 <code>http://localhost:8787</code>；连不上请按上面方式重新打开。</span>
            </div>
          </div>
        </div>
        <div class="modal__foot">
          <button class="btn btn-ghost" id="btnClearCookie">清除 Cookie</button>
          <button class="btn btn-ghost" id="btnTest">测试连接</button>
          <button class="btn btn-primary" id="btnSaveCfg">保存并重新加载</button>
        </div>
      </div>
    `;

    $(".close", mask).addEventListener("click", closeSettings);
    $("#btnClearCookie", mask).addEventListener("click", () => {
      window.WeReadClient.clearCookie();
      $("#cookieInput", mask).value = "";
      toast("已清除 Cookie");
    });
    $("#btnTest", mask).addEventListener("click", async () => {
      const input = $("#cookieInput", mask);
      window.WeReadClient.setCookie(input.value);
      const line = $("#testResult", mask);
      line.style.display = "flex";
      line.className = "status-line";
      line.textContent = "正在测试…";
      const r = await API.testConnection();
      line.className = "status-line " + (r.ok ? "ok" : "err");
      line.textContent = (r.ok ? "✅ " : "❌ ") + r.msg;
    });
    $("#btnSyncNotes2", mask).addEventListener("click", async () => {
      const btn = $("#btnSyncNotes2", mask);
      btn.disabled = true;
      btn.textContent = "同步中…";
      await syncNotes();
      btn.disabled = false;
      btn.textContent = "⟳ 立即同步笔记";
      paintNoteSyncLine(mask);
    });
    $("#btnClearNotes", mask).addEventListener("click", async () => {
      const yes = await confirmDialog({
        title: "清除已同步的笔记",
        message: "只会清掉从微信读书同步过来的划线 / 想法，你自己在本机写的笔记不受影响。",
        okText: "清除",
        danger: true
      });
      if (!yes) return;
      API.clearWxNotes();
      render();
      updateFootInfo();
      paintNoteSyncLine(mask);
      toast("已清除同步来的笔记", "ok");
    });
    /* ---- AI 助理配置（可选） ---- */
    if (!IS_SHOWCASE && window.AI) {
      const aiStatus = $("#aiStatus", mask);
      const aiKeyInput = $("#aiKey", mask);
      const paintAiStatus = async () => {
        const p = await window.AI.ping();
        if (!p.ok) {
          aiStatus.className = "status-line err";
          aiStatus.textContent = "❌ AI 代理不可用（server.js 没启动？）";
          return;
        }
        const where = p.hasServerKey ? "环境变量" : (p.hasLocalKey ? "本机设置" : "");
        aiStatus.className = "status-line " + (where ? "ok" : "err");
        aiStatus.textContent = where
          ? `✅ AI 已就绪（Key 来自${where}）· 按书隔离检索 + DeepSeek`
          : "⚠️ 还没配置 Key —— 填上面的输入框，或用环境变量 DEEPSEEK_API_KEY 启动服务";
      };
      paintAiStatus();

      $("#btnAiSave", mask).addEventListener("click", async () => {
        window.AI.setKey(aiKeyInput.value.trim());
        toast(aiKeyInput.value.trim() ? "已保存 AI Key" : "已清空 AI Key", "ok");
        paintAiStatus();
        if (store.drawerBookId) renderDrawer();
      });
      $("#btnAiTest", mask).addEventListener("click", async () => {
        const v = aiKeyInput.value.trim();
        if (v) window.AI.setKey(v);
        aiStatus.className = "status-line";
        aiStatus.textContent = "正在测试…";
        const r = await window.AI.chat([{ role: "user", content: "只回复两个字：可用" }]);
        aiStatus.className = "status-line " + (r.ok ? "ok" : "err");
        aiStatus.textContent = r.ok ? "✅ 模型已接通：" + String(r.content || "").slice(0, 40) : "❌ " + r.error;
      });
      $("#btnAiClear", mask).addEventListener("click", async () => {
        const yes = await confirmDialog({
          title: "清除 AI Key",
          message: "只清掉本机保存的 Key，AI 功能会关闭，笔记数据不受影响。",
          okText: "清除", danger: true
        });
        if (!yes) return;
        window.AI.clearKey();
        aiKeyInput.value = "";
        paintAiStatus();
        if (store.drawerBookId) renderDrawer();
        toast("已清除 AI Key");
      });
    }

    $("#btnSaveCfg", mask).addEventListener("click", async () => {
      window.WeReadClient.setCookie($("#cookieInput", mask).value);
      window.WeReadClient.setMode($("#modeSelect", mask).value);
      closeSettings();
      toast("配置已保存，正在重新加载数据…", "ok");
      await reloadData();
    });

    /* ---- 数据备份与迁移（换设备不丢数据） ---- */
    const bkInfo = $("#bkInfo", mask);
    try {
      const s = API.backupSummary();
      bkInfo.textContent = `本机现有：${s.books} 本书 · ${s.notes} 条笔记（微信读书 ${s.wxNotes} / 本地 ${s.localNotes}）· ${s.treasures} 条宝藏` +
        (s.categorized ? ` · ${s.categorized} 本手工分类` : "") +
        (s.docs ? ` · ${s.docs} 篇排版笔记` : "");
    } catch (e) { bkInfo.textContent = "统计失败，但仍可导出。"; }

    $("#btnUndoImport", mask).style.display = API.canUndoImport() ? "" : "none";

    $("#btnExport", mask).addEventListener("click", () => {
      const includeCookie = $("#ckCookie", mask).checked;
      let bak;
      try { bak = API.exportBackup({ includeCookie }); }
      catch (e) { toast("导出失败：" + e.message, "err"); return; }
      const c = bak.counts;
      downloadFile(`读书工作台备份-${stampNow()}.json`, JSON.stringify(bak, null, 2));
      toast(`已导出 ${c.books} 本书 / ${c.notes} 条笔记${includeCookie && bak.hasCookie ? "（含 Cookie）" : "（不含 Cookie）"}`, "ok");
    });

    $("#btnImport", mask).addEventListener("click", () => $("#importFile", mask).click());

    $("#importFile", mask).addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = "";                       // 允许重复选同一个文件
      if (!f) return;
      let obj;
      try { obj = JSON.parse(await f.text()); }
      catch (err) { toast("读不了这个文件：请选导出的 .json 备份", "err"); return; }

      let info;
      try { info = API.readBackupFile(obj); }
      catch (err) { toast(err.message, "err"); return; }

      const c = info.counts;
      const when = info.exportedAt ? new Date(info.exportedAt).toLocaleString("zh-CN") : "未知时间";
      const yes = await confirmDialog({
        title: "导入备份",
        message: `导出时间 ${when}；含 ${c.books} 本书、${c.notes} 条笔记（微信读书 ${c.wxNotes} / 手写 ${c.localNotes}）、${c.treasures} 条宝藏。导入会覆盖当前浏览器里的同名数据。`,
        hint: "导入前会自动留一份当前数据，点「撤销上次导入」就能退回。",
        okText: "覆盖导入",
        danger: true
      });
      if (!yes) return;

      try {
        const r = await API.importBackup(obj);
        toast(`导入完成：写入 ${r.written} 项、跳过 ${r.skipped} 项，即将刷新…`, "ok");
        setTimeout(() => location.reload(), 1200);
      } catch (err) { toast("导入失败：" + err.message, "err"); }
    });

    $("#btnUndoImport", mask).addEventListener("click", async () => {
      const yes = await confirmDialog({
        title: "撤销上次导入",
        message: "把数据退回上一次导入之前的状态。只影响本机浏览器里的数据。",
        okText: "撤销",
        danger: true
      });
      if (!yes) return;
      try {
        await API.undoImport();
        toast("已退回导入前的数据，即将刷新…", "ok");
        setTimeout(() => location.reload(), 1200);
      } catch (err) { toast(err.message, "err"); }
    });

    mask.classList.add("is-open");
    paintNoteSyncLine(mask);

    /* 打开弹窗就先做一次体检：页面地址 + 代理在哪 + Cookie 缺哪段，
       省得用户看到一句「本地代理未启动」却不知道该改什么 */
    (async () => {
      const line = $("#diagLine", mask);
      if (!line) return;
      const [info, ck] = await Promise.all([
        window.WeReadClient.proxyInfo(),
        Promise.resolve(window.WeReadClient.cookieCheck())
      ]);
      const bits = [];
      bits.push(`页面地址：<code>${esc(info.href || "-")}</code>`);
      bits.push(info.base
        ? `代理：<span style="color:#2f9e63">已连上 ${esc(info.base)}${info.fallback ? "（跨域兜底）" : ""}</span>`
        : `代理：<span style="color:#c0482f">未连上（本机 8787 无响应）</span>`);
      bits.push(ck.empty
        ? "Cookie：未填写"
        : (ck.ok ? `Cookie：已识别 ${ck.found.join(" / ")}` : `Cookie：<span style="color:#c0482f">缺少 ${ck.need.join(" / ")}</span>`));
      line.innerHTML = bits.join(" ｜ ");
      if (info.file) {
        line.innerHTML += `<br><span style="color:#c0482f">⚠️ 你是用 file:// 直接打开 HTML 的，浏览器不允许发请求给代理。请双击「启动工作台.bat」后用 http://localhost:8787 打开。</span>`;
      }
    })();
  }
  function closeSettings() { $("#settingsMask").classList.remove("is-open"); }

  /* =========================================================
   *  微信读书笔记同步（划线 + 下划线 + 我的想法 → 归到各自的书）
   * ========================================================= */
  let notesBusy = false;

  /** 顶栏按钮：空闲 / 同步中（带进度） */
  function setNoteSyncBtn(phase, done, total) {
    const btn = $("#btnSyncNotes");
    if (!btn) return;
    if (phase === "busy") {
      btn.disabled = true;
      btn.classList.add("is-busy");
      btn.textContent = total ? `同步笔记 ${done}/${total}` : "同步笔记…";
    } else {
      btn.disabled = false;
      btn.classList.remove("is-busy");
      btn.textContent = "⟳ 同步笔记";
    }
  }

  async function syncNotes({ silent = false, onlyMissing = false } = {}) {
    if (notesBusy) { if (!silent) toast("笔记正在同步中，请稍等…"); return; }
    if (API.state.mode !== "real" || !API.state.connected) {
      if (!silent) toast("还没连上微信读书：点右上角「⚙ 连接设置」粘贴 Cookie", "err");
      return;
    }
    notesBusy = true;
    setNoteSyncBtn("busy", 0, 0);
    try {
      const r = await API.syncAllNotes({
        onlyMissing,
        onProgress: (done, total) => setNoteSyncBtn("busy", done, total)
      });
      if (!r.ok) {
        if (!silent) toast("笔记同步失败：" + (r.reason || "未知原因"), "err");
        return;
      }
      store.books = API.state.books;
      if (store.drawerBookId) renderDrawer();
      if (["overview", "todo", "reading", "done", "notes"].includes(store.view)) render();
      else updateNavBadges();
      if (!silent || r.notes > 0) {
        const fail = (r.failed || []).length;
        toast(`笔记同步完成：${r.books} 本书 · ${r.notes} 条笔记` +
              (fail ? `，${fail} 本没取到（可点「补同步」重试）` : ""), "ok");
      }
    } catch (e) {
      if (!silent) toast("笔记同步出错：" + (e && e.message ? e.message : "未知错误"), "err");
    } finally {
      notesBusy = false;
      setNoteSyncBtn("idle");
      updateFootInfo();
    }
  }

  /* =========================================================
   *  同步 / 重新加载
   * ========================================================= */
  async function syncNow() {
    toast("正在同步微信读书…");
    await reloadData();
  }

  async function reloadData() {
    store.books = await API.loadBooks({ force: true });
    store.treasures = await API.loadTreasures();
    store.tcats = await API.listCategories();
    store.trash = await API.listTrash();
    store.lastSyncAt = API.state.connected ? nowClock() : "";
    updateConnBadge();
    updateNavBadges();
    if (store.drawerBookId) renderDrawer();
    render();
    if (API.state.connected) toast("已同步微信读书数据 ✅", "ok");
    else if (API.state.lastError) toast(API.state.lastError, "err");
    fillRatings();              // 书架同步完了，接着把评分补齐
    fillNotes({ force: true }); // 手动点了同步，笔记就一起更新（书架接口不带笔记）
  }

  /* =========================================================
   *  外壳绑定
   * ========================================================= */
  function bindShell() {
    $$(".nav-item").forEach((el) => {
      el.addEventListener("click", () => {
        const r = el.dataset.route;
        if (!r) return;
        location.hash = "#/" + r;
        if (location.hash === "#/" + r) render();
      });
    });
    const search = $("#topbarSearch");
    search.addEventListener("input", debounce((e) => {
      store.keyword = e.target.value.trim().toLowerCase();
      render();
    }));
    const conn = $("#connChip");
    conn && conn.addEventListener("click", () => {
      // 公网展示版没有本地代理：不要打开设置抽屉让人误以为能连
      if (IS_SHOWCASE) {
        confirmDialog({
          title: "这是公网展示版",
          message: "公网链接打不到你电脑上的数据代理，所以连不上微信读书 —— 同步、连接按钮是被有意隐藏的，不是坏了。",
          hint: "要用真实数据：在自己电脑上运行「启动工作台.bat」，然后浏览器打开 http://localhost:8787 。\n公网页面不要填写微信读书 Cookie。",
          okText: "知道了",
          okOnly: true
        });
        return;
      }
      openSettings();
    });
    const setBtn = $("#settingsBtn");
    setBtn && setBtn.addEventListener("click", openSettings);
    const noteBtn = $("#btnSyncNotes");
    noteBtn && noteBtn.addEventListener("click", () => syncNotes());
    // 删掉一条笔记后，「我的笔记」页的总账要跟着变
    document.addEventListener("notes-changed", () => {
      if (store.view === "notes") render();
    });
  }

  function updateConnBadge() {
    const chip = $("#connChip");
    if (!chip) return;
    const live = API.state.connected;
    chip.classList.toggle("is-live", live);
    if (live) {
      $(".txt", chip).innerHTML = `<b>已连接微信读书</b><span>数据实时同步</span>`;
    } else if (IS_SHOWCASE) {
      $(".txt", chip).innerHTML = `<b>展示版</b><span>示例数据 · 只读</span>`;
    } else {
      $(".txt", chip).innerHTML = `<b>演示模式</b><span>点击配置真实数据</span>`;
    }
  }

  function updateNavBadges() {
    const noteTotal = (store.books || []).reduce((s, b) => s + ((b.notes || []).length), 0);
    const c = {
      overview: store.books.length,
      reading: store.books.filter((b) => b.status === "reading").length,
      done: store.books.filter(isFinished).length,
      todo: store.books.filter((b) => b.status === "unread").length,
      notes: noteTotal,
      treasure: store.treasures.length,
      trash: (store.trash || []).length
    };
    const unit = (r) => (r === "treasure" || r === "trash" ? "项" : (r === "notes" ? "条" : "本"));
    const set = (r, v) => {
      const el = $(`.nav-item[data-route="${r}"] .badge`);
      if (!el) return;
      el.textContent = v;
      el.classList.toggle("is-zero", !v);   // 0 淡化，避免一排「0」抢视线
      el.title = `${v} ${unit(r)}`;
    };
    set("overview", c.overview);
    set("reading", c.reading);
    set("done", c.done);
    set("todo", c.todo);
    set("notes", c.notes);
    set("treasure", c.treasure);
    set("trash", c.trash);
    updateFootInfo();
  }

  /** 侧边栏页脚：当前数据来源 + 同步到的册数 / 笔记数 / 时间 */
  function updateFootInfo() {
    const el = $("#footSync");
    if (!el) return;
    const n = store.books.length;
    const noteN = (store.books || []).reduce((s, b) => s + ((b.notes || []).length), 0);
    const noteTxt = noteN ? ` · ${noteN} 条笔记` : "";
    if (API.state.connected) {
      el.textContent = `已同步 ${n} 本书${noteTxt}${store.lastSyncAt ? " · " + store.lastSyncAt.slice(5, 16) : ""}`;
      el.classList.remove("is-demo");
    } else if (IS_SHOWCASE) {
      el.textContent = `展示用示例数据 · ${n} 本${noteTxt}`;
      el.classList.add("is-demo");
    } else {
      el.textContent = `演示数据 ${n} 本${noteTxt} · 未连接微信读书`;
      el.classList.add("is-demo");
    }
  }

  /* =========================================================
   *  渲染入口
   * ========================================================= */
  function render() {
    destroyTreasureToolbars();
    // 换窗口时清掉分类筛选，免得带着上一个窗口的筛选条件看到一片空白
    if (store._lastView && store._lastView !== store.view) store.catFilter = "";
    store._lastView = store.view;
    const meta = ROUTES[store.view];
    $("#topbarTitle").innerHTML = `${esc(meta.title)} <small>· ${esc(meta.sub)}</small>`;
    $$(".nav-item").forEach((n) => n.classList.toggle("is-active", n.dataset.route === store.view));

    const host = $("#viewRoot");
    host.innerHTML = "";
    const view = document.createElement("div");
    view.className = "view";

    if (store.view === "overview") renderOverview(view);
    else if (store.view === "reading") renderReading(view);
    else if (store.view === "done") renderDone(view);
    else if (store.view === "todo") renderTodo(view);
    else if (store.view === "notes") renderNotes(view);
    else if (store.view === "treasure") renderTreasure(view);
    else if (store.view === "trash") renderTrash(view);

    host.appendChild(view);
    view.scrollTop = 0;
    updateNavBadges();
    updateConnBadge();
  }

  function filterBooks(base) {
    const k = store.keyword;
    if (!k) return base;
    // 走本地检索（离线、按相关度排序）；检索不到会自己回退到子串匹配
    if (window.LOCAL_SEARCH) return window.LOCAL_SEARCH.rankBooks(base, k);
    return base.filter((b) => [b.title, b.author, b.category].some((f) => String(f).toLowerCase().includes(k)));
  }

  document.addEventListener("DOMContentLoaded", boot);
})();

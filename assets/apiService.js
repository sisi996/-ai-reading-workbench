/* ==========================================================
 *  apiService.js — 统一数据层
 *  策略：
 *    1) 「联动模式」：走 WeReadClient（真实微信读书数据，需代理 + Cookie）
 *    2) 「演示模式」：使用本地模拟数据
 *  无论哪种模式，本地产生的标注 / 宝藏 / 首次阅读时间都持久化在 localStorage，
 *  并可与微信读书数据合并展示。
 * ========================================================== */
(function (global) {

  // v3：进度单位修正（以前把 36% 存成了 3600），旧缓存必须丢掉，否则脏数据会一直显示
  const LS_BOOKS     = "weread.books.v3";
  const LS_TREASURES = "weread.treasures.v2";
  const LS_FIRSTSEEN = "weread.firstSeen.v1";   // { bookId: "YYYY-MM-DD HH:mm" | {t, guess} }
  const LS_LOCALNOTE = "weread.localNotes.v1";  // { bookId: [note, ...] }
  const LS_TRASH     = "weread.trash.v1";       // 宝藏回收站
  const LS_TCATS     = "weread.treasureCats.v1"; // 宝藏自定义分类 [{id,name}]
  const LS_RATING    = "weread.ratingTried.v1";  // { bookId: ts } 已尝试拉过评分详情
  const LS_BOOKCAT   = "weread.bookCat.v1";      // { bookId: "分类名" } 手工指定的书籍分类（覆盖微信读书）
  const LS_ARCHIVE   = "weread.archive.v1";      // 微信读书书架分组 [{id,name,bookIds}]
  const LS_WXNOTE    = "weread.wxNotes.v1";      // { bookId: { notes:[], count, syncedAt } } 同步下来的微信读书笔记
  const LS_NOTESYNC  = "weread.noteSync.v1";     // { at, books, notes } 最近一次笔记同步的结果
  const LS_UNDO      = "weread.undoBackup.v1";   // 导入备份前的自动快照，用于撤销
  const LS_COOKIE_KEY = "weread.cookie.v1";      // 与 wereadClient 共用（只用于备份包含 Cookie 时）
  const DOC_PREFIX   = "weread.noteDoc.v1.";     // 自由排版笔记文档（按 bookId 分散存）

  /* 备份要收的键（顺序无关，仅用于白名单校验） */
  const BACKUP_KEYS = [
    LS_BOOKS, LS_TREASURES, LS_FIRSTSEEN, LS_LOCALNOTE, LS_TRASH, LS_TCATS,
    LS_RATING, LS_BOOKCAT, LS_ARCHIVE, LS_WXNOTE, LS_NOTESYNC
  ];
  const BACKUP_FORMAT = "ai-reading-workbench-backup";

  const TRASH_TTL_DAYS = 30;                    // 回收有效期（天）
  const RATING_RETRY_DAYS = 7;                  // 没评分的书，7 天后允许再试一次

  function read(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function genId(p = "id") {
    return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }
  function nowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function daysSince(str) {
    if (!str) return 0;
    const t = new Date(String(str).replace(/-/g, "/").slice(0, 16)).getTime();
    if (isNaN(t)) return 0;
    return Math.max(1, Math.ceil((Date.now() - t) / 86400000));
  }
  function fmtDT(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  /** 去掉 HTML 标签，得到纯文本预览 */
  function stripHtml(html) {
    return String(html == null ? "" : html)
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
  }
  const delay = (d, ms = 60) => new Promise((r) => setTimeout(() => r(d), ms));

  /* =========================================================
   *  状态
   * ========================================================= */
  const state = {
    mode: "demo",       // 'real' | 'demo'
    connected: false,   // 是否成功连上微信读书
    lastError: null,
    books: [],
    treasures: [],
    trash: [],
    tcats: [],          // 宝藏分类
    shelfGroups: [],    // 微信读书书架分组（archive[]）
    loading: false,
    notesSyncing: false, // 是否正在同步微信读书笔记
    lastNoteSync: read(LS_NOTESYNC, null)   // { at, books, notes }
  };

  /* =========================================================
   *  本地持久化的小工具
   * ========================================================= */
  function getFirstSeen() { return read(LS_FIRSTSEEN, {}); }

  /** 读一条「首次阅读」记录：兼容旧格式（纯字符串）与新格式（{t, guess}） */
  function firstSeenOf(bookId) {
    const v = getFirstSeen()[bookId];
    if (!v) return null;
    if (typeof v === "string") return { t: v, guess: false };
    return { t: v.t, guess: !!v.guess };
  }
  /**
   * 记下「首次见到这本书」的时间。
   * guess=true 表示这只是拿微信读书的「最近阅读」占位（不是真的首次阅读），
   * 前端会如实显示成「最近阅读」，等用户手工改过才变成确定值。
   */
  function markFirstSeen(bookId, fallbackTime, { guess = false } = {}) {
    const map = getFirstSeen();
    if (!map[bookId]) {
      map[bookId] = guess ? { t: fallbackTime || nowStr(), guess: true } : (fallbackTime || nowStr());
      write(LS_FIRSTSEEN, map);
    }
    return firstSeenOf(bookId);
  }
  function getLocalNotes() { return read(LS_LOCALNOTE, {}); }
  function saveLocalNotes(bookId, notes) {
    const all = getLocalNotes();
    all[bookId] = notes;
    write(LS_LOCALNOTE, all);
  }

  /* ---------- 微信读书笔记缓存 ----------
   * 同步下来的划线 / 想法单独存一张表（LS_WXNOTE），按 bookId 归档。
   * 为什么不直接塞进书对象？
   *   · 联动模式每次同步书架都会整批重建 state.books，塞在对象上会被冲掉；
   *   · persistBooks() 为了控制体积，也会把 source==="weread" 的笔记剔掉。
   * 所以这里单独存，再由 decorate() 在渲染前合并回 book.notes。 */
  function getWxNoteMap() { return read(LS_WXNOTE, {}); }
  function getWxNotes(bookId) {
    const v = getWxNoteMap()[String(bookId)];
    if (!v) return [];
    return Array.isArray(v.notes) ? v.notes : [];
  }
  function saveWxNotes(bookId, notes) {
    const m = getWxNoteMap();
    m[String(bookId)] = { notes: notes || [], count: (notes || []).length, syncedAt: Date.now() };
    write(LS_WXNOTE, m);
  }
  function clearWxNotes() {
    write(LS_WXNOTE, {});
    write(LS_NOTESYNC, {});
    state.lastNoteSync = null;
    state.books.forEach((b) => { b.notes = (b.notes || []).filter((n) => n.source !== "weread"); });
    persistBooks(state.books);
    return true;
  }
  /** 已同步到的微信读书笔记总数 */
  function totalWxNotes() {
    return state.books.reduce(
      (s, b) => s + (b.notes || []).filter((n) => n.source === "weread").length, 0);
  }
  /** 有笔记的书有多少本 */
  function booksWithNotes() {
    return state.books.filter((b) => (b.notes || []).some((n) => n.source === "weread")).length;
  }

  /**
   * 笔记总账：给「我的笔记」页和设置里的对账用。
   * 微信读书「我的」页显示的「1474 个笔记 · 留在 97 本书上」就是这两个数，
   * 所以这里必须按**条 / 本**两个维度都统计，用户才能一眼看出还差多少。
   */
  function noteStats() {
    let notes = 0, books = 0, wx = 0, official = 0;
    state.books.forEach((b) => {
      const list = b.notes || [];
      if (!list.length) return;
      books++;
      notes += list.length;
      list.forEach((n) => {
        if (!n) return;
        // 微信读书「我的」页的总数 = 划线数 + 想法数：一条划线下面写了想法，官方算 2 条，
        // 而我们是合并成一张卡。所以额外算一个「官方口径」，对账时才不会误以为少同步了。
        official++;
        if (String(n.comment || "").trim()) official++;
        if (n.source === "weread") wx++;
      });
    });
    const last = state.lastNoteSync || {};
    return {
      notes, books, official, wxNotes: wx, localNotes: notes - wx,
      scanned: last.scanned || 0,
      failed: Array.isArray(last.failed) ? last.failed : [],
      at: last.at || 0
    };
  }

  /**
   * 按书分组（只返回有笔记的书）。
   * 排序：笔记多的排前面 —— 「我的笔记」页第一屏就能看到内容最厚的几本。
   */
  function notesGrouped() {
    return state.books
      .filter((b) => (b.notes || []).length)
      .map((b) => ({
        bookId: b.bookId,
        title: b.title,
        author: b.author,
        cover: b.cover,
        rating: b.rating,
        category: catOf(b),
        notes: b.notes || []
      }))
      .sort((a, b) => b.notes.length - a.notes.length);
  }

  /** 笔记去重：同一类型 + 同一段原文只留一条（本地手写和微信同步可能撞车） */
  function dedupNotes(list) {
    const seen = new Set();
    return (list || []).filter((n) => {
      if (!n) return false;
      const k = `${n.type || ""}|${n.text || ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /* ---------- 书籍分类 ----------
   * 优先级：用户手工指定 > 微信读书书架分组 > 书籍自身的 category 品类 > 空（显示「未分类」）。
   * 手工指定要单独存一张表（LS_BOOKCAT），不能写在书对象上 ——
   * 联动模式每次同步都会用接口返回整批覆盖 state.books，写在对象上会被冲掉。 */
  function getCatMap() { return read(LS_BOOKCAT, {}); }
  function setBookCategory(bookId, cat) {
    const map = getCatMap();
    const v = String(cat || "").trim();
    if (v) map[String(bookId)] = v; else delete map[String(bookId)];
    write(LS_BOOKCAT, map);
    const b = state.books.find((x) => x.bookId === String(bookId));
    if (b) {
      // 传空串 = 取消手工指定，退回微信读书原本给的分类（不是把它清空）
      b.category = v || b.wxCategory || "";
      b.catManual = !!v;
    }
    return v;
  }
  /** 当前生效的分类名（供筛选 / 分组用） */
  function catOf(book) {
    if (!book) return "";
    const manual = getCatMap()[String(book.bookId)];
    if (manual) return manual;
    return (book.category || book.group || "").trim();
  }

  /* ---------- 微信读书书架分组（archive[]） ---------- */
  function setShelfGroups(groups) {
    state.shelfGroups = Array.isArray(groups) ? groups : [];
    write(LS_ARCHIVE, state.shelfGroups);
    return state.shelfGroups;
  }
  function groupOfBook(bookId) {
    const id = String(bookId);
    const g = state.shelfGroups.find((x) => Array.isArray(x.bookIds) && x.bookIds.indexOf(id) >= 0);
    return g ? g.name : "";
  }

  /* =========================================================
   *  装饰书籍：合并首次阅读时间 / 阅读天数 / 本地笔记
   * ========================================================= */
  function decorate(book) {
    /* 分类：手工指定 > 书籍品类 > 书架分组。空串交给 UI 显示成「未分类」 */
    book.group = groupOfBook(book.bookId);   // 微信读书自己的书架分组（可能为空）
    if (!book.category) book.category = book.group;
    book.wxCategory = book.category;         // 微信读书给的分类：手工改过后用来「恢复默认」
    const manual = getCatMap()[String(book.bookId)];
    if (manual) {
      book.category = manual;
      book.catManual = true;
    } else {
      book.catManual = false;
    }

    /* 「首次阅读」我们其实拿不到权威值：
       · 本地记录过（读过 / 用户手工改过）→ 用本地那条；
       · 否则用微信读书的「最近阅读」占位，并标记 guess，前端显示成「最近阅读」；
       · 完全没读过的书就留空，不要瞎编一个今天。 */
    let seen = firstSeenOf(book.bookId);
    if (!seen && book.firstReadTime) {
      seen = markFirstSeen(book.bookId, book.firstReadTime, { guess: !!book.firstReadGuess });
    }
    if (seen) {
      book.firstReadTime = seen.t;
      book.firstReadGuess = seen.guess;
    } else {
      book.firstReadTime = "";
      book.firstReadGuess = true;
    }
    book.readingDays = book.firstReadTime ? daysSince(book.firstReadTime) : 0;

    /* 笔记 = 本地手写 + 微信读书同步下来的（按 bookId 严格归属这本书）
       顺序：本地在前（刚写的排最前），微信笔记跟在后面并按章节排序。 */
    const local = getLocalNotes()[book.bookId] || [];
    const wx = getWxNotes(book.bookId);
    const inMem = (book.notes || []).filter((n) => n.source !== "weread");
    book.notes = dedupNotes([...local, ...inMem, ...wx]);
    return book;
  }

  /* =========================================================
   *  拉取数据
   * ========================================================= */
  async function loadBooks({ force = false } = {}) {
    state.loading = true;
    state.lastError = null;

    // 1) 尝试联动模式
    const wantReal = WeReadClient.getMode() === "real";
    const canReal = WeReadClient.hasCookie() && (await WeReadClient.probeProxy());

    if (wantReal && canReal) {
      try {
        const raw = await WeReadClient.shelf();
        // 书架分组（微信读书里你自己建的分类）先落状态，decorate 里要用
        setShelfGroups(WeReadClient.parseArchive(raw));
        const books = WeReadClient.parseShelf(raw).map(decorate);
        state.mode = "real";
        state.connected = true;
        state.books = books;
        persistBooks(books);
        state.loading = false;
        return books;
      } catch (e) {
        state.connected = false;
        state.lastError = e.code === 401 ? "Cookie 已过期，请重新获取" : e.message;
        if (e.code === 401) WeReadClient.setMode("demo");
        // 落到演示模式
      }
    } else {
      state.connected = false;
      if (wantReal && !canReal) {
        state.lastError = !WeReadClient.hasCookie()
          ? "尚未配置微信读书 Cookie"
          : (typeof location !== "undefined" && location.protocol === "file:"
              ? "页面是 file:// 打开的，无法连本地代理；请用 http://localhost:8787 打开"
              : "本地代理未启动（请运行 node server.js，或双击「启动工作台.bat」）");
      }
    }

    // 2) 演示模式：本地缓存优先，否则用内置样例
    state.mode = "demo";
    state.shelfGroups = read(LS_ARCHIVE, []);   // 上次同步到的书架分组（演示模式也能用）
    const cached = read(LS_BOOKS, null);
    const base = (cached && cached.length && !force) ? cached : window.WEREAD_MOCK.RAW_BOOKS;
    const books = base.map((b) => decorate({ ...b, notes: (b.notes || []).slice() }));
    state.books = books;
    persistBooks(books);
    state.loading = false;
    return books;
  }

  function persistBooks(books) {
    // 只存非笔记部分，避免体积膨胀
    const slim = books.map((b) => ({ ...b, notes: b.notes.filter((n) => n.source !== "weread") }));
    write(LS_BOOKS, slim);
  }

  async function loadTreasures() {
    let list = read(LS_TREASURES, null);
    if (!list) list = window.WEREAD_MOCK.DEFAULT_TREASURES.slice();
    // 兼容旧数据：补齐 category 字段
    list.forEach((t) => { if (typeof t.category !== "string") t.category = ""; });
    state.treasures = list;
    write(LS_TREASURES, state.treasures);
    return state.treasures;
  }

  /* =========================================================
   *  Book 详情（懒加载笔记/评论）
   * ========================================================= */
  async function getBookDetail(bookId) {
    const book = state.books.find((b) => b.bookId === bookId);
    if (!book) return null;
    return delay(book);
  }

  async function fetchBookDeep(bookId) {
    const book = state.books.find((b) => b.bookId === bookId);
    if (!book) return null;

    if (state.mode === "real" && state.connected) {
      try {
        const bundle = await WeReadClient.fetchBookBundle(book);
        Object.assign(book, {
          intro: bundle.intro || book.intro,
          publisher: bundle.publisher || book.publisher,
          rating: bundle.rating || book.rating,
          ratingCount: bundle.ratingCount || book.ratingCount,
          reviews: bundle.reviews
        });
        /* 远程笔记只是「最新的一份微信笔记」：先把本地手写的挑出来，再合并回去，
           否则打开一次抽屉就会把手写笔记冲掉。顺带把这份结果缓存下来。 */
        saveWxNotes(book.bookId, bundle.notes || []);
        const mine = (book.notes || []).filter((n) => n.source !== "weread");
        book.notes = dedupNotes([...mine, ...(bundle.notes || [])]);
        decorate(book);
        persistBooks(state.books);
      } catch (e) {
        if (e.code === 401) state.lastError = "Cookie 已过期，请重新获取";
      }
    }
    return book;
  }

  /* =========================================================
   *  评分补齐
   *  ⚠️ 微信读书的 /shelf/sync（书架）里**不含评分**，
   *     评分只存在于每本书的 /book/info 里。
   *     所以列表页想显示星级，必须逐本补拉一次。
   *  · 结果直接写进 book 并落盘，下次不再重复请求；
   *  · 没拿到评分的书 7 天后允许再试（可能是评价数不够，过阵子就有了）。
   * ========================================================= */
  function getRatingTried() { return read(LS_RATING, {}); }
  function markRatingTried(ids) {
    const m = getRatingTried();
    const ts = Date.now();
    ids.forEach((id) => { m[id] = ts; });
    write(LS_RATING, m);
  }
  function ratingExpired(ts) {
    return !ts || (Date.now() - ts) > RATING_RETRY_DAYS * 86400000;
  }

  /**
   * 批量补评分 / 简介 / 出版社
   * @returns {Promise<number>} 成功补到评分的本数
   */
  async function enrichRatings({ limit = 120, concurrency = 4, onProgress } = {}) {
    if (state.mode !== "real" || !state.connected) return 0;
    if (!WeReadClient.bookInfoBatch) return 0;

    const tried = getRatingTried();
    const manualCat = getCatMap();
    // 评分和「书籍分类」都只存在于 /book/info（书架接口不带分类品类），一趟补齐
    const need = state.books
      .filter((b) => b.bookId && (!b.rating || !b.ratingCount || !b.category) && ratingExpired(tried[b.bookId]))
      .slice(0, limit)
      .map((b) => b.bookId);
    if (!need.length) return 0;

    let map = {};
    try {
      map = await WeReadClient.bookInfoBatch(need, { concurrency, onProgress });
    } catch (e) {
      if (e && e.code === 401) state.lastError = "Cookie 已过期，请重新获取";
      return 0;
    }

    let hit = 0;
    need.forEach((id) => {
      const info = map[id];
      const book = state.books.find((b) => b.bookId === id);
      if (!book || !info) return;
      const r = info.newRating != null ? info.newRating : info.rating;
      if (r) { book.rating = +(r / 10).toFixed(1); hit++; }
      if (info.newRatingCount) book.ratingCount = info.newRatingCount;
      if (info.newRatingDetail && info.newRatingDetail.title) book.ratingLabel = info.newRatingDetail.title;
      if (info.intro && !book.intro) book.intro = info.intro;
      if (info.publisher && !book.publisher) book.publisher = info.publisher;
      if (info.wordCount && !book.wordCount) book.wordCount = info.wordCount;
      // 书籍品类（经济 / 心理 / 文学…）：手工指定过的不要覆盖
      if (!manualCat[id] && !book.category) {
        const c = WeReadClient.categoryOf ? WeReadClient.categoryOf(info) : String(info.category || "").trim();
        if (c) book.category = c;
      }
    });
    markRatingTried(need);
    persistBooks(state.books);
    return hit;
  }

  /* =========================================================
   *  微信读书笔记全量同步
   *
   *  为什么单独做一遍？
   *    书架接口 /shelf/sync 只给书和进度，一条笔记都不带。
   *    笔记必须逐本去 /book/bookmarklist（划线）、/book/underlinelist（下划线）、
   *    /book/reviewlist（我的想法）拿 —— 所以这里是「按书遍历 + 并发限流」。
   *
   *  结果按 bookId 落 LS_WXNOTE，下次打开直接渲染，不用重新拉。
   * ========================================================= */
  async function syncAllNotes({ concurrency = 5, onlyMissing = false, onProgress } = {}) {
    const empty = { ok: false, books: 0, notes: 0, scanned: 0, failed: [] };
    if (state.mode !== "real" || !state.connected) {
      return { ...empty, reason: "未连接微信读书（当前是演示模式）" };
    }
    if (!WeReadClient || !WeReadClient.notesBatch) {
      return { ...empty, reason: "客户端不支持批量笔记" };
    }
    if (state.notesSyncing) return { ...empty, reason: "上一轮同步还没结束" };

    state.notesSyncing = true;
    try {
      const cached = getWxNoteMap();
      // 书架上的每一本都要扫。**不要**因为「上次 0 条」就跳过：
      // 上一轮可能正好被限流打空了，跳过的话永远补不回来。
      let targets = state.books.filter((b) => b.bookId);
      if (onlyMissing) {
        targets = targets.filter((b) => !(cached[b.bookId] && cached[b.bookId].count > 0));
      }

      /* 先问一次「哪些书有笔记」：这个内部接口时好时坏，
         能用就只请求有笔记的书（能省掉几百次空请求），用不了就全量扫。
         （2026-10-19 实测该路径 404，所以现实里基本都走全量扫。） */
      let scoped = null;
      try {
        const nb = await WeReadClient.notebooks();
        const arr = (nb && (nb.books || nb.notebooks)) || [];
        if (arr.length) {
          const set = new Set(arr.map((x) => String((x && x.bookId) || (x && x.book && x.book.bookId) || "")));
          const hit = targets.filter((b) => set.has(String(b.bookId)));
          if (hit.length) scoped = hit;
        }
      } catch (e) { /* 接口失效 → 全量扫 */ }
      if (scoped) targets = scoped;

      const ids = targets.map((b) => String(b.bookId));
      const res = await WeReadClient.notesBatch(ids, { concurrency, onProgress });

      const failed = [];
      targets.forEach((b) => {
        const id = String(b.bookId);
        const list = res[id];
        // null = 这本没拉到（网络/接口问题）→ **保留上次缓存**，绝不写空覆盖
        if (list == null) { failed.push(id); return; }
        saveWxNotes(id, list);
        // 内存里也合一遍：本地手写的保留，微信的整批替换（避免越同步越多）
        const mine = (b.notes || []).filter((n) => n.source !== "weread");
        b.notes = dedupNotes([...mine, ...list]);
      });

      persistBooks(state.books);
      const stat = noteStats();
      const summary = {
        at: Date.now(), books: stat.books, notes: stat.notes,
        scanned: ids.length, failed, totalBooks: targets.length
      };
      write(LS_NOTESYNC, summary);
      state.lastNoteSync = summary;
      return { ok: true, ...summary };
    } catch (e) {
      if (e && (e.code === 401 || /COOKIE|未登录|-2010|-2012/.test(String(e.message)))) {
        state.lastError = "Cookie 已过期，请重新获取";
      }
      return { ...empty, reason: String((e && e.message) || e) };
    } finally {
      state.notesSyncing = false;
    }
  }

  /** 只同步一本书的笔记（抽屉打开时用，顺手把最新的想法拉下来） */
  async function syncBookNotes(bookId) {
    if (state.mode !== "real" || !state.connected) return null;
    const book = state.books.find((b) => b.bookId === String(bookId));
    if (!book) return null;
    try {
      const list = await WeReadClient.notesFor(bookId);
      if (!list) return null;
      saveWxNotes(bookId, list);
      const mine = (book.notes || []).filter((n) => n.source !== "weread");
      book.notes = dedupNotes([...mine, ...list]);
      persistBooks(state.books);
      return list;
    } catch (e) {
      if (e && e.code === 401) state.lastError = "Cookie 已过期，请重新获取";
      return null;
    }
  }

  /* =========================================================
   *  笔记 CRUD（本地标注）
   * ========================================================= */
  async function saveNote(bookId, note) {
    const book = state.books.find((b) => b.bookId === bookId);
    if (!book) return delay(null);

    const local = getLocalNotes()[bookId] || [];
    const id = note.id || genId("n");
    const idx = local.findIndex((n) => n.id === id);
    const record = { ...note, id, source: "local", createdAt: note.createdAt || nowStr() };

    if (idx >= 0) local[idx] = { ...local[idx], ...record, updatedAt: nowStr() };
    else local.unshift(record);
    saveLocalNotes(bookId, local);

    // 同步进内存
    const inMem = book.notes.findIndex((n) => n.id === id);
    if (inMem >= 0) book.notes[inMem] = record;
    else book.notes.unshift(record);

    return delay(record);
  }

  async function deleteNote(bookId, noteId) {
    const book = state.books.find((b) => b.bookId === bookId);
    const note = book ? (book.notes || []).find((n) => n.id === noteId) : null;
    if (note) {
      const tag = { highlight: "划线", underline: "下划线", thought: "个人想法" }[note.type] || "笔记";
      pushTrash({
        type: "note",
        title: (book && book.title ? `《${book.title}》· ` : "") + tag,
        preview: stripHtml(note.text),
        from: "读书笔记",
        originIdx: book ? book.notes.findIndex((n) => n.id === noteId) : 0, // 还原时回到这本书的原位置
        payload: { bookId, note: { ...note } }
      });
    }
    if (book) book.notes = book.notes.filter((n) => n.id !== noteId);
    const local = (getLocalNotes()[bookId] || []).filter((n) => n.id !== noteId);
    saveLocalNotes(bookId, local);
    persistBooks(state.books);
    return delay({ ok: true });
  }

  /* =========================================================
   *  阅读状态流转
   *  - 一旦开始阅读（进度 > 0 或手动标记）：
   *      未读 → 在读
   * ========================================================= */
  /** 把「首次阅读」记录同步到 book 对象上（本地记录优先，没有就记一条） */
  function applyFirstSeen(book) {
    const seen = markFirstSeen(book.bookId);
    if (seen) {
      book.firstReadTime = seen.t;
      book.firstReadGuess = seen.guess;
    }
    book.readingDays = book.firstReadTime ? daysSince(book.firstReadTime) : 0;
    return book;
  }

  async function setProgress(bookId, progress) {
    const book = state.books.find((b) => b.bookId === bookId);
    if (!book) return delay(null);
    book.progress = Math.max(0, Math.min(100, progress));
    if (book.progress > 0 && book.status === "unread") {
      book.status = "reading";
      applyFirstSeen(book);            // 记录首次阅读时间
    }
    if (book.progress >= 100) book.status = "finished";
    persistBooks(state.books);
    return delay(book);
  }

  async function startReading(bookId) {
    const book = state.books.find((b) => b.bookId === bookId);
    if (!book) return delay(null);
    if (book.status === "unread") {
      book.status = "reading";
      if (book.progress === 0) book.progress = 1; // 标记为已开始
      applyFirstSeen(book);
      persistBooks(state.books);
    }
    return delay(book);
  }

  async function updateStatus(bookId, status) {
    const book = state.books.find((b) => b.bookId === bookId);
    if (!book) return delay(null);
    book.status = status;
    if (status === "finished") book.progress = 100;
    if (status === "reading" && book.progress === 0) book.progress = 1;
    if (status === "reading" || status === "finished") applyFirstSeen(book);
    persistBooks(state.books);
    return delay(book);
  }

  /** 手工修正首次阅读时间（微信读书未直接暴露该字段） */
  async function setFirstReadTime(bookId, timeStr) {
    const book = state.books.find((b) => b.bookId === bookId);
    if (!book) return delay(null);
    const map = getFirstSeen();
    map[bookId] = timeStr;                 // 纯字符串 = 用户确认过的确定值
    write(LS_FIRSTSEEN, map);
    book.firstReadTime = timeStr;
    book.firstReadGuess = false;
    book.readingDays = daysSince(timeStr);
    persistBooks(state.books);
    return delay(book);
  }

  /* =========================================================
   *  宝藏 CRUD（文字 + 图片并存）
   * ========================================================= */
  async function listTreasures() {
    return delay(state.treasures || (state.treasures = await loadTreasures()));
  }

  async function addTreasure(item) {
    const t = {
      id: item.id || genId("t"),
      title: item.title || "未命名",
      content: item.content || "",       // 允许 HTML（含 <mark>/<u> 标注）
      image: item.image || "",           // dataURL 或外链，可为空
      color: item.color || "#fff7d6",
      category: item.category || "",     // 所属分类 id（空 = 未分类）
      createdAt: item.createdAt || nowStr()
    };
    state.treasures.unshift(t);
    write(LS_TREASURES, state.treasures);
    return delay(t);
  }

  async function updateTreasure(id, patch) {
    const t = state.treasures.find((x) => x.id === id);
    if (!t) return delay(null);
    Object.assign(t, patch, { updatedAt: nowStr() });
    write(LS_TREASURES, state.treasures);
    return delay(t);
  }

  async function deleteTreasure(id) {
    const t = state.treasures.find((x) => x.id === id);
    if (t) {
      pushTrash({
        type: "treasure",
        title: t.title || "未命名宝藏",
        preview: stripHtml(t.content) || (t.image ? "[图片]" : ""),
        from: "我的宝藏",
        originIdx: state.treasures.findIndex((x) => x.id === id), // 记下原位置，还原时回到原位
        payload: { ...t }
      });
    }
    state.treasures = state.treasures.filter((x) => x.id !== id);
    write(LS_TREASURES, state.treasures);
    return delay({ ok: true });
  }

  /* =========================================================
   *  宝藏自定义分类
   *  数据：[{ id, name }]，宝藏通过 category 字段归属
   * ========================================================= */
  function seedCats() {
    const seed = (window.WEREAD_MOCK.DEFAULT_CATEGORIES || []).map((c) => ({ ...c }));
    write(LS_TCATS, seed);
    state.tcats = seed;
    return seed;
  }
  function getCats() {
    const v = read(LS_TCATS, null);
    return Array.isArray(v) ? v : seedCats();
  }
  function saveCats(list) { write(LS_TCATS, list); state.tcats = list; }

  async function listCategories() {
    state.tcats = getCats();
    return delay(state.tcats);
  }

  async function addCategory(name) {
    const n = String(name == null ? "" : name).trim();
    if (!n) return delay(null);
    const list = getCats();
    const dup = list.find((c) => c.name === n);
    if (dup) return delay(dup);
    const c = { id: genId("c"), name: n };
    list.push(c);
    saveCats(list);
    return delay(c);
  }

  async function renameCategory(id, name) {
    const list = getCats();
    const c = list.find((x) => x.id === id);
    if (!c) return delay(null);
    c.name = String(name == null ? "" : name).trim() || c.name;
    saveCats(list);
    return delay(c);
  }

  /** 删除分类：该类下的宝藏自动归入「未分类」，内容不丢 */
  async function removeCategory(id) {
    saveCats(getCats().filter((c) => c.id !== id));
    state.treasures.forEach((t) => { if (t.category === id) t.category = ""; });
    write(LS_TREASURES, state.treasures);
    return delay({ ok: true });
  }

  /* =========================================================
   *  宝藏回收站（删除内容统一入回收，保留 30 天）
   *  记录结构：
   *    { id, type:'treasure'|'note', title, preview, from,
   *      payload, deletedAt, expireTs }
   * ========================================================= */
  function getTrash() { return read(LS_TRASH, []); }
  function saveTrash(list) { write(LS_TRASH, list); }

  /** 清理已过期的回收项（超过回收期直接消失） */
  function purgeTrash() {
    const now = Date.now();
    const list = getTrash();
    const alive = list.filter((t) => !t.expireTs || t.expireTs > now);
    if (alive.length !== list.length) saveTrash(alive);
    state.trash = alive;
    return alive;
  }

  /** 把一条被删除的内容放进回收站 */
  function pushTrash(entry) {
    const list = purgeTrash();
    const ts = Date.now();
    list.unshift({
      id: genId("r"),
      deletedAt: fmtDT(ts),
      expireTs: ts + TRASH_TTL_DAYS * 86400000,
      ...entry
    });
    saveTrash(list);
    state.trash = list;
    return list[0];
  }

  async function listTrash() {
    const list = purgeTrash().slice().sort((a, b) => b.expireTs - a.expireTs);
    state.trash = list;
    return delay(list);
  }

  async function restoreTrash(id) {
    const list = purgeTrash();
    const item = list.find((x) => x.id === id);
    if (!item) return delay({ ok: false });
    const idx = Number.isFinite(item.originIdx) ? Math.max(0, item.originIdx) : 0;

    if (item.type === "treasure" && item.payload) {
      // 回到「我的宝藏」原来的位置
      state.treasures.splice(Math.min(idx, state.treasures.length), 0, { ...item.payload });
      write(LS_TREASURES, state.treasures);
    } else if (item.type === "note" && item.payload) {
      const { bookId, note } = item.payload;
      const restored = { ...note, id: note.id || genId("n") };
      // 回到「读书笔记」原来所属的那本书、原来的位置
      const book = state.books.find((b) => b.bookId === bookId);
      if (book) {
        if (!book.notes.some((n) => n.id === restored.id)) {
          book.notes.splice(Math.min(idx, book.notes.length), 0, restored);
        }
        persistBooks(state.books);
      }
      // 本地笔记也放回原位（微信读书来源的笔记不进本地库）
      if (restored.source !== "weread") {
        const local = (getLocalNotes()[bookId] || []).slice();
        if (!local.some((n) => n.id === restored.id)) {
          local.splice(Math.min(idx, local.length), 0, restored);
          saveLocalNotes(bookId, local);
        }
      }
    }
    saveTrash(list.filter((x) => x.id !== id));
    state.trash = getTrash();
    return delay({ ok: true });
  }

  async function removeTrash(id) {
    const list = purgeTrash().filter((x) => x.id !== id);
    saveTrash(list);
    state.trash = list;
    return delay({ ok: true });
  }

  async function emptyTrash() {
    saveTrash([]);
    state.trash = [];
    return delay({ ok: true });
  }

  /* =========================================================
   *  其它
   * ========================================================= */
  async function resetAll() {
    [LS_BOOKS, LS_TREASURES, LS_FIRSTSEEN, LS_LOCALNOTE, LS_TRASH, LS_TCATS, LS_RATING,
     LS_BOOKCAT, LS_ARCHIVE, LS_WXNOTE, LS_NOTESYNC, LS_UNDO]
      .forEach((k) => localStorage.removeItem(k));
    // 自由排版的笔记文档是按 bookId 分散存的（weread.noteDoc.v1.xxx），旧版重置漏了它们
    try {
      const docs = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(DOC_PREFIX) === 0) docs.push(k);
      }
      docs.forEach((k) => localStorage.removeItem(k));
    } catch (e) {}
    state.books = window.WEREAD_MOCK.RAW_BOOKS.map((b) => ({ ...b }));
    state.treasures = window.WEREAD_MOCK.DEFAULT_TREASURES.map((t) => ({ ...t }));
    state.trash = [];
    state.tcats = seedCats();
    state.shelfGroups = [];
    state.lastNoteSync = null;
    write(LS_BOOKS, state.books);
    write(LS_TREASURES, state.treasures);
    return delay({ ok: true });
  }

  /* =========================================================
   *  备份 / 迁移
   *  数据全在浏览器本地 → 换浏览器、换电脑、清缓存就等于丢。
   *  这里给一条正经出路：导出整包 JSON，在另一台机器上导入。
   *  默认不含 Cookie（备份文件常被随手存/发出去），要含 Cookie 必须显式勾选。
   * ========================================================= */
  function rawDocKeys() {
    const out = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(DOC_PREFIX) === 0) out.push(k);
      }
    } catch (e) {}
    return out;
  }

  function parseJSON(s) {
    try { return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }

  /** 从「键 → 原始字符串」的表里算出可读统计，用于导入前让人确认一遍 */
  function countsOf(data) {
    const books = parseJSON(data[LS_BOOKS]) || [];
    const wx = parseJSON(data[LS_WXNOTE]) || {};
    const local = parseJSON(data[LS_LOCALNOTE]) || {};
    const tre = parseJSON(data[LS_TREASURES]) || [];
    const cats = parseJSON(data[LS_BOOKCAT]) || {};
    let wxNotes = 0, localNotes = 0, bookNotes = 0;
    Object.keys(wx).forEach((k) => {
      const v = wx[k];
      if (v && Array.isArray(v.notes)) wxNotes += v.notes.length;
    });
    Object.keys(local).forEach((k) => {
      const v = local[k];
      if (Array.isArray(v)) localNotes += v.length;
    });
    // 书籍缓存里也嵌着本地笔记（persistBooks 只剔掉 source==="weread" 的），
    // 演示数据 / 手写笔记都在这；取两者较大值，避免「同步过一次就少算」。
    if (Array.isArray(books)) {
      books.forEach((b) => { if (b && Array.isArray(b.notes)) bookNotes += b.notes.length; });
    }
    const localTotal = Math.max(localNotes, bookNotes);
    return {
      books: Array.isArray(books) ? books.length : 0,
      wxNotes, localNotes: localTotal, notes: wxNotes + localTotal,
      treasures: Array.isArray(tre) ? tre.length : 0,
      categorized: Object.keys(cats).length,
      docs: Object.keys(data).filter((k) => k.indexOf(DOC_PREFIX) === 0).length
    };
  }

  /** 只看「本机有什么」，不打包整份数据（设置抽屉里显示用） */
  function backupSummary() {
    const snap = {};
    BACKUP_KEYS.forEach((k) => {
      const v = localStorage.getItem(k);
      if (v != null) snap[k] = v;
    });
    const c = countsOf(snap);
    c.docs = rawDocKeys().length;
    return c;
  }

  function exportBackup(opts) {
    const includeCookie = !!(opts && opts.includeCookie);
    const data = {};
    BACKUP_KEYS.forEach((k) => {
      const v = localStorage.getItem(k);
      if (v != null) data[k] = v;
    });
    rawDocKeys().forEach((k) => { data[k] = localStorage.getItem(k) || ""; });
    if (includeCookie) {
      const c = localStorage.getItem(LS_COOKIE_KEY);
      if (c) data[LS_COOKIE_KEY] = c;
    }
    return {
      app: BACKUP_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      counts: countsOf(data),
      hasCookie: !!data[LS_COOKIE_KEY],
      data
    };
  }

  /** 校验并读出备份文件摘要（不写任何东西），给 UI 显示「这份备份里有什么」 */
  function readBackupFile(obj) {
    if (!obj || typeof obj !== "object") throw new Error("文件不是 JSON 对象");
    if (obj.app !== BACKUP_FORMAT) throw new Error("这不是本工作台导出的备份文件");
    if (!obj.data || typeof obj.data !== "object") throw new Error("备份文件里没有 data 字段");
    const keys = Object.keys(obj.data).filter((k) => typeof obj.data[k] === "string");
    if (!keys.length) throw new Error("备份文件里没有可导入的数据");
    return {
      keys,
      counts: countsOf(obj.data),
      exportedAt: obj.exportedAt || "",
      hasCookie: !!obj.data[LS_COOKIE_KEY]
    };
  }

  /**
   * 导入备份。
   * exact（默认 true）= 真正「恢复到这个快照」：快照里没有的键会被清掉。
   * 少了这一步，撤销就恢复不了「导入前本来没有的数据」，只是叠加。
   * Cookie 与 LS_UNDO 永远不参与删除。
   */
  async function importBackup(obj, opts) {
    const exact = !(opts && opts.exact === false);
    const { keys, counts } = readBackupFile(obj);
    // 导入前先把当前数据存一份（不含 Cookie），出问题能一键退回
    let undo = null;
    try { undo = JSON.stringify(exportBackup({ includeCookie: false })); } catch (e) {}

    let written = 0, skipped = 0, dropped = 0;
    keys.forEach((k) => {
      const known = BACKUP_KEYS.indexOf(k) !== -1 || k.indexOf(DOC_PREFIX) === 0 || k === LS_COOKIE_KEY;
      if (!known) { skipped++; return; }
      try { localStorage.setItem(k, obj.data[k]); written++; } catch (e) { skipped++; }
    });

    if (exact) {
      BACKUP_KEYS.forEach((k) => {
        if (k in obj.data) return;
        try { localStorage.removeItem(k); dropped++; } catch (e) {}
      });
      rawDocKeys().forEach((k) => {
        if (k in obj.data) return;
        try { localStorage.removeItem(k); dropped++; } catch (e) {}
      });
    }

    if (undo) { try { localStorage.setItem(LS_UNDO, undo); } catch (e) {} }
    state.lastNoteSync = read(LS_NOTESYNC, null);
    return delay({ ok: true, written, skipped, dropped, counts });
  }

  function canUndoImport() {
    try { return !!localStorage.getItem(LS_UNDO); } catch (e) { return false; }
  }

  /** 撤销上一次导入：把导入前的快照写回去，快照本身保留，可以反复退回 */
  async function undoImport() {
    let raw = null;
    try { raw = localStorage.getItem(LS_UNDO); } catch (e) {}
    if (!raw) throw new Error("没有可撤销的导入");
    const obj = JSON.parse(raw);
    const r = await importBackup(obj);
    try { localStorage.setItem(LS_UNDO, raw); } catch (e) {}
    return r;
  }

  /** 把「代理连不上」翻译成一句能照着做的话 —— 只说「未启动」等于没说 */
  function proxyFailMsg(info) {
    if (info.file) {
      return `你是直接双击 index.html 打开的（file://），浏览器禁止向本地代理发请求。` +
             `请双击项目里的「启动工作台.bat」，然后用 http://localhost:${info.port} 打开页面。`;
    }
    if (info.href && info.href.indexOf("localhost") < 0 && info.href.indexOf("127.0.0.1") < 0) {
      return `当前页面地址是「${info.href}」，不是 server.js 提供的地址，所以找不到代理。` +
             `请改用 http://localhost:${info.port} 打开（双击「启动工作台.bat」会自动开好服务）。`;
    }
    return `本机 ${info.port} 端口上没有响应。请先运行 node server.js（或双击「启动工作台.bat」），` +
           `再回来点「测试连接」。`;
  }

  async function testConnection() {
    const ck = WeReadClient.cookieCheck();
    if (ck.empty) return { ok: false, msg: "还没有粘贴 Cookie" };
    if (!ck.ok) {
      return {
        ok: false,
        msg: `Cookie 里没找到登录标识（${ck.need.join(" / ")}）。请回到 weread.qq.com，F12 → Network → ` +
             `复制请求头里完整的 Cookie 整行（不要只复制一半）。`
      };
    }

    const info = await WeReadClient.proxyInfo();
    if (!info.base) return { ok: false, msg: proxyFailMsg(info) };

    try {
      const raw = await WeReadClient.shelf();
      const n = (raw.books || []).length;
      const via = info.fallback ? `（已自动改用 http://localhost:${info.port}）` : "";
      return { ok: true, msg: `连接成功${via}，读取到 ${n} 本书` };
    } catch (e) {
      if (e.code === 401 || /-2010|用户不存在|未登录/.test(String(e.message))) {
        return { ok: false, msg: "Cookie 已过期或无效（微信读书返回未登录）。请重新登录 weread.qq.com 再复制一次 Cookie。" };
      }
      return { ok: false, msg: `请求失败：${e.message}` };
    }
  }

  /* =========================================================
   *  笔记文档（自由排版 + 行内标注）
   * ========================================================= */
  function docKey(bookId) { return `weread.noteDoc.v1.${bookId}`; }
  async function saveNoteDoc(bookId, html) {
    try { localStorage.setItem(docKey(bookId), html || ""); } catch (e) {}
    return delay({ ok: true });
  }
  async function getNoteDoc(bookId) {
    try { return delay(localStorage.getItem(docKey(bookId)) || ""); } catch (e) { return delay(""); }
  }

  global.WEREAD_API = {
    state,
    loadBooks, loadTreasures, getBookDetail, fetchBookDeep, enrichRatings,
    syncAllNotes, syncBookNotes, clearWxNotes, getWxNotes, totalWxNotes, booksWithNotes,
    noteStats, notesGrouped,
    saveNote, deleteNote, saveNoteDoc, getNoteDoc,
    setProgress, startReading, updateStatus, setFirstReadTime,
    setBookCategory, catOf, setShelfGroups, groupOfBook,
    listTreasures, addTreasure, updateTreasure, deleteTreasure,
    listCategories, addCategory, renameCategory, removeCategory,
    listTrash, restoreTrash, removeTrash, emptyTrash,
    exportBackup, readBackupFile, importBackup, canUndoImport, undoImport, countsOf, backupSummary,
    resetAll, testConnection,
    todayStr, TRASH_TTL_DAYS
  };
})(window);

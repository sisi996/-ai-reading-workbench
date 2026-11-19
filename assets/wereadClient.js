/* ==========================================================
 *  wereadClient.js — 微信读书（网页版）真实接口客户端
 *
 *  说明：微信读书没有官方开放 API。这里调用的是网页版内部接口
 *       （weread.qq.com/web/...），必须携带登录 Cookie。
 *       由于浏览器同源策略，请求统一走本地代理 /api/weread/*，
 *       由 server.js 转发并附带 Cookie。
 *
 *  依赖：Need-Proxy（server.js 运行时可用）
 * ========================================================== */
(function (global) {

  const LS_COOKIE = "weread.cookie.v1";
  const LS_MODE   = "weread.mode.v1";     // 'real' | 'demo'

  /* ---------- 代理地址 ----------
   * 最理想的情况：页面就是由 server.js 提供的（http://localhost:8787），
   * 此时 /api/weread 是同源相对路径，直接可用。
   *
   * 但很多人会「双击 index.html」用 file:// 打开，或者在别的端口/预览器里看页面，
   * 这时相对路径 /api/weread 会解析成 file:///api/weread —— 必然失败，
   * 界面就只给一句「本地代理未启动」，完全看不出真正原因。
   *
   * 所以这里做两级候选：同源优先，失败再试绝对地址 http://localhost:8787
   * （server.js 已经返回 Access-Control-Allow-Origin: *，跨域也能通）。
   * 这样只要 server.js 在跑，几乎不会再出现「代理未启动」。 */
  const PROXY_PORT   = 8787;
  const SAME_ORIGIN  = "/api/weread";
  const LOCAL_PROXY  = `http://localhost:${PROXY_PORT}/api/weread`;
  const PROXY_BASE   = SAME_ORIGIN;   // 兼容旧引用

  let proxyAvailable = null; // 惰性探测（只缓存成功结果）
  let resolvedBase = null;   // 已确认可用的代理地址

  function isFilePage() {
    return typeof location !== "undefined" && location.protocol === "file:";
  }

  async function ping(base) {
    try {
      const r = await fetch(`${base}/__ping`, { method: "GET", cache: "no-store" });
      return r.ok ? base : null;
    } catch (e) {
      return null;   // file:// 下 fetch 直接抛，不会走到 r.ok
    }
  }

  /** 逐级探测可用的代理地址；失败不缓存，下次调用还会重试（服务后启动也能连上） */
  async function resolveBase() {
    if (resolvedBase) return resolvedBase;
    const list = [];
    if (!isFilePage()) list.push(SAME_ORIGIN);
    if (list.indexOf(LOCAL_PROXY) < 0) list.push(LOCAL_PROXY);
    for (const b of list) {
      const hit = await ping(b);
      if (hit) { resolvedBase = hit; proxyAvailable = true; return hit; }
    }
    resolvedBase = null;
    proxyAvailable = false;      // 注意：失败不锁死，下一轮仍会重试
    return null;
  }

  /** 给界面用的诊断信息：页面地址 + 实际连上的代理 */
  async function proxyInfo() {
    const base = await resolveBase();
    return {
      base,
      port: PROXY_PORT,
      href: (typeof location !== "undefined" ? location.href : ""),
      file: isFilePage(),
      fallback: !!base && base === LOCAL_PROXY && !isFilePage()
    };
  }

  /* ---------- Cookie 存取 ---------- */
  function getCookie() {
    return localStorage.getItem(LS_COOKIE) || "";
  }
  function setCookie(c) {
    localStorage.setItem(LS_COOKIE, (c || "").trim());
  }
  function clearCookie() {
    localStorage.removeItem(LS_COOKIE);
  }
  function hasCookie() {
    const c = getCookie();
    return /wr_vid=/.test(c) || /wr_skey=/.test(c) || /wr_rt=/.test(c);
  }

  /** Cookie 体检：告诉用户到底缺哪一段，而不是笼统一句「未填写 Cookie」 */
  function cookieCheck() {
    const c = getCookie();
    const NEED = ["wr_vid", "wr_skey", "wr_rt"];
    const found = NEED.filter((k) => new RegExp(`\\b${k}=`).test(c));
    return { empty: !c.trim(), found, need: NEED, ok: found.length > 0, len: c.length };
  }

  function getMode() {
    return localStorage.getItem(LS_MODE) || "demo";
  }
  function setMode(m) {
    localStorage.setItem(LS_MODE, m);
  }

  /* ---------- 代理可用性探测 ---------- */
  async function probeProxy() {
    return !!(await resolveBase());
  }

  /* ---------- 底层请求 ---------- */
  async function request(path, { method = "GET", body = null } = {}) {
    const base = await resolveBase();
    if (!base) throw new Error("NO_PROXY");

    const headers = {
      "X-Weread-Cookie": getCookie()
    };
    if (body) headers["Content-Type"] = "application/json";

    const resp = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    if (resp.status === 401) {
      const err = new Error("COOKIE_EXPIRED");
      err.code = 401;
      throw err;
    }
    if (!resp.ok) {
      const err = new Error(`HTTP_${resp.status}`);
      err.code = resp.status;
      throw err;
    }
    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  }

  /* =========================================================
   *  业务接口
   * ========================================================= */

  /** 书架全量（含进度） */
  async function shelf() {
    const data = await request(`/shelf/sync?synckey=0&teenmode=0&album=1&onlyBookid=0`);
    assertNoError(data);
    return data;
  }

  /** 微信读书错误码统一处理（字段名可能是 errcode 或 errCode） */
  function assertNoError(data) {
    if (!data || typeof data !== "object") return data;
    const code = data.errcode != null ? data.errcode : data.errCode;
    if (code == null || code === 0) return data;

    const e = new Error(`WEREAD_${code}: ${data.errMsg || ""}`);
    e.wereadCode = code;
    // -2010 用户不存在（通常是没带 Cookie / Cookie 无效）
    // -2012 会话过期（skey 失效）
    if (code === -2010 || code === -2012 || code === -2011) e.code = 401;
    throw e;
  }

  /** 书籍详情
   *  实测：GET /web/book/info?bookId=xxx 是有效的（无 Cookie 时返回 errCode -2010）；
   *  POST /web/book/info 会 404。这里先 GET，POST 只作为将来换接口时的兜底。 */
  async function bookInfo(bookId) {
    const id = String(bookId || "");
    const attempts = [
      () => request(`/book/info?bookId=${encodeURIComponent(id)}`),
      () => request(`/book/info`, { method: "POST", body: { bookId: id } })
    ];
    let lastErr = null;
    for (const run of attempts) {
      try {
        const data = await run();
        const code = (data && typeof data === "object")
          ? (data.errcode != null ? data.errcode : data.errCode)
          : null;
        if (code == null || code === 0) {
          if (data && typeof data === "object" && (data.bookId || data.title || data.newRating != null)) return data;
        } else {
          lastErr = new Error(`WEREAD_${code}`);
        }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("BOOK_INFO_FAILED");
  }

  /**
   * 批量书籍详情（并发受限），返回 { bookId: info|null }
   * 微信读书没有批量详情接口，只能逐本请求 —— 所以要限并发，别把接口打挂。
   */
  async function bookInfoBatch(ids, { concurrency = 4, onProgress } = {}) {
    const list = (ids || []).map((x) => String(x || "")).filter(Boolean);
    const out = {};
    let cursor = 0;
    let done = 0;
    async function worker() {
      while (cursor < list.length) {
        const id = list[cursor++];
        try { out[id] = await bookInfo(id); } catch (e) { out[id] = null; }
        done++;
        if (typeof onProgress === "function") {
          try { onProgress(done, list.length); } catch (e) {}
        }
      }
    }
    const n = Math.max(1, Math.min(concurrency, list.length));
    await Promise.all(Array.from({ length: n }, worker));
    return out;
  }

  /** 从接口响应里挑出真正的数组（微信读书不同接口用的字段名不一样） */
  function pickList(data, keys) {
    if (!data || typeof data !== "object") return [];
    for (const k of (keys || [])) {
      if (Array.isArray(data[k])) return data[k];
    }
    return [];
  }

  /* 下划线接口实测（2026-10-19 带假 Cookie 探路径）：/web/book/underlinelist 直接 404 ——
     这条路径已经不存在了，不是「没权限」。所以不能对每本书都试一次：
     一百多本书就是一百多个必然失败的请求，既拖慢同步又容易被判成限流。
     这里做一次性探测：第一本试一下，404 就整轮跳过（刷新页面后重置）。 */
  let underlineOK = null;    // null = 还没试过 / false = 接口不存在 / true = 可用
  let underlineProbe = null; // 共享的探测 Promise（并发抓笔记时也只发一次）

  function probeUnderline(bookId) {
    if (underlineOK !== null) return Promise.resolve(underlineOK);
    if (!underlineProbe) {
      underlineProbe = request(`/book/underlinelist?bookId=${encodeURIComponent(bookId)}&synckey=0`)
        .then((d) => { assertNoError(d); underlineOK = true; return true; })
        .catch((e) => {
          if (e && e.code === 401) { underlineProbe = null; throw e; }   // 登录问题，下次重试
          underlineOK = false;
          return false;
        });
    }
    return underlineProbe;
  }

  async function underlines(bookId) {
    if (underlineOK === false) return [];
    if (!(await probeUnderline(bookId))) return [];
    const d = await request(`/book/underlinelist?bookId=${encodeURIComponent(bookId)}&synckey=0`);
    assertNoError(d);
    return pickList(d, ["updated", "underlines"]);
  }

  /**
   * 书籍划线（外加可用的下划线）。
   *
   * ⚠️ 请求失败一定要抛出去，**不能 catch 成空数组**：
   *    以前这里 `.catch(() => ({}))`，于是「登录超时 / 触发限流」被当成
   *    「这本书没有笔记」，同步时又把缓存覆盖成 0 条 —— 历史笔记看起来就"丢了"。
   */
  async function bookmarks(bookId) {
    const id = encodeURIComponent(bookId);
    const d = await request(`/book/bookmarklist?bookId=${id}&synckey=0`);
    assertNoError(d);
    const marks = pickList(d, ["updated", "bookmarks"]);
    const uls = await underlines(bookId).catch((e) => { if (e && e.code === 401) throw e; return []; });
    return { bookmarks: marks, underlines: uls };
  }

  /**
   * 我在某本书下写的想法（微信读书里叫「点评 / 想法」）。
   *
   * 只有 /web/review/list?listType=11&mine=1 这条是通的
   * （/web/book/reviewlist 实测 404），而且它**是分页的**：
   * 每页最多几十条，靠响应的 hasMore + syncKey 往后翻。
   * 旧代码只读第一页 —— 这是「历史笔记同步不全」最主要的原因。
   */
  async function bookReviews(bookId, { maxPages = 40, pageSize = 100 } = {}) {
    const id = encodeURIComponent(bookId);
    const out = [];
    let syncKey = 0;
    for (let page = 0; page < maxPages; page++) {
      const d = await request(
        `/review/list?bookId=${id}&listType=11&mine=1&syncKey=${encodeURIComponent(syncKey)}&count=${pageSize}`);
      assertNoError(d);
      if (!d || typeof d !== "object") break;
      const list = pickList(d, ["reviews"]);
      if (list.length) out.push(...list);

      const more = d.hasMore === 1 || d.hasMore === true || d.hasMore === "1";
      const next = d.syncKey != null ? d.syncKey : d.synckey;
      if (!more || next == null || String(next) === String(syncKey)) break;
      syncKey = next;
    }
    return out;
  }

  /** 书籍章节 */
  async function chapterInfos(bookId) {
    return assertNoError(await request(`/book/chapterInfos`, {
      method: "POST",
      body: { bookIds: [String(bookId)], synckeys: [0], teenmode: 0 }
    }));
  }

  /** 章节 uid → 章节标题。只有划线里没带 chapterTitle 时才需要拉一次目录。 */
  async function chapterMap(bookId) {
    try {
      const d = await chapterInfos(bookId);
      const arr = pickList(d, ["data"]);
      const hit = arr.find((x) => x && String(x.bookId) === String(bookId)) || arr[0] || {};
      const updated = pickList(hit, ["updated", "chapters"]);
      const m = {};
      updated.forEach((u) => {
        if (u && u.chapterUid != null && u.title) m[String(u.chapterUid)] = String(u.title).trim();
      });
      return m;
    } catch (e) {
      return {};
    }
  }

  /** 读者评论（公开） */
  async function reviews(bookId, count = 20) {
    return request(`/review/list?bookId=${encodeURIComponent(bookId)}&listType=4&maxIdx=0&count=${count}`).then(assertNoError);
  }

  /** 我的想法 / 点评 */
  async function myReviews(bookId) {
    return request(`/review/list?bookId=${encodeURIComponent(bookId)}&listType=11&mine=1&syncKey=0`).then(assertNoError);
  }

  /** 我的笔记本（有笔记的书）
   *  ⚠️ 2026-10-19 实测 /web/user/notebooks 返回 404（路径已下线），
   *  这里保留只为将来恢复时能直接用；同步逻辑**不能依赖它**，必须能全量扫。 */
  async function notebooks() {
    return assertNoError(await request(`/user/notebooks`));
  }

  /** 阅读信息（时长 / 阅读天数线索） */
  async function readInfo(bookId) {
    return request(`/book/readinfo?bookId=${encodeURIComponent(bookId)}`).then(assertNoError).catch(() => null);
  }

  /* =========================================================
   *  规范化：把微信读书原始结构转成我们内部的书模型
   * ========================================================= */
  function tsToStr(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function daysBetween(fromStr) {
    if (!fromStr) return 0;
    const t = new Date(fromStr.replace(/-/g, "/")).getTime();
    if (isNaN(t)) return 0;
    return Math.max(1, Math.ceil((Date.now() - t) / 86400000));
  }

  /**
   * 进度归一化 → 0~100 的整数百分数
   *
   *  ⚠️ 微信读书不同接口的 progress 单位并不统一，实测遇到过三种：
   *      · 0-100  的百分数       36    → 36%
   *      · 0-10000 的「万分比」  3600  → 36%（99.00% 会返回 9900）
   *      · 0-1    的小数         0.36  → 36%
   *  以前直接 `progress * 100`，于是 36% 被显示成 3600%，
   *  而且 3600 >= 100 会被判成「已读」→「我的在读」永远是空的。
   */
  function toPercent(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return 0;
    if (n < 1) return Math.round(n * 100);            // 0.36 → 36
    if (n <= 100) return Math.round(n);               // 36   → 36
    return Math.min(100, Math.round(n / 100));        // 3600 → 36
  }

  /**
   * 归一化一本微信读书书籍
   * @param {object} raw    shelf.sync 中的 books[] 元素
   * @param {object} prog   shelf.sync 中 bookProgress[] 里对应的进度
   */
  function normalizeBook(raw, prog) {
    /* ---- 进度 ---- */
    let rawProgress = 0;
    if (prog && prog.progress != null) {
      rawProgress = prog.progress;
    } else if (Array.isArray(raw.progress) && raw.progress.length) {
      const p = raw.progress[raw.progress.length - 1];
      if (p && p.progress != null) rawProgress = p.progress;
    }
    let progress = toPercent(rawProgress);
    if (raw.finishReading === 1) progress = 100;      // 标记读完 → 100%

    /* ---- 状态：读完 / 在读 / 未读 ---- */
    let status = "unread";
    if (progress >= 100) status = "finished";
    else if (progress > 0) status = "reading";

    const lastRead = raw.readUpdateTime || (prog && prog.updateTime) || 0;

    /* ---- 评分：shelf 里一般没有，靠 /book/info 补（见 apiService.enrichRatings） ---- */
    const ratingRaw = raw.newRating != null ? raw.newRating : raw.rating;
    const detail = raw.newRatingDetail || null;

    return {
      bookId: String(raw.bookId || ""),
      title: raw.title || "未命名",
      author: raw.author || "佚名",
      publisher: raw.publisher || "",
      cover: normalizeCover(raw.cover),
      category: categoryOf(raw),   // 书籍品类（经济 / 心理 / 文学…），空串 = 微信读书没给
      group: "",                   // 微信读书书架分组名，由 archive[] 回填（见 apiService）
      intro: raw.intro || (raw.soldout === 1 ? "该书已下架" : ""),
      status,
      progress,
      finishReading: raw.finishReading || 0,
      // 微信读书的 rating / newRating 都是 0-100，除以 10 得到 0-10 分
      rating: ratingRaw ? +(ratingRaw / 10).toFixed(1) : 0,
      ratingCount: raw.newRatingCount || raw.ratingCount || 0,
      ratingLabel: (detail && typeof detail.title === "string") ? detail.title : "",
      wordCount: raw.wordCount || 0,
      lastReadTime: lastRead,
      lastReadStr: tsToStr(lastRead),
      readUpdateTime: tsToStr(lastRead),
      /* 微信读书没暴露「首次阅读」，只有「最后阅读」。
         先拿最后阅读时间占位，但打上 guess 标记 —— 前端会显示成「最近阅读」而不是
         冒充「首次阅读」；等用户手工修正（或本地首次见到该书）后再变成确定值。 */
      firstReadTime: tsToStr(lastRead),
      firstReadGuess: true,
      readingDays: daysBetween(tsToStr(lastRead)),
      notes: [],
      reviews: []
    };
  }

  /** 微信读书封面有时带 http 前缀或需要换域，统一成 https 并加尺寸参数 */
  function normalizeCover(url) {
    if (!url) return "";
    let u = String(url);
    if (u.startsWith("http://")) u = "https://" + u.slice(7);
    if (u.startsWith("//")) u = "https:" + u;
    return u;
  }

  /** 解析 shelf.sync 的整体响应 */
  function parseShelf(data) {
    if (!data) return [];
    const books = data.books || [];
    const progress = data.bookProgress || [];
    const progMap = {};
    progress.forEach((p) => { progMap[String(p.bookId)] = p; });

    return books
      .filter((b) => b && b.bookId)
      .map((b) => normalizeBook(b, progMap[String(b.bookId)]));
  }

  /* ---------- 书架分组（微信读书自己的「分组」）----------
   * /shelf/sync 除了 books[] 还会返回 archive[]：{ archiveId, name, bookIds[] }
   * 这是用户在微信读书里自己建的书架分组，是「分类」最权威的来源。
   * books[] 条目本身不带分组 id，只有 archive 里的 bookIds 能说明归属。
   * 拿不到就返回空数组 —— 上层会退回用书籍自身的 category 字段。 */
  function parseArchive(data) {
    const arr = (data && Array.isArray(data.archive)) ? data.archive : [];
    const out = [];
    arr.forEach((g) => {
      if (!g) return;
      const id = String(g.archiveId != null ? g.archiveId : (g.id || ""));
      const name = String(g.name || g.title || "").trim();
      const ids = Array.isArray(g.bookIds) ? g.bookIds.map(String) : [];
      if (id && name) out.push({ id, name, bookIds: ids });
    });
    return out;
  }

  /** 书籍分类（品类，如「心理学」「经济」）—— shelf 的 books[].category，
   *  /book/info 里也有同名字段，取不到时返回空串，由 UI 显示为「未分类」 */
  function categoryOf(raw) {
    if (!raw || typeof raw !== "object") return "";
    const v = raw.category != null ? raw.category : (raw.categoryName != null ? raw.categoryName : "");
    return String(v || "").trim();
  }

  /**
   * 把微信读书的「划线 / 下划线 / 想法」统一转成我们内部的笔记结构。
   *
   *  - 每条笔记都由调用方带上 bookId 归属，所以笔记不会串到别的书上去；
   *  - 一条划线如果下面还写了想法，想法挂在 comment 上（合并成一张卡，不重复计数）；
   *  - 没有引用原文、纯粹的想法，单独成一条 thought。
   *
   * @param {string} bookId
   * @param {object} raw  { bookmarks[], underlines[], reviews[], chapterMap{} }
   */
  function parseNotes(bookId, raw) {
    const cmap = (raw && raw.chapterMap) || {};
    const out = [];

    const chapterOf = (it) => {
      const t = String(it.chapterTitle || it.chapterName || "").trim();
      if (t) return t;
      const uid = it.chapterUid != null ? String(it.chapterUid) : "";
      return (uid && cmap[uid]) || "";
    };
    const uidOf = (it) => (it.chapterUid != null ? String(it.chapterUid) : "");
    const timeOf = (it) => tsToStr(it.createTime || it.ctime || it.updateTime || 0);
    const rid = (prefix, it, ...keys) => {
      for (const k of keys) if (it[k] != null && it[k] !== "") return `${prefix}-${it[k]}`;
      return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
    };

    const add = (o) => {
      if (!o.text) return;
      out.push(o);
    };

    /* ---- 划线（markText 是原文，reviewText 是你写在划线下的想法） ---- */
    pickList(raw, ["bookmarks"]).forEach((bm) => {
      const text = String(bm.markText || bm.markTextAbstract || "").trim();
      const comment = String(bm.reviewText || (bm.review && bm.review.content) || "").trim();
      if (!text) {
        if (comment) add({ id: rid("wxth", bm, "reviewId", "bookmarkId"), type: "thought", text: comment,
          chapter: chapterOf(bm), chapterUid: uidOf(bm), comment: "", source: "weread", createdAt: timeOf(bm) });
        return;
      }
      add({ id: rid("wxbm", bm, "bookmarkId"), type: "highlight", text,
        chapter: chapterOf(bm), chapterUid: uidOf(bm), comment, source: "weread", createdAt: timeOf(bm) });
    });

    /* ---- 下划线 ---- */
    pickList(raw, ["underlines"]).forEach((ul) => {
      const text = String(ul.markText || ul.markTextAbstract || "").trim();
      const comment = String(ul.reviewText || (ul.review && ul.review.content) || "").trim();
      if (!text) return;
      add({ id: rid("wxul", ul, "bookmarkId"), type: "underline", text,
        chapter: chapterOf(ul), chapterUid: uidOf(ul), comment, source: "weread", createdAt: timeOf(ul) });
    });

    /* ---- 我的想法（独立接口）：abstract 是被划的那句原文，content 是想法 ---- */
    pickList(raw, ["reviews"]).forEach((r) => {
      const it = (r && r.review) ? r.review : r;
      if (!it || typeof it !== "object") return;
      const content = String(it.content || it.reviewText || "").trim();
      const abs = String(it.abstract || it.markText || "").trim();
      const chapter = chapterOf(it);
      if (abs) {
        add({ id: rid("wxrv", it, "reviewId"), type: "highlight", text: abs,
          chapter, chapterUid: uidOf(it), comment: content, source: "weread", createdAt: timeOf(it) });
      } else if (content) {
        add({ id: rid("wxth", it, "reviewId"), type: "thought", text: content,
          chapter, chapterUid: uidOf(it), comment: "", source: "weread", createdAt: timeOf(it) });
      }
    });

    /* ---- 去重：同一段原文 + 同一种类型只留一条（划线接口和想法接口会重叠） ---- */
    const seen = new Set();
    const dedup = out.filter((n) => {
      const k = `${n.type}|${n.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    /* ---- 排序：跟着书的章节顺序走（读起来才连贯），同章节按时间 ---- */
    dedup.sort((a, b) => {
      const ua = Number(a.chapterUid), ub = Number(b.chapterUid);
      const ha = isFinite(ua) && a.chapterUid !== "", hb = isFinite(ub) && b.chapterUid !== "";
      if (ha && hb && ua !== ub) return ua - ub;
      if (ha !== hb) return ha ? -1 : 1;
      return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
    return dedup;
  }

  /**
   * 一次拿齐某本书的所有笔记（划线 + 下划线 + 我的想法）。
   * 章节名缺失时才补拉一次目录，尽量少发请求。
   */
  async function notesFor(bookId) {
    // 划线 / 想法是两个独立接口 —— 并发发，一本书的耗时从「两跳」压成「一跳」
    const [raw, reviews] = await Promise.all([
      bookmarks(bookId),                                    // 失败会抛（不吞）
      bookReviews(bookId).catch((e) => {
        if (e && e.code === 401) throw e;                   // 登录失效 → 让上层中止整轮
        return [];                                          // 单本想法取不到，划线还在，不整本判死
      })
    ]);
    let notes = parseNotes(bookId, { ...raw, reviews });
    if (notes.length && notes.some((n) => !n.chapter)) {
      const cmap = await chapterMap(bookId);
      if (Object.keys(cmap).length) {
        notes = notes.map((n) => (n.chapter || !n.chapterUid ? n : { ...n, chapter: cmap[n.chapterUid] || "" }));
      }
    }
    return notes;
  }

  /**
   * 批量拉多本书的笔记（并发受限 + 失败重试一次）。
   *
   * 为什么要重试：一百多本书连续请求，微信读书偶尔会回一两个 500 / 超时。
   * 旧逻辑一次失败就记 null，那本书整轮没笔记 —— 对账时就会看到「97 本里有笔记，
   * 我这边只有几十本」。重试一轮成本很低，但能把这种抖动抹平。
   *
   * Cookie 失效（401）时直接停：继续扫下去只会得到一屏 null，没意义。
   *
   * @returns {Promise<Object>} { bookId: notes[] | null }（null = 这本确实没拉到）
   */
  async function notesBatch(ids, { concurrency = 5, retries = 1, onProgress } = {}) {
    const list = (ids || []).map((x) => String(x || "")).filter(Boolean);
    const out = {};
    let done = 0;
    let authDead = false;

    async function run(queue) {
      let cursor = 0;
      async function worker() {
        while (cursor < queue.length && !authDead) {
          const id = queue[cursor++];
          try {
            out[id] = await notesFor(id);
          } catch (e) {
            if (e && e.code === 401) { authDead = true; out[id] = null; }
            else out[id] = null;
          }
          done++;
          if (typeof onProgress === "function") {
            try { onProgress(Math.min(done, list.length), list.length, id); } catch (e) {}
          }
        }
      }
      const n = Math.max(1, Math.min(concurrency, queue.length || 1));
      await Promise.all(Array.from({ length: n }, worker));
    }

    await run(list);

    // 只重试「真的失败」的那几本，成功的别再打一遍
    for (let round = 0; round < retries && !authDead; round++) {
      const retry = list.filter((id) => out[id] === null);
      if (!retry.length) break;
      await run(retry);
    }
    if (authDead) {
      const e = new Error("COOKIE_EXPIRED");
      e.code = 401;
      throw e;
    }
    return out;
  }

  /** 把微信读书评论转成我们的结构 */
  function parseReviews(data) {
    const list = (data && (data.reviews || [])) || [];
    return list.slice(0, 8).map((r) => {
      const rv = r.review || r;
      return {
        user: (rv.author && (rv.author.name || rv.author.nick)) || "读者",
        content: rv.content || "",
        star: rv.star ? Math.round(rv.star / 20) : 5,
        likeCount: rv.likeCount || 0
      };
    }).filter((r) => r.content);
  }

  global.WeReadClient = {
    // 配置
    getCookie, setCookie, clearCookie, hasCookie, cookieCheck,
    getMode, setMode,
    probeProxy, proxyInfo,

    // 原始接口
    shelf, bookInfo, bookInfoBatch, bookmarks, bookReviews, chapterInfos, chapterMap,
    reviews, myReviews, notebooks, readInfo,

    // 规范化
    parseShelf, parseArchive, categoryOf, parseNotes, parseReviews, normalizeBook, tsToStr, toPercent,

    // 笔记（划线 + 下划线 + 想法）
    notesFor, notesBatch,

    // 一次性拉取整本书（含笔记 / 评论）
    async fetchBookBundle(book) {
      const out = { ...book, notes: [], reviews: [] };
      try {
        const [notes, revRaw, info] = await Promise.all([
          notesFor(book.bookId),
          reviews(book.bookId).catch(() => null),
          bookInfo(book.bookId).catch(() => null)
        ]);
        out.notes = notes;
        out.reviews = parseReviews(revRaw);
        if (info) {
          if (info.intro) out.intro = info.intro;
          if (info.publisher) out.publisher = info.publisher;
          if (info.newRating) out.rating = +(info.newRating / 10).toFixed(1);
          if (info.newRatingCount) out.ratingCount = info.newRatingCount;
          if (info.newRatingDetail && info.newRatingDetail.title) out.ratingLabel = info.newRatingDetail.title;
        }
      } catch (e) {
        if (e.code === 401) throw e;
      }
      return out;
    }
  };
})(window);

/* ==========================================================
 *  search.js — 本地检索引擎（纯离线，零依赖，不发任何网络请求）
 *
 *  为什么不用 embedding：
 *    真正的语义检索需要向量模型（几十 MB 权重 + 首次下载），
 *    而这个工作台要在没有服务、断网、甚至 file:// 打开时都能用。
 *    所以这里用「中文二元组 + BM25」——不联网、不加载模型、毫秒级，
 *    比原来的 includes() 子串匹配强的点是：
 *      1) 多个词任意命中都算分（"决策 偏见" 不再要求连着的整串）
 *      2) 按相关度排序，而不是原顺序
 *      3) 词出现越多、在越短的文档里越稀有 → 分越高（BM25 的 idf）
 *    它不是语义理解：搜"人物动机"不会命中"他为什么这么做"。
 *    要那一层，必须换成真 embedding，属于另一个量级的改动。
 * ========================================================== */
(function (global) {

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fa5]/;
  const K1 = 1.5;   // BM25 词频饱和参数
  const B  = 0.75;  // BM25 长度归一参数

  /**
   * 分词：中文切二元组（bigram），英文/数字按整词。
   * "深度学习" → ["深度","度学","学习"]；"deep learning" → ["deep","learning"]
   * 单字查询保留单字，保证搜「鼻」也能命中「鼻子」。
   */
  function tokenize(text) {
    const s = String(text == null ? "" : text).toLowerCase();
    const toks = [];
    const words = s.match(/[a-z0-9][a-z0-9_+.#-]*/g);
    if (words) words.forEach((w) => { if (w.length > 1 || /[0-9]/.test(w)) toks.push(w); });

    const chunks = s.match(/[\u3400-\u4dbf\u4e00-\u9fa5]+/g);
    if (chunks) {
      chunks.forEach((ch) => {
        if (ch.length === 1) { toks.push(ch); return; }
        for (let i = 0; i < ch.length - 1; i++) toks.push(ch.slice(i, i + 2));
      });
    }
    // 单个汉字混在英文里的情况（如 "AI书"），补一轮单字，成本极低
    if (!toks.length) {
      for (const ch of s) if (CJK.test(ch)) toks.push(ch);
    }
    return toks;
  }

  /** 建索引：docs = [{ id, text }] */
  function buildIndex(docs) {
    const n = docs.length;
    const df = new Map();
    const postings = new Array(n);
    const lens = new Array(n);
    const ids = new Array(n);

    for (let i = 0; i < n; i++) {
      const d = docs[i];
      ids[i] = d.id;
      const toks = tokenize(d.text);
      const tf = new Map();
      for (let t = 0; t < toks.length; t++) {
        const k = toks[t];
        tf.set(k, (tf.get(k) || 0) + 1);
      }
      tf.forEach((_, k) => df.set(k, (df.get(k) || 0) + 1));
      postings[i] = tf;
      lens[i] = toks.length;
    }

    let sum = 0;
    for (let i = 0; i < n; i++) sum += lens[i];
    const avgdl = n ? sum / n || 1 : 1;

    const idf = new Map();
    df.forEach((cnt, k) => {
      // 带 +0.5 平滑的 idf，等价于 ln(1 + (N - df + 0.5)/(df + 0.5))
      idf.set(k, Math.log(1 + (n - cnt + 0.5) / (cnt + 0.5)));
    });

    return { n, postings, lens, avgdl, idf, ids };
  }

  /** 检索：返回 [{ id, score }]，按分数降序 */
  function search(index, q, limit) {
    if (!index || !index.n) return [];
    const qt = tokenize(q);
    if (!qt.length) return [];

    const qtf = new Map();
    qt.forEach((t) => qtf.set(t, (qtf.get(t) || 0) + 1));

    const scores = new Float64Array(index.n);
    qtf.forEach((qn, t) => {
      const idf = index.idf.get(t);
      if (idf === undefined) return;          // 索引里没这个词，跳过
      const qBoost = 1 + Math.log(qn);        // 查询词重复出现时略加权
      for (let i = 0; i < index.n; i++) {
        const tf = index.postings[i].get(t);
        if (!tf) continue;
        const dl = index.lens[i] || 1;
        const norm = (tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * dl) / index.avgdl));
        scores[i] += idf * norm * qBoost;
      }
    });

    const out = [];
    for (let i = 0; i < index.n; i++) {
      if (scores[i] > 0) out.push({ id: index.ids[i], score: scores[i] });
    }
    out.sort((a, b) => b.score - a.score);
    return typeof limit === "number" ? out.slice(0, limit) : out;
  }

  /* ---------------------------------------------------------
   *  缓存：同一批数据不要每次输入都重建索引
   *  指纹用「条数 + 总字符数」，数据一变（同步了新笔记）就自动失效。
   * --------------------------------------------------------- */
  const cache = new Map();

  function cachedIndex(key, docs) {
    let chars = 0;
    for (let i = 0; i < docs.length; i++) chars += String(docs[i].text || "").length;
    const fp = docs.length + ":" + chars;
    const hit = cache.get(key);
    if (hit && hit.fp === fp) return hit.index;
    const index = buildIndex(docs);
    cache.set(key, { fp, index });
    return index;
  }

  function clearCache() { cache.clear(); }

  /** 书籍检索：命中按相关度排序；一个都没命中时回退到子串匹配，保持旧行为 */
  function rankBooks(books, kw) {
    const k = String(kw || "").trim();
    if (!k) return books;
    const docs = books.map((b) => ({
      id: b.bookId,
      text: [b.title, b.author, b.category, b.publisher].filter(Boolean).join(" ")
    }));
    const hits = search(cachedIndex("books", docs), k);
    if (hits.length) {
      const at = new Map();
      hits.forEach((h) => at.set(h.id, h.score));
      return books
        .filter((b) => at.has(b.bookId))
        .sort((a, b) => at.get(b.bookId) - at.get(a.bookId));
    }
    const low = k.toLowerCase();
    return books.filter((b) =>
      [b.title, b.author, b.category].some((f) => String(f || "").toLowerCase().includes(low))
    );
  }

  /**
   * 笔记检索：groups = [{ book, notes }]
   * 返回新的 groups（只保留命中的笔记，组内按相关度排序，组间按命中数排序）。
   */
  function rankNoteGroups(groups, kw) {
    const k = String(kw || "").trim();
    if (!k) {
      return groups
        .filter((g) => (g.notes || []).length)
        .sort((a, b) => b.notes.length - a.notes.length);
    }

    const docs = [];
    const where = [];   // 与 docs 一一对应：[groupId, noteIndex]
    groups.forEach((g, gi) => {
      (g.notes || []).forEach((n, ni) => {
        docs.push({
          id: docs.length,
          text: [n.text, n.comment, n.chapter, g.book.title, g.book.author]
            .filter(Boolean).join(" ")
        });
        where.push([gi, ni]);
      });
    });

    let hits = search(cachedIndex("notes", docs), k);
    if (!hits.length) {
      // 回退：完全按原来的子串匹配，避免检索的意外空结果
      const low = k.toLowerCase();
      const keep = [];
      groups.forEach((g, gi) => {
        (g.notes || []).forEach((n, ni) => {
          const hit = [n.text, n.comment, n.chapter, g.book.title, g.book.author]
            .some((f) => String(f || "").toLowerCase().includes(low));
          if (hit) keep.push({ gi, ni, score: 1 });
        });
      });
      // 兜底分支直接按原顺序还原，不参与打分
      const byGroup = new Map();
      keep.forEach(({ gi, ni }) => {
        if (!byGroup.has(gi)) byGroup.set(gi, []);
        byGroup.get(gi).push({ note: groups[gi].notes[ni], ni });
      });
      return Array.from(byGroup.entries())
        .sort((a, b) => b[1].length - a[1].length)
        .map(([gi, arr]) => ({
          book: groups[gi].book,
          notes: arr.sort((x, y) => x.ni - y.ni).map((x) => x.note)
        }));
    }

    const byGroup = new Map();
    hits.forEach((h) => {
      const [gi, ni] = where[h.id];
      if (!byGroup.has(gi)) byGroup.set(gi, []);
      byGroup.get(gi).push({ note: groups[gi].notes[ni], score: h.score, ni });
    });

    return Array.from(byGroup.entries())
      .sort((a, b) => b[1].length - a[1].length)
      .map(([gi, arr]) => ({
        book: groups[gi].book,
        notes: arr.sort((x, y) => y.score - x.score).map((x) => x.note)
      }));
  }

  global.LOCAL_SEARCH = {
    tokenize, buildIndex, search, rankBooks, rankNoteGroups, clearCache
  };
})(window);

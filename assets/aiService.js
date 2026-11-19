/* ==========================================================
 *  aiService.js — 按书隔离的 RAG + DeepSeek 问答（可选能力）
 *
 *  设计要点（对应《优化建议文档》里的四条链路）：
 *    链路 1 笔记导入 → 已有（粘贴 / 新增摘录 / 微信读书同步）
 *    链路 2 本书问答 → 本文件：先在这本书的笔记里检索片段，再拼进 Prompt
 *    链路 3 AI 批量产出 → 本文件：总结 / 思维导图
 *    链路 4 跨书检索  → 「我的笔记」页的全局搜索（BM25，离线）
 *
 *  关键产品决策：**知识库按书隔离**。
 *    提问《置身事内》时只检索这本书的笔记，不会把别的书混进来 ——
 *    这样答案更准、也更不容易被模型编造。
 *
 *  检索用的是 search.js 的 BM25，不是向量模型：
 *    不下载权重、不联网、断网也能取上下文。代价是关键词级别，不是语义级别。
 *
 *  Key 的安全边界：
 *    只存在本机 localStorage，每次请求发给本机 server.js 转发；
 *    **不写进备份文件、不进 dist、公网展示版直接隐藏 AI 入口**。
 * ========================================================== */
(function (global) {

  const LS_KEY = "weread.aiKey.v1";
  const ENDPOINT = "/api/ai/chat";
  const PING = "/api/ai/__ping";
  const DEFAULT_MODEL = "deepseek-chat";

  /* ---------------- Key ---------------- */
  function getKey() { try { return global.localStorage.getItem(LS_KEY) || ""; } catch (e) { return ""; } }
  function setKey(k) { try { k ? global.localStorage.setItem(LS_KEY, k) : global.localStorage.removeItem(LS_KEY); } catch (e) {} }
  function hasKey() { return !!getKey(); }
  function clearKey() { setKey(""); }

  /** 探测：AI 代理在不在 / 服务端有没有预置 Key */
  async function ping() {
    try {
      const r = await fetch(PING, { cache: "no-store" });
      if (!r.ok) return { ok: false, reason: "proxy" };
      const j = await r.json();
      return { ok: true, hasServerKey: !!j.hasServerKey, hasLocalKey: hasKey() };
    } catch (e) {
      return { ok: false, reason: "offline" };
    }
  }

  /* ---------------- 底层调用 ---------------- */
  /**
   * messages: [{role, content}]
   * 返回 { ok, content, error, code }
   */
  async function chat(messages, opts = {}) {
    const key = getKey();
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          messages,
          model: opts.model || DEFAULT_MODEL,
          temperature: opts.temperature == null ? 0.3 : opts.temperature
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const map = {
          NO_KEY: "还没有配置 DeepSeek API Key",
          NO_MESSAGES: "请求内容为空",
          BAD_JSON: "请求格式错误",
          UPSTREAM: (j.message || "模型返回错误"),
          BAD_UPSTREAM: "模型返回了无法解析的内容",
          PROXY_ERROR: "连不上本机服务（server.js 没起？）"
        };
        return { ok: false, code: j.error || "HTTP_" + r.status, error: map[j.error] || ("请求失败：" + r.status) };
      }
      return { ok: true, content: j.content || "", usage: j.usage || null };
    } catch (e) {
      return { ok: false, code: "NETWORK", error: "连不上本机服务 —— AI 要走 server.js 转发，请先启动工作台" };
    }
  }

  /* ---------------- 本书知识库：检索 ---------------- */
  const strip = (s) => String(s || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

  function noteText(n) {
    return [strip(n.text), n.comment ? "想法：" + strip(n.comment) : "", n.chapter ? "章节：" + n.chapter : ""]
      .filter(Boolean).join(" | ");
  }

  /**
   * 在这本书的笔记里检索，返回最相关的若干条（本书专属知识库）。
   * 没有检索词（生成总结 / 导图）时按顺序取前面若干条。
   */
  function retrieve(book, question, k = 8) {
    const notes = (book && book.notes) || [];
    if (!notes.length) return [];
    const q = String(question || "").trim();
    if (!q) return notes.slice(0, Math.min(k + 4, notes.length));

    if (global.LOCAL_SEARCH) {
      const docs = notes.map((n, i) => ({ id: i, text: noteText(n) }));
      const idx = global.LOCAL_SEARCH.buildIndex(docs);
      const hits = global.LOCAL_SEARCH.search(idx, q, k);
      if (hits.length) return hits.map((h) => notes[h.id]);
    }
    // 兜底：子串匹配
    const low = q.toLowerCase();
    return notes.filter((n) => noteText(n).toLowerCase().includes(low)).slice(0, k);
  }

  /** 把检索结果拼成可放进 Prompt 的上下文（带编号，方便模型引用） */
  function buildContext(book, question, k = 8) {
    const hits = retrieve(book, question, k);
    if (!hits.length) return { text: "", hits: [] };
    const lines = hits.map((n, i) => {
      const seg = [];
      if (n.chapter) seg.push("章节：" + n.chapter);
      if (strip(n.text)) seg.push("摘抄：" + strip(n.text));
      if (n.comment) seg.push("我的想法：" + strip(n.comment));
      return `[${i + 1}] ${seg.join(" / ")}`;
    });
    return { text: lines.join("\n"), hits };
  }

  const SYS = "你是读者的私人阅读助理。只根据「本书笔记」里提供的内容回答问题；" +
    "引用时用 [1] [2] 这样的编号标注来源；笔记里没有的内容就说「笔记里没有提到」，不要编造。" +
    "回答用中文，简洁、具体，不讲空话。";

  /* ---------------- 能力 1：本书问答 ---------------- */
  async function ask(book, question) {
    const q = String(question || "").trim();
    if (!q) return { ok: false, error: "先写个问题" };
    const ctx = buildContext(book, q, 8);
    if (!ctx.text) return { ok: false, error: "这本书还没有笔记，先同步或手写几条再来问" };

    const messages = [
      { role: "system", content: SYS },
      { role: "user", content: `书名：《${book.title}》 作者：${book.author || "未知"}\n\n本书笔记：\n${ctx.text}\n\n问题：${q}` }
    ];
    const r = await chat(messages);
    if (r.ok) r.used = ctx.hits.length;
    return r;
  }

  /* ---------------- 能力 2：AI 总结 ---------------- */
  async function summarize(book) {
    const ctx = buildContext(book, "", 20);
    if (!ctx.text) return { ok: false, error: "这本书还没有笔记，先同步或手写几条再来生成" };
    const messages = [
      { role: "system", content: SYS },
      {
        role: "user",
        content: `书名：《${book.title}》 作者：${book.author || "未知"}\n\n本书笔记：\n${ctx.text}\n\n` +
          "请基于上面的笔记，用 Markdown 输出四段：\n" +
          "## 这本书在讲什么（3 句话以内）\n## 核心观点（3-5 条，每条一句话）\n" +
          "## 可以马上用起来的（2-3 条，写成动作）\n## 我当时最在意的（引用 2-3 个片段编号）"
      }
    ];
    const r = await chat(messages, { temperature: 0.4 });
    if (r.ok) r.used = ctx.hits.length;
    return r;
  }

  /* ---------------- 能力 3：思维导图 ---------------- */
  async function mindmap(book) {
    const ctx = buildContext(book, "", 24);
    if (!ctx.text) return { ok: false, error: "这本书还没有笔记，先同步或手写几条再来生成" };
    const messages = [
      { role: "system", content: SYS },
      {
        role: "user",
        content: `书名：《${book.title}》 作者：${book.author || "未知"}\n\n本书笔记：\n${ctx.text}\n\n` +
          "请把这些笔记整理成一张思维导图，用 Mermaid 语法输出，格式严格如下（不要加解释、不要加 ``` 围栏）：\n" +
          "graph TD\nA[书名或主题] --> B[分支一]\nA --> C[分支二]\nB --> D[要点]\n" +
          "要求：3-6 个主分支，每个分支 2-4 个要点，节点文字不超过 12 个字。"
      }
    ];
    const r = await chat(messages, { temperature: 0.4 });
    if (r.ok) r.used = ctx.hits.length;
    return r;
  }

  /* ---------------- Mermaid → 简易树（不引第三方库，离线可渲染） ---------------- */
  /**
   * 把 `A[文本] --> B[文本]` 解析成嵌套列表的 HTML。
   * 解析不出来就返回 null，调用方退化为原样展示源码。
   */
  function mermaidToTreeHTML(src) {
    if (!src) return null;
    const text = String(src).replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

    const label = new Map();
    const kids = new Map();
    const hasParent = new Set();
    let edges = 0;

    const nodeOf = (raw) => {
      const m = String(raw).trim().match(/^([A-Za-z0-9_]+)\s*[\[\(\{](.+?)[\]\)\}]\s*$/);
      if (m) { label.set(m[1], m[2].trim()); return m[1]; }
      const id = String(raw).trim();
      if (/^[A-Za-z0-9_]+$/.test(id)) { if (!label.has(id)) label.set(id, id); return id; }
      const synthetic = "N" + label.size;
      label.set(synthetic, id.replace(/^["']|["']$/g, ""));
      return synthetic;
    };

    lines.forEach((ln) => {
      if (/^graph|^flowchart|^mindmap/i.test(ln)) return;
      if (!ln.includes("-->")) return;
      const parts = ln.split("-->").map((s) => s.trim());
      if (parts.length < 2) return;
      let left = nodeOf(parts[0]);
      for (let i = 1; i < parts.length; i++) {
        // 形如 A -->|标签| B 的情况，去掉管道标签
        const seg = parts[i].replace(/^\|[^|]*\|\s*/, "").trim();
        const right = nodeOf(seg);
        if (!kids.has(left)) kids.set(left, []);
        kids.get(left).push(right);
        hasParent.add(right);
        edges++;
        left = right;
      }
    });

    if (!edges) return null;

    const roots = Array.from(label.keys()).filter((id) => !hasParent.has(id));
    const seen = new Set();
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    const walk = (id, depth) => {
      if (depth > 6 || seen.has(id)) return "";
      seen.add(id);
      const children = kids.get(id) || [];
      if (!children.length) return `<li>${esc(label.get(id) || id)}</li>`;
      return `<li>${esc(label.get(id) || id)}<ul>${children.map((c) => walk(c, depth + 1)).join("")}</ul></li>`;
    };

    const body = (roots.length ? roots : Array.from(label.keys()).slice(0, 1))
      .map((r) => walk(r, 0)).join("");
    return body ? `<ul class="mind-tree">${body}</ul>` : null;
  }

  /* ---------------- 极简 Markdown 渲染（只支持标题/列表/粗体/引用） ---------------- */
  function mdToHTML(md) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const inline = (s) => esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[(\d+)\]/g, '<i class="cite">[$1]</i>');

    let out = "";
    let inList = false;
    const closeList = () => { if (inList) { out += "</ul>"; inList = false; } };

    String(md || "").split("\n").forEach((line) => {
      const t = line.trim();
      if (/^([-*]|\d+\.)\s+/.test(t)) {
        if (!inList) { out += "<ul>"; inList = true; }
        out += `<li>${inline(t.replace(/^([-*]|\d+\.)\s+/, ""))}</li>`;
        return;
      }
      closeList();
      if (/^###\s+/.test(t)) return void (out += `<h6>${inline(t.replace(/^###\s+/, ""))}</h6>`);
      if (/^##\s+/.test(t)) return void (out += `<h5>${inline(t.replace(/^##\s+/, ""))}</h5>`);
      if (/^#\s+/.test(t)) return void (out += `<h4>${inline(t.replace(/^#\s+/, ""))}</h4>`);
      if (!t) return;
      out += `<p>${inline(t)}</p>`;
    });
    closeList();
    return out;
  }

  global.AI = {
    getKey, setKey, hasKey, clearKey, ping, chat,
    retrieve, buildContext, ask, summarize, mindmap,
    mermaidToTreeHTML, mdToHTML,
    LS_KEY
  };
})(window);

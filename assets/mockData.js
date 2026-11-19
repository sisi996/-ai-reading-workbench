/* ==========================================================
 * 模拟「微信读书」开放接口
 * 真实场景下应由后端代理并签名 reqId 访问 weread.qq.com，
 * 这里我们用本地数据复现其 JSON 结构，便于前端独立运行。
 * ========================================================== */

// 用真实的电子书架封面图，覆盖虚构实现
// 统一使用 douban 的图片代理（公开允许读书笔记类引用）
const COVER = (id) => `https://img2.doubanio.com/view/subject/l/public/${id}.jpg`;
// 兜底占位封面（当 douban 没有对应封面时使用 Unsplash 即时图）
const FALLBACK_COVER = (seed, color = "5b8def") =>
  `https://placehold.co/320x420/${color}/ffffff?text=${encodeURIComponent(seed)}&font=source-han-serif`;

/* ---------- 1. 书籍列表 ---------- */
const RAW_BOOKS = [
  // === 在读 ===
  {
    bookId: "book-001",
    title: "活着",
    author: "余华",
    publisher: "作家出版社",
    cover: COVER("29164028"),
    status: "reading",
    progress: 62,
    rating: 9.2,
    ratingCount: 18420,
    category: "当代文学",
    intro: "《活着》讲述了在大时代背景下，主人公福贵承受着种种苦难，亲眼看着身边亲人一个个离去的故事。",
    reviews: [
      { user: "山月", content: "读了三遍，每次都哭。余华的文字克制而有力量。", star: 5 },
      { user: "南有乔木", content: "活着本身就是意义。", star: 5 },
      { user: "江湖夜雨", content: "推荐给每一个想认真生活的人。", star: 4 }
    ],
    notes: [
      {
        id: "n-1",
        type: "highlight",
        text: "人是为活着本身而活着的，而不是为了活着之外的任何事物所活着。",
        chapter: "第 2 章 · 在田埂上",
        createdAt: "2026-09-21 21:14"
      },
      {
        id: "n-2",
        type: "underline",
        text: "少年去游荡，中年想掘藏，老年做和尚。",
        chapter: "第 1 章 · 富贵的开端",
        createdAt: "2026-09-20 19:02"
      },
      {
        id: "n-3",
        type: "thought",
        text: "看到有庆献血那段，心里一紧。余华写苦难从来不给解释，只描述事实。",
        createdAt: "2026-09-22 23:40"
      }
    ]
  },
  {
    bookId: "book-002",
    title: "置身事内：中国政府与经济发展",
    author: "兰小欢",
    publisher: "上海人民出版社",
    cover: COVER("35465336"),
    status: "reading",
    progress: 35,
    rating: 9.4,
    ratingCount: 9821,
    category: "经济 / 政经",
    intro: "本书将经济学原理与我国经济发展的实践有机融合，解析政府在中国经济中的角色。",
    reviews: [
      { user: "政策小课堂", content: "地方政府章节讲得太透了。", star: 5 },
      { user: "夜半钟声", content: "不是经济学教材，更像是一份入门地图。", star: 4 },
      { user: "doudou", content: "读完再看新闻，豁然开朗。", star: 5 }
    ],
    notes: [
      {
        id: "n-4",
        type: "highlight",
        text: "在市场经济体制下，政府实际上是经济参与者，其角色更像一位既要当裁判又要下场踢球的特殊队员。",
        chapter: "第一章 地方政府的权力与事务",
        createdAt: "2026-10-04 22:10"
      },
      {
        id: "n-5",
        type: "thought",
        text: "结合最近土地财政相关报道看，很多现实问题都能套到这本书的逻辑里。",
        createdAt: "2026-10-05 08:15"
      }
    ]
  },
  {
    bookId: "book-003",
    title: "人类简史：从动物到上帝",
    author: "[以色列] 尤瓦尔·赫拉利",
    publisher: "中信出版社",
    cover: COVER("259haa55"),
    status: "reading",
    progress: 78,
    rating: 8.7,
    ratingCount: 24110,
    category: "历史 / 科普",
    intro: "讲述智人如何从一种不起眼的动物崛起为地球的主宰，讨论虚构故事与合作的奥秘。",
    reviews: [
      { user: "万古", content: "视野极其宏大，会改变你看世界的方式。", star: 5 },
      { user: "西西里的小猫", content: "翻译有点跳，但是内容五颗星。", star: 4 }
    ],
    notes: [
      {
        id: "n-6",
        type: "highlight",
        text: "人类能够合作，是因为我们能共同相信一个虚构的故事。",
        chapter: "第二章 知人善任",
        createdAt: "2026-08-12 16:24"
      }
    ]
  },
  {
    bookId: "book-004",
    title: "深度工作：如何有效使用每一点脑力",
    author: "[美] 卡尔·纽波特",
    publisher: "后浪 / 江西人民出版社",
    cover: COVER("27037945"),
    status: "reading",
    progress: 45,
    rating: 8.0,
    ratingCount: 7320,
    category: "自我管理",
    intro: "在网络冲浪时代，专注力成了稀缺品。本书提供了切实可行的深度工作方法论。",
    reviews: [
      { user: "小满", content: "执行最重要。", star: 5 },
      { user: "夜航船", content: "要把它当工具书用，而不是鸡汤。", star: 4 }
    ],
    notes: [
      {
        id: "n-7",
        type: "underline",
        text: "深度工作：在无干扰的状态下进行专业活动，使个人的认知能力达到极限。",
        chapter: "引言",
        createdAt: "2026-09-29 11:08"
      }
    ]
  },

  // === 已读 ===
  {
    bookId: "book-005",
    title: "百年孤独",
    author: "[哥伦比亚] 加西亚·马尔克斯",
    publisher: "南海出版公司",
    cover: COVER("1060572"),
    status: "finished",
    progress: 100,
    rating: 9.3,
    ratingCount: 35420,
    category: "拉美文学",
    intro: "布恩迪亚家族七代人的传奇故事，加勒比海沿岸小镇马孔多的百年兴衰。",
    reviews: [
      { user: "云图", content: "需要第二遍才能开始读懂。", star: 5 },
      { user: "北极星", content: "魔幻现实主义的巅峰。", star: 5 }
    ],
    notes: []
  },
  {
    bookId: "book-006",
    title: "思考，快与慢",
    author: "[美] 丹尼尔·卡尼曼",
    publisher: "中信出版社",
    cover: COVER("2086713"),
    status: "finished",
    progress: 100,
    rating: 8.6,
    ratingCount: 12012,
    category: "心理学",
    intro: "诺贝尔经济学奖得主卡尼曼介绍人类两大思维系统：快速直觉与慢速理性。",
    reviews: [
      { user: "理性人", content: "难啃但是值得反复读。", star: 4 }
    ],
    notes: []
  },

  // === 未读 ===
  {
    bookId: "book-007",
    title: "枪炮、病菌与钢铁：人类社会的命运",
    author: "[美] 贾雷德·戴蒙德",
    publisher: "上海译文出版社",
    cover: COVER("2306652"),
    status: "unread",
    progress: 0,
    rating: 8.7,
    ratingCount: 9921,
    category: "历史 / 地理",
    intro: "为什么是欧亚大陆文明征服了美洲、非洲，而不是相反？戴蒙德给出了环境决定论的解释。",
    reviews: [
      { user: "写不出论文", content: "引用率惊人，是社科必读。", star: 5 },
      { user: "小小", content: "读起来稍微累，但视角令人震撼。", star: 4 },
      { user: "清晨的雨", content: "看完全书感觉世界观都被拓宽了。", star: 5 },
      { user: "周先森", content: "窗口期太长，断断续续读了一整年。", star: 4 }
    ],
    notes: []
  },
  {
    bookId: "book-008",
    title: "长安的荔枝",
    author: "马伯庸",
    publisher: "湖南文艺出版社",
    cover: COVER("35615657"),
    status: "unread",
    progress: 0,
    rating: 8.5,
    ratingCount: 15621,
    category: "历史小说",
    intro: "大唐天宝十四年，长安城小吏李善德接下运送鲜荔枝到长安的不可能任务……",
    reviews: [
      { user: "荔枝少女", content: "一口气读完，节奏很好。", star: 5 },
      { user: "马亲王", content: "以小见大的典范。", star: 5 },
      { user: "Song", content: "推荐先看《长安的荔枝》再看《太白金星有点烦》。", star: 5 }
    ],
    notes: []
  },
  {
    bookId: "book-009",
    title: "置身事外",
    author: "李筠",
    publisher: "中信出版社",
    cover: FALLBACK_COVER("置身事外", "9c27b0"),
    status: "unread",
    progress: 0,
    rating: 7.9,
    ratingCount: 2131,
    category: "随笔",
    intro: "一部冷静的随笔合集，关于自由、孤独与时代之间的关系。",
    reviews: [
      { user: "慢读日记", content: "李筠的文字克制。", star: 4 }
    ],
    notes: []
  },
  {
    bookId: "book-010",
    title: "当我谈跑步时我谈些什么",
    author: "[日] 村上春树",
    publisher: "南海出版公司",
    cover: COVER("26288121"),
    status: "unread",
    progress: 0,
    rating: 8.1,
    ratingCount: 19320,
    category: "随笔 / 运动",
    intro: "村上春树关于跑步、日常与心灵的小说式自传。",
    reviews: [
      { user: "夜跑者", content: "跑步爱好者必读。", star: 5 },
      { user: "城内", content: "节奏慢，但是很舒服。", star: 4 }
    ],
    notes: []
  },
  {
    bookId: "book-011",
    title: "被讨厌的勇气",
    author: "[日] 岸见一郎 / 古贺史健",
    publisher: "机械工业出版社",
    cover: COVER("26809288"),
    status: "unread",
    progress: 0,
    rating: 8.5,
    ratingCount: 38422,
    category: "心理自助",
    intro: "阿德勒心理学入门书，以哲人与青年对话的形式展开。",
    reviews: [
      { user: "阿小白", content: "颠覆认知的一本书。", star: 5 },
      { user: "阿紫", content: "很多观点需要反复读。", star: 5 }
    ],
    notes: []
  },
  {
    bookId: "book-012",
    title: "设计中的设计",
    author: "[日] 原研哉",
    publisher: "山东人民出版社",
    cover: COVER("3328390"),
    status: "unread",
    progress: 0,
    rating: 8.0,
    ratingCount: 8421,
    category: "设计",
    intro: "原研哉关于设计本质、设计哲学的思考合集。",
    reviews: [
      { user: "设计课代表", content: "入门设计思维必读。", star: 4 }
    ],
    notes: []
  }
];

/* ---------- 2. 兜底覆盖被 douban 屏蔽或找不到的封面 ---------- */
RAW_BOOKS.forEach((b) => {
  // 用一个稳定的随机种子保证页面之间颜色一致
  if (!b.cover || b.cover.includes("undefined")) {
    b.cover = FALLBACK_COVER(b.title, "5b8def");
  }
});

/* ---------- 3.1 宝藏默认分类（可自定义增删改）---------- */
const DEFAULT_CATEGORIES = [
  { id: "cat-quote", name: "金句摘抄" },
  { id: "cat-method", name: "读书方法" },
  { id: "cat-think", name: "思考碎片" }
];

/* ---------- 3. 默认宝藏卡片（文字与图片并存）---------- */
const DEFAULT_TREASURES = [
  {
    id: "t-1",
    type: "mixed",
    title: "来自《活着》",
    content: "人是为活着本身而活着的，<mark class=\"hl-yellow\">而不是为了活着之外的任何事物所活着</mark>。",
    image: "",
    color: "#fff7d6",
    category: "cat-quote",
    createdAt: "2026-09-21"
  },
  {
    id: "t-2",
    type: "mixed",
    title: "行动守则",
    content: "把「以后再说」换成「<u class=\"ul-wavy\">现在就开始</u>」。先做 5 分钟，再决定要不要继续。",
    image: "",
    color: "#dff5e1",
    category: "cat-method",
    createdAt: "2026-09-30"
  },
  {
    id: "t-3",
    type: "mixed",
    title: "置身事内 · 摘抄",
    content: "在市场经济体制下，政府实际上是经济参与者，其角色更像一位<mark class=\"hl-green\">既要当裁判又要下场踢球</mark>的特殊队员。",
    image: "",
    color: "#e3f2ff",
    category: "cat-quote",
    createdAt: "2026-10-04"
  }
];

/* ---------- 4. 首次阅读时间种子（演示数据）---------- */
const FIRST_READ_SEED = {
  "book-001": "2026-08-18 21:40",
  "book-002": "2026-09-27 22:15",
  "book-003": "2026-08-05 16:24",
  "book-004": "2026-09-20 09:08",
  "book-005": "2026-05-12 21:10",
  "book-006": "2026-06-30 22:00"
};

// 把种子写入书籍对象
RAW_BOOKS.forEach((b) => {
  if (FIRST_READ_SEED[b.bookId]) b.firstReadTime = FIRST_READ_SEED[b.bookId];
});

window.WEREAD_MOCK = {
  RAW_BOOKS,
  DEFAULT_TREASURES,
  DEFAULT_CATEGORIES,
  FIRST_READ_SEED
};

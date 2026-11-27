/* 云文档首页 · 飞书云文档风格首页插件（本地开发版）
 * 仅依赖思源宿主 API，无构建链。数据全部来自思源内核，不在外部发送任何信息。
 * 布局参照飞书云文档：横幅 + 搜索 + 新建 / 快捷访问 / 我的知识库卡片墙 / 最近。
 */
"use strict";
const { Plugin, Menu, openTab, Dialog, getFrontend, showMessage } = require("siyuan");
const CLOSED_TABS_KEY = "local-closed-tabs";
const SIYUAN_NODE_ID = /^\d{14}-[a-z0-9]{7}$/;
const closedTabSnapshot = tabs => JSON.stringify(tabs, (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    : value
);


// Restrained, theme-aware line icons. No external resources or injected document data.
function uiIcon(kind) {
  const paths = {
    book: '<path d="M4 3h12a1 1 0 0 1 1 1v14H5a2 2 0 0 1-2-2V5a2 2 0 0 1 1-2Z"/><path d="M3 15h14M7 3v12"/>',
    folder: '<path d="M2 6a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"/>',
    file: '<path d="M5 2h6l5 5v11H5Z"/><path d="M11 2v5h5M8 11h5M8 14h5"/>',
    spreadsheet: '<rect x="3" y="4" width="14" height="12" rx="2"/><path d="M3 8h14M3 12h14M9 8v8"/>',
    mindmap: '<rect x="2" y="8" width="5" height="4" rx="1"/><rect x="13" y="3" width="5" height="4" rx="1"/><rect x="13" y="13" width="5" height="4" rx="1"/><path d="M7 10h3V5h3m-3 5v5h3"/>',
    whiteboard: '<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M6 7h5v5H6zM13 12h2m-1-1v2"/>',
    text: '<path d="M5 2h6l5 5v11H5Z"/><path d="M11 2v5h5m-7 3-2 2 2 2m3-4 2 2-2 2"/>',
    pdf: '<path d="M5 2h6l5 5v11H5Z"/><path d="M11 2v5h5M7 14l2-4 2 4m1 0v-4h2"/>',
    home: '<path d="m2 9 8-7 8 7M4 8v10h12V8M8 18v-6h4v6"/>',
    search: '<circle cx="8" cy="8" r="5"/><path d="m12 12 5 5"/>',
    chevron: '<path d="m7 5 5 5-5 5"/>',
    pin: '<path d="m7 2 8 4-3 3v4l-3-1-4 5 1-7-3-2 4-2Z"/>'
  };
  return `<svg class="cdh-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind] || paths.file}</svg>`;
}

/* ---------- 基础工具 ---------- */
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sqlSafe = v => String(v ?? "").replace(/'/g, "''").replace(/[\\%_]/g, c => "\\" + c);

/* 笔记本名常自带 emoji（如「📚 知识库」），拆成封面图标 + 纯文字标题 */
const EMOJI_LEAD = /^([\p{Extended_Pictographic}\u{FE0F}\u{200D}]+)\s*/u;
function splitNotebookName(name) {
  const raw = String(name ?? "").trim();
  const m = raw.match(EMOJI_LEAD);
  if (m) return { emoji: m[1], text: raw.slice(m[0].length).trim() || "未命名笔记本" };
  return { emoji: "", text: raw || "未命名笔记本" };
}

const GRADIENTS = [
  "linear-gradient(135deg,#3370ff,#7aa7ff)",
  "linear-gradient(135deg,#00c2a8,#5ce8c7)",
  "linear-gradient(135deg,#ff7d00,#ffab5e)",
  "linear-gradient(135deg,#e02020,#ff6b6b)",
  "linear-gradient(135deg,#9a5cf5,#c9a2ff)",
  "linear-gradient(135deg,#00b2ff,#7ad9ff)",
  "linear-gradient(135deg,#ffb300,#ffd76e)",
  "linear-gradient(135deg,#2e7d32,#66bb6a)"
];
const EMOJIS = ["📘", "📗", "📙", "📕", "📓", "📋", "🗺️", "🧭", "💡", "🛠️"];
function hashOf(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
const gradOf = id => GRADIENTS[hashOf(id) % GRADIENTS.length];
/* 只接管这三个已被云文档导航完全替代的原生面板：文档树、大纲、反链。
   其余原生面板（书签、标签、收集箱、关系图、未读）和第三方插件面板一律照常可用——
   用户的插件、书签、标签不该因为换界面就没了。 */
const TAKEN_OVER_DOCKS = new Set(["file", "outline", "backlink"]);

const emojiOf = id => EMOJIS[hashOf(id) % EMOJIS.length];

/**
 * 思源给每个笔记本自动建一篇「根文档」，它的 id 恒等于笔记本 id、标题就是库名。
 * 在侧栏里它和库条目长得一模一样，属于纯重复，树里不再显示。
 */
const isRootDoc = r => !!r && r.id === r.box;

/**
 * 同步冲突副本：标题形如「xxx (Conflicted 2026-09-03 10:21:03)」，还可能层层叠加多次。
 * 这类文档是思源自动生成的，标题长到会撑爆侧栏，默认收进「同步冲突」入口里。
 */
const isConflictDoc = r => /\(Conflicted \d{4}-\d{2}-\d{2}/.test(String(r?.content ?? ""));
const isVisibleDoc = r => !!r && !isRootDoc(r) && !isConflictDoc(r);

/**
 * 文件夹标记：思源本身没有"文件夹"这种对象，文档树就是文档套文档。
 * 这里把「用来装子文档的空壳文档」用自定义属性标出来（custom-cdh-folder="true"），
 * 属性写在文档的 ial 里，会跟着思源同步走，换设备也在。
 */
const isFolderRow = r => /custom-cdh-folder\s*=\s*"?true"?/.test(String(r?.ial ?? ""));
const suiteFileLabels = new Map([
  ["spreadsheet", "电子表格"], ["mindmap", "脑图"], ["xmind", "XMind 脑图"], ["whiteboard", "白板"],
  ["text", "文本文件"], ["pdf", "PDF 文件"]
]);
const suiteFileKind = row => String(row?.ial ?? "").match(/(?:^|\s|\{)custom-cloud-document-kind\s*=\s*"([a-z-]+)"/)?.[1];

/** 把「xxx (Conflicted 2026-09-03 10:21:03) (Conflicted …)」压成「xxx ×3」，
 *  只冲突过一次的补上发生时间，否则同名的几条在侧栏里分不出来 */
function conflictLabel(name) {
  const s = String(name ?? "");
  const marks = [...s.matchAll(/\(Conflicted (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2}\)/g)];
  const base = s.replace(/\s*\(Conflicted [^)]*\)/g, "").trim() || "未命名文档";
  if (!marks.length) return base;
  if (marks.length > 1) return `${base} ×${marks.length}`;
  return `${base} · ${marks[0][1].slice(5)} ${marks[0][2]}`;
}

/** 思源自动生成的名字很长（xxx (Duplicated 2026-10-30 14:53:56)），侧栏里压短显示 */
function prettyDocName(name) {
  const raw = String(name ?? "");
  const m = raw.match(/^(.*?) \((Duplicated|Conflicted) \d{4}-\d{2}-\d{2} (\d{2}:\d{2}):\d{2}\)$/);
  if (!m) return raw;
  return `${m[1]} · ${m[2] === "Duplicated" ? "副本" : "冲突"} ${m[3]}`;
}

function parseUpdated(u) {  if (!u || u.length < 14 || !/^\d{14}$/.test(u)) return null;
  return new Date(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8), +u.slice(8, 10), +u.slice(10, 12));
}
function relTime(u) {
  const d = parseUpdated(u); if (!d) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today - day) / 86400000);
  if (diff <= 0) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff} 天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function greeting() {
  const h = new Date().getHours();
  if (h < 6) return "夜深了"; if (h < 11) return "早上好"; if (h < 14) return "中午好"; if (h < 18) return "下午好"; return "晚上好";
}

/* ---------- 剪贴板 ---------- */
async function copyText(text) {
  const s = String(text ?? "");
  try { await navigator.clipboard.writeText(s); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = s; ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch { }
    ta.remove();
  }
  showMessage("已复制到剪贴板", 1600);
}

/* ---------- 菜单：用思源原生 Menu ----------
   为什么用原生而不是自绘：第三方插件（如「云文档套件」）是监听 eventBus 的
   open-menu-doctree 事件、往原生文档树右键菜单里注入菜单项的
   —— 新建脑图(.mm) / 白板 / Excel / txt / html 都挂在这里。
   自绘菜单收不到这些注入，插件功能就"消失"了。
   所以这里改为：用原生 Menu 建菜单 + 主动派发 open-menu-doctree，
   目录树右键就等于原生文档树右键，插件注入项一个都不会少。 */
class CdMenu {
  static close() {
    const m = CdMenu._cur;
    CdMenu._cur = null;
    if (!m) return;
    try { m.destroy(); } catch { /* 原生菜单自己会随点击关闭 */ }
  }

  /**
   * 按思源内核的方式广播 open-menu-doctree：
   * 每个插件实例都有自己独立的 eventBus（内核是遍历 app.plugins 逐个 emit 的），
   * 只往一个 bus 上发，别的插件一个都收不到。
   * 少了这一步，云文档套件的「创建文件 → 新建脑图(.mm)」就不会出现在菜单里。
   */
  static _broadcast(plugin, menu, tree) {
    const EVT = "open-menu-doctree";
    const detail = {
      menu,
      type: tree.type,
      elements: tree.elements || [],
      items: [tree.type === "notebook"
        ? { id: tree.id, path: "/", notebookId: tree.id }
        : { id: tree.id, path: tree.hpath || "", notebookId: tree.notebookId || "" }]
    };
    const plugins = Array.from(plugin?.app?.plugins || []);
    const holder = menu.element?.querySelector(".b3-menu__items") || menu.element || null;
    const before = holder ? holder.children.length : 0;
    let fired = 0;
    for (const p of plugins) {
      if (!p?.eventBus?.emit) continue;
      try { p.eventBus.emit(EVT, detail); fired++; }
      catch (e) { console.warn("[cloud-docs-home] 插件菜单项注入失败", p?.name, e); }
    }
    // 真有插件加了东西，就在它们前面补一道分隔线（和原生菜单一致）
    if (holder && fired && holder.children.length > before) {
      const sep = document.createElement("button");
      sep.type = "button";
      sep.className = "b3-menu__separator";
      holder.insertBefore(sep, holder.children[before] || null);
    }
  }

  /**
   * items: [{label, icon, danger, disabled, sep, click}]
   * opts: {x, y, anchor, emitter, tree:{type:"doc"|"notebook", id, elements}}
   */
  static open(items, opts = {}) {
    CdMenu.close();
    let menu;
    try { menu = new Menu("cdh-menu"); } catch (e) { console.warn("[cloud-docs-home] 无法创建菜单", e); return; }
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { menu.addItem({ type: "separator" }); continue; }
      menu.addItem({
        // 原生菜单的 icon 必须是思源图标 id（iconXxx）；emoji 图标会自动忽略
        icon: /^icon[A-Z]/.test(String(it.icon || "")) ? it.icon : undefined,
        label: it.label,
        warning: !!it.danger,
        disabled: !!it.disabled,
        click: () => {
          Promise.resolve().then(it.click).catch(e => showMessage(e?.message || String(e), 4200, "error"));
        }
      });
    }
    // 把菜单交给第三方插件填内容：和原生文档树右键完全同源
    if (opts.tree && opts.emitter) CdMenu._broadcast(opts.emitter, menu, opts.tree);
    CdMenu._cur = menu;
    let x = opts.x ?? 0, y = opts.y ?? 0;
    if (opts.anchor) {
      const r = opts.anchor.getBoundingClientRect();
      x = r.right + 4; y = r.top;
    }
    try { menu.open({ x, y }); } catch (e) { console.warn("[cloud-docs-home] 菜单打开失败", e); }
  }
}

/* ---------- 轻量弹窗（确认 / 输入），Promise 化 ---------- */
function showModal({ title, body, okText = "确定", cancelText = "取消", danger = false, onSubmit, onMount }) {
  return new Promise(resolve => {
    CdMenu.close();
    const wrap = document.createElement("div");
    wrap.className = "cdh-modal";
    wrap.innerHTML = `
      <div class="cdh-modal-mask"></div>
      <div class="cdh-modal-card" role="dialog" aria-modal="true">
        <div class="cdh-modal-head"><b>${esc(title)}</b></div>
        <div class="cdh-modal-body">${body}</div>
        <div class="cdh-modal-foot">
          <button type="button" class="cdh-mbtn" data-cdh-cancel>${esc(cancelText)}</button>
          <button type="button" class="cdh-mbtn ${danger ? "is-danger" : "is-primary"}" data-cdh-ok>${esc(okText)}</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    const card = wrap.querySelector(".cdh-modal-card");
    let done = false;
    const close = v => {
      if (done) return; done = true;
      document.removeEventListener("keydown", onKey, true);
      wrap.remove();
      resolve(v);
    };
    const submit = async () => {
      try {
        if (onSubmit && await onSubmit(card, close) === false) return;
        close(true);
      } catch (e) { showMessage(e?.message || String(e), 4200, "error"); }
    };
    const onKey = e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === "Enter" && !e.isComposing) {
        const t = e.target;
        if (t && t.tagName === "TEXTAREA") return;
        e.preventDefault(); e.stopPropagation(); submit();
      }
    };
    wrap.querySelector("[data-cdh-cancel]").addEventListener("click", () => close(null));
    wrap.querySelector("[data-cdh-ok]").addEventListener("click", submit);
    wrap.querySelector(".cdh-modal-mask").addEventListener("click", () => close(null));
    document.addEventListener("keydown", onKey, true);
    if (onMount) { try { onMount(card, close); } catch (e) { console.error("[Cloud Docs Home] modal mount failed:", e); } }
    setTimeout(() => {
      const first = card.querySelector("input, textarea, select");
      if (first) { first.focus(); if (first.select) first.select(); }
      else card.querySelector("[data-cdh-ok]")?.focus();
    }, 30);
  });
}

/* ---------- 插件主体 ---------- */
class CloudDocsHome extends Plugin {
  onload() {
    const steps = [];
    this.steps = steps;
    this.trace = msg => {
      const line = new Date().toLocaleTimeString() + "." + String(Date.now() % 1000).padStart(3, "0") + " " + msg;
      steps.push(line);
      if (steps.length > 80) steps.splice(0, steps.length - 80);
      // 注意：这里只打控制台，绝不写插件数据目录——写 data/ 会触发内核文件事件导致插件热重载循环
      console.log("[Cloud Docs Home]", line);
    };
    const trace = this.trace;
    trace("start frontend=" + getFrontend() + " ua=" + String(navigator.userAgent).slice(0, 40));
    try {
      this.onloadInner();
      trace("OK: icons+tab+dock+command registered");
      console.log("[Cloud Docs Home] onloaded, frontend:", getFrontend());
    } catch (e) {
      trace("FAILED: " + (e && e.stack ? e.stack : String(e)));
      console.error("[Cloud Docs Home] onload failed:", e);
      throw e;
    }
  }
  onloadInner() {
    if (globalThis.siyuan?.isPublish || globalThis.siyuan?.config?.readonly) return;
    const plugin = this;
    this.views = new Set();
    this.lifecycle = new AbortController();
    this.config = null;
    /* 导航状态真源：Dock 里的常驻导航和标签页里的内容都读写这一份
       expanded 只记「用户手动点开的节点」。默认只展开一层，深层折叠——
       否则打开一篇日记会把它下面几十个子页签全铺开，树直接失控。 */
    this.nav = { openBoxId: null, boxDocs: null, boxError: "", expanded: new Set(), closed: new Set(), showConflicts: false, sortMode: "name", docTab: "outline" };
    this.navView = null;
    /* 刚建出来的文档在本地先挂着：内核 SQL 索引要几秒才追上，先显示出来用户才觉得"点了就生效" */
    this.pendingDocs = new Map();
    this.deletedDocs = new Map();

    this.addIcons('<symbol id="iconCloudHome" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="8" fill="#3370ff"/><path d="M21.8 20.2a4.3 4.3 0 0 0-8.1-2.1 3.7 3.7 0 0 0 .4 7.3h7.2a3.9 3.9 0 0 0 .5-5.2z" fill="#fff"/><path d="M12.6 17.4h3.2M12.6 19.9h5.4" stroke="#3370ff" stroke-width="1.4" stroke-linecap="round"/></symbol>');

    this.homeTab = null;
    this.addTab({
      type: "home",
      init() {
        plugin.homeTab = this;
        plugin.trace?.("tab init");
        plugin.mountHome(this.element);
      },
      destroy() {
        plugin.trace?.("tab destroy");
        if (plugin.homeTab === this) plugin.homeTab = null;
        for (const v of plugin.views) if (this.element.contains(v.root)) { v.dispose(); plugin.views.delete(v); }
      }
    });

    /* 已有首页标签页就切过去，绝不重复开 */
    const activateHome = () => {
      const tab = this.homeTab;
      if (!tab || !tab.headElement?.isConnected) return false;
      try {
        if (tab.parent?.switchTab) tab.parent.switchTab(tab.headElement);
        else tab.headElement.click();
      } catch { try { tab.headElement.click(); } catch { } }
      return true;
    };
    const open = () => {
      if (activateHome()) return;
      openTab({ app: this.app, custom: { icon: "iconCloudHome", title: "云文档", id: this.name + "home" } });
    };

    this.activateHome = activateHome;
    this.openHome = open;

    const mobile = ["mobile", "browser-mobile"].includes(getFrontend());
    if (!mobile) {
      this.addDock({
        config: { position: "LeftTop", size: { width: 300, height: 0 }, icon: "iconCloudHome", title: "云文档", hotkey: "" },
        data: {}, type: "cdhDock",
        init() {
          // 导航渲染在 Dock 里：切到文档标签页也还在，这是"文档页左侧也是云文档导航"的前提
          try { plugin.navView?.dispose(); } catch { }
          plugin.navView = new NavView(this.element, plugin);
        },
        destroy() {
          try { plugin.navView?.dispose(); } catch { }
          plugin.navView = null;
        }
      });
      // 注意：不要拦截 Dock 图标的点击。思源只在第一次点击时才创建面板 DOM，
      // 拦掉就等于导航永远建不出来（v0.8 踩过）。
    } else {
      this.addTopBar({ icon: "iconCloudHome", title: "云文档首页", position: "right", callback: open });
    }
    this.addCommand({ langKey: "open-cloud-docs-home", langText: "打开云文档首页", callback: open });

    // 把思源自带的「空白欢迎页」（搜索/最近文档/新建文档 那一屏）直接换成知识库首页
    this.setupEmptyPageTakeover();

    // 左侧常驻云文档导航：拦掉原生面板、必要时切回来、跟随当前文档拉大纲/反链
    this.startNavGuard();

    // 打开思源后默认进入云文档首页（每次启动，可在首页右上角 ⚙ 关闭）
    this.ensureStartupHome(open);
    this.onClosedTabDelete = ({ detail }) => {
      if (detail?.cmd === "removeDoc") {
        this.scheduleClosedTabCleanup();
        for (const id of detail.data?.ids || []) this.dropDocLocal(id);
      }
      const structuralTransaction = detail?.cmd === "transactions" && Array.isArray(detail.data) &&
        detail.data.some(transaction => (transaction.doOperations || []).some(operation =>
          operation.action === "create" || operation.action === "restoreCreatedDoc"));
      if (structuralTransaction || ["removeDoc", "moveDoc", "moveDocs", "rename", "createdailynote", "heading2doc", "li2doc"].includes(detail?.cmd)) {
        if (structuralTransaction && detail.data.some(transaction =>
          (transaction.doOperations || []).some(operation => operation.action === "restoreCreatedDoc"))) this.deletedDocs.clear();
        this.navView?.render();
        this.syncViews();
        clearTimeout(this.documentEventTimer);
        this.documentEventTimer = setTimeout(() => {
          if (!this.lifecycle.signal.aborted) this.afterDocChange().catch(error => this.trace?.("directory refresh failed: " + error.message));
        }, 250);
      }
    };
    this.eventBus.on("ws-main", this.onClosedTabDelete);
    document.addEventListener("cloud-docs-home:document-created", event => {
      this.onSuiteDocumentCreated(event.detail).catch(error => this.trace?.("created document refresh failed: " + error.message));
    }, { signal: this.lifecycle.signal });
    document.addEventListener("cloud-docs-home:reveal-imported-document", event => {
      const entry = event.detail;
      if (!entry?.id || !entry.box || !entry.path || !entry.hpath || !this.navVisible()) return;
      event.preventDefault();
      this.revealImportedDocument(entry).catch(error => this.trace?.("import navigation failed: " + error.message));
    }, { signal: this.lifecycle.signal });
  }

  onLayoutReady() {
    if (this.lifecycle) this.scheduleClosedTabCleanup();
  }

  scheduleClosedTabCleanup() {
    clearTimeout(this.closedTabTimer);
    this.closedTabTimer = setTimeout(() => {
      if (this.closedTabCleanupRunning) {
        this.scheduleClosedTabCleanup();
        return;
      }
      this.closedTabCleanupRunning = true;
      this.pruneClosedTabs().catch(() => this.trace?.("closed tab cleanup skipped"))
        .finally(() => { this.closedTabCleanupRunning = false; });
    }, 1500);
  }

  async pruneClosedTabs() {
    const host = globalThis.siyuan;
    const storage = host?.storage;
    const app = this.app?.appId;
    const signal = this.lifecycle?.signal;
    const tabs = storage?.[CLOSED_TABS_KEY];
    if (!signal || signal.aborted || !app || host.isPublish || host.config?.readonly || !Array.isArray(tabs)) return;

    const snapshot = closedTabSnapshot(tabs);
    const editor = tab => {
      const data = tab?.children;
      return data?.instance === "Editor" && SIYUAN_NODE_ID.test(data.rootId) &&
        SIYUAN_NODE_ID.test(data.notebookId) ? data : null;
    };
    const editors = tabs.map(editor).filter(Boolean);
    if (!editors.length) return;

    const { notebooks } = await this.api("/api/notebook/lsNotebooks", {});
    const openBoxes = new Set(notebooks.filter(book => book.closed === false).map(book => book.id));
    const eligible = editors.filter(data => openBoxes.has(data.notebookId));
    if (!eligible.length) return;

    const quoted = values => [...new Set(values)].map(id => `'${id}'`).join(",");
    const roots = quoted(eligible.map(data => data.rootId));
    const boxes = quoted(eligible.map(data => data.notebookId));
    const rows = await this.api("/api/query/sql", {
      stmt: `SELECT id, box FROM blocks WHERE type='d' AND id IN (${roots})
        UNION ALL SELECT '' AS id, box FROM blocks WHERE type='d' AND box IN (${boxes}) GROUP BY box`
    });
    if (!Array.isArray(rows)) return;
    const live = new Set(rows.filter(row => row.id).map(row => row.id));
    const indexed = new Set(rows.filter(row => row.id === "").map(row => row.box));
    const keep = tabs.filter(tab => {
      const data = editor(tab);
      return !data || !indexed.has(data.notebookId) || live.has(data.rootId);
    });
    if (keep.length === tabs.length) return;

    // Skip a write if another client or the current window changed the list during lookup.
    const latest = await this.api("/api/storage/getLocalStorage", {});
    if (signal.aborted || host.storage !== storage || closedTabSnapshot(storage[CLOSED_TABS_KEY]) !== snapshot ||
      closedTabSnapshot(latest?.[CLOSED_TABS_KEY]) !== snapshot) return;
    await this.api("/api/storage/setLocalStorageVal", { app, key: CLOSED_TABS_KEY, val: keep });
    if (!signal.aborted && host.storage === storage && closedTabSnapshot(storage[CLOSED_TABS_KEY]) === snapshot) {
      storage[CLOSED_TABS_KEY] = keep;
    }
  }

  /* ---------- 用知识库首页取代思源的空白欢迎页 ---------- */

  setupEmptyPageTakeover() {
    this.emptyViews = new Map(); // panel 元素 -> HomeView
    const scan = () => {
      // 面板被思源复用成文档编辑区、或已被销毁 → 回收视图并还原原生 DOM
      for (const [panel, view] of [...this.emptyViews]) {
        if (!panel.isConnected || !panel.contains(view.root)) {
          view.dispose(); this.views.delete(view); this.emptyViews.delete(panel);
          if (panel.isConnected) this.releaseEmptyPanel(panel);
        }
      }
      for (const panel of document.querySelectorAll(".layout__empty")) this.mountEmptyPage(panel);
    };
    this.scanEmptyPages = scan;
    // body 上的 DOM 变动非常频繁（编辑器也在改），节流到 300ms 一次
    let last = 0;
    this.emptyObserver = new MutationObserver(() => {
      const now = Date.now();
      if (now - last < 300) return;
      last = now;
      setTimeout(scan, 0);
    });
    this.emptyObserver.observe(document.body, { childList: true, subtree: true });
    // 切标签页时立刻补一次，避免等节流
    document.addEventListener("click", e => {
      if (e.target instanceof Element && e.target.closest(".layout-tab-bar")) setTimeout(scan, 0);
    }, { capture: true, passive: true, signal: this.lifecycle.signal });
    scan();
  }

  /** 把首页渲染进空白页容器：原生菜单整体隐藏（保留 DOM，事件绑定不受影响），首页占满整屏 */
  mountEmptyPage(panel) {
    if (!panel || !this.emptyViews || this.emptyViews.has(panel)) return;
    if (panel.querySelector(".cdh-emptypanel-root")) return;
    panel.classList.add("cdh-emptypanel");
    for (const child of Array.from(panel.children)) {
      if (child.classList.contains("cdh-emptypanel-root")) continue;
      child.dataset.cdhHidden = "1";
      child.style.display = "none";
    }
    const root = document.createElement("div");
    root.className = "cdh-emptypanel-root";
    panel.appendChild(root);
    const view = new HomeView(root, this);
    this.views.add(view);
    this.emptyViews.set(panel, view);
  }

  releaseEmptyPanel(panel) {
    panel.classList.remove("cdh-emptypanel");
    panel.querySelector(".cdh-emptypanel-root")?.remove();
    for (const child of panel.querySelectorAll("[data-cdh-hidden]")) {
      child.style.display = "";
      delete child.dataset.cdhHidden;
    }
  }

  /* ---------- 常驻导航调度：Dock 里的导航 <-> 标签页里的内容 ---------- */

  /** 导航需要的轻量状态（不查全量文档，比 fetchState 便宜） */
  async fetchNavState() {
    await this.loadConfig();
    const [nbData, counts] = await Promise.all([
      this.api("/api/notebook/lsNotebooks", {}),
      this.api("/api/query/sql", { stmt: "SELECT box, COUNT(id) AS c FROM blocks WHERE type='d' AND id != box AND COALESCE(content,'') NOT LIKE '%(Conflicted %' GROUP BY box" })
    ]);
    const notebooks = (nbData.notebooks || []).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const countMap = {};
    for (const r of counts || []) countMap[r.box] = r.c;
    return { notebooks, openNotebooks: notebooks.filter(n => !n.closed), countMap };
  }

  /** 刷新所有内容视图（可能有多个标签页/空白页实例） */
  syncViews() {
    for (const v of this.views) {
      try { if (!v.disposed) v.render(); } catch (e) { this.trace?.("view render failed: " + (e?.message || e)); }
    }
  }

  /** 切到首页标签页；没有就新建一个 */
  showHome() {
    if (this.activateHome?.()) return;
    this.openHome?.();
  }

  /** 进入某个库：内容区显示该库，左侧导航就地展开它的目录 */
  async goBox(box, opts = {}) {
    if (!box) return;
    const nav = this.nav;
    if (!opts.force && nav.openBoxId === box && nav.boxDocs) {
      if (!opts.keepEditor) this.showHome();
      this.syncViews(); this.navView?.render();
      return;
    }
    const request = this.boxDocsRequest = (this.boxDocsRequest || 0) + 1;
    if (nav.openBoxId !== box) nav.folderSelection = null;
    nav.openBoxId = box;
    nav.boxDocs = null; nav.boxError = "";
    const st = this.loadExpanded(box);
    nav.expanded = st.open; nav.closed = st.closed;
    nav.showConflicts = false;
    if (!opts.keepEditor) this.showHome();
    this.syncViews();
    this.navView?.render();
    try {
      const docs = await this.fetchBoxDocs(box);
      if (nav.openBoxId !== box || this.boxDocsRequest !== request) return;
      nav.boxDocs = docs;
    } catch (e) {
      if (nav.openBoxId !== box || this.boxDocsRequest !== request) return;
      nav.boxError = e?.message || String(e);
    }
    this.syncViews();
    this.navView?.render();
  }

  /** 收起当前库，回到卡片墙 */
  goHome() {
    const nav = this.nav;
    this.boxDocsRequest = (this.boxDocsRequest || 0) + 1;
    nav.openBoxId = null; nav.boxDocs = null; nav.boxError = "";
    nav.folderSelection = null;
    nav.expanded = new Set(); nav.closed = new Set(); nav.showConflicts = false;
    this.showHome();
    this.syncViews();
    this.navView?.render();
  }

  /* ---------- 常驻导航：思源原生左侧面板彻底停用 ---------- */

  /** 导航此刻是否真的显示在屏幕上 */
  navVisible() {
    const nav = document.querySelector(".cdh-nav-root");
    return !!nav && nav.getBoundingClientRect().width > 20;
  }

  /** 左侧这一列是否展开着（整列收起时宽 0，此时不去硬撑，那是用户主动行为） */
  leftColumnOpen() {
    const dockl = document.querySelector(".layout__dockl");
    return !!dockl && dockl.getBoundingClientRect().width > 20;
  }

  /** 左侧 Dock 上当前高亮的是哪个面板类型（第三方插件面板开着时要让位） */
  activeLeftDockType() {
    const el = document.querySelector('#dockLeft .dock__item--active[data-type]')
      || document.querySelector('#dockLeft .dock__item--current[data-type]');
    return el ? (el.getAttribute("data-type") || "") : "";
  }

  /** 当前正在编辑的文档 id（首页、无文档时为 null） */
  currentDocId() {
    const list = [...document.querySelectorAll(".protyle-background")].filter(b => b.offsetParent !== null);
    return list.length ? list[list.length - 1].getAttribute("data-node-id") : null;
  }

  /** 跟随当前文档：把大纲与反链拉进导航（原生面板一个都不开） */
  async syncDocContext(id = this.currentDocId()) {
    if (id === this.docCtxId) return;
    this.docCtxId = id;
    if (!id) { this.docCtx = null; this.navView?.render(); return; }
    this.docCtx = { id, title: "", outline: null, backlinks: null };
    this.navView?.render();
    try {
      const [ol, bl] = await Promise.all([this.fetchOutline(id), this.fetchBacklinks(id)]);
      if (this.docCtxId !== id) return;
      this.docCtx = { id, title: ol.title, outline: ol.outline, backlinks: bl };
      this.navView?.render();
    } catch (e) { this.trace?.("docCtx failed: " + (e?.message || e)); }
  }

  async fetchOutline(id) {
    const data = await this.api("/api/outline/getDocOutline", { id });
    // 没有标题的文档，内核直接返回 data:null —— 标题另外补一次
    const root = Array.isArray(data) ? data[0] : null;
    const title = root ? String(root.name ?? "") : await this.docTitle(id);
    const flat = [];
    const text = v => String(v ?? "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    const walk = (nodes, depth) => {
      for (const n of nodes || []) {
        if (String(n.type || "").startsWith("NodeHeading") || /^h[1-6]$/.test(n.subType || "")) {
          flat.push({ id: n.id, name: text(n.content || n.name) || "无标题", depth, sub: n.subType || "h2" });
        }
        if (n.children?.length) walk(n.children, depth + 1);
      }
    };
    walk(root?.blocks || [], 0);
    return { title: text(title), outline: flat };
  }

  /** 文档标题（大纲接口对"无标题文档"会返回 null，这里兜底） */
  async docTitle(id) {
    const rows = await this.api("/api/query/sql", { stmt: `SELECT content FROM blocks WHERE id = '${sqlSafe(id)}' LIMIT 1` });
    return String(rows?.[0]?.content || "");
  }

  async fetchBacklinks(id) {
    const rows = await this.api("/api/query/sql", {
      stmt: `SELECT DISTINCT r.block_id AS bid, r.root_id AS rid, b.content AS snip, d.content AS doc
             FROM refs r LEFT JOIN blocks b ON b.id = r.block_id LEFT JOIN blocks d ON d.id = r.root_id
             WHERE r.def_block_root_id = '${sqlSafe(id)}' LIMIT 80`
    });
    return (rows || []).map(r => ({
      id: r.bid, docId: r.rid,
      doc: String(r.doc || "未命名文档"),
      snip: String(r.snip || "").replace(/\s+/g, " ").trim().slice(0, 90)
    }));
  }

  /** 跳到某个块（大纲 / 反链共用） */
  scrollToBlock(blockId) {
    const safe = String(blockId).replace(/"/g, "");
    const el = document.querySelector(`.protyle-content [data-node-id="${safe}"]`)
      || document.querySelector(`[data-node-id="${safe}"]`);
    if (!el) { showMessage("这段内容还没被加载出来，往下滚一点再试", 2600); return; }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("cdh-flash");
    setTimeout(() => el.classList.remove("cdh-flash"), 1400);
  }

  /** 从反链跳到来源文档，并定位到具体那一块 */
  async openDocAt(docId, blockId) {
    await this.openDoc(docId);
    if (!blockId) return;
    for (let i = 0; i < 14; i++) {
      await new Promise(r => setTimeout(r, 260));
      if (this.currentDocId() !== docId) continue;
      if (document.querySelector(`[data-node-id="${String(blockId).replace(/"/g, "")}"]`)) { this.scrollToBlock(blockId); return; }
    }
  }

  /** 切到导航：已经显示就什么都不做，否则借 Dock 图标让思源把面板打开 */
  showNav() {
    if (this.navVisible()) return;
    document.querySelector(`#dockLeft .dock__item[data-type="${this.name}cdhDock"]`)?.click();
  }

  /** 启动后把左侧默认停在导航上；不可见才点，否则会把开着的面板 toggle 关掉 */
  ensureNavTab() {
    const once = () => {
      if (this.navVisible()) return;
      this.navTabTries = (this.navTabTries || 0) + 1;
      if (this.navTabTries > 5) return;
      document.querySelector(`#dockLeft .dock__item[data-type="${this.name}cdhDock"]`)?.click();
      this.navTabTimer = setTimeout(once, 600);
    };
    const go = () => { clearTimeout(this.navTabTimer); this.navTabTries = 0; this.navTabTimer = setTimeout(once, 900); };
    this.loadConfig().then(cfg => { if (cfg.navOnStartup !== false) go(); }, go);
  }

  /**
   * 导航看门：左侧的文档树/大纲/反链由云文档导航接管。
   * ① 这三个原生面板的图标点击被吞掉——既不建面板，也不让思源写回 uiLayout；
   * ② 书签、标签、收集箱、关系图、第三方插件面板照常可用，用户在用的时候让位不抢；
   * ③ 面板被别处切走（重启恢复、快捷键）时，低频检查后自动切回；
   * ④ 顺带同步当前文档的大纲/反链。
   */
  startNavGuard() {
    document.addEventListener("click", event => {
      const item = event.target instanceof Element ? event.target.closest("#dockLeft .dock__item") : null;
      if (!item) return;
      const type = item.getAttribute("data-type") || "";
      // 自己那个图标：不可见时放行（思源靠这次点击创建面板）；已经在显示时吞掉点击，
      // 否则思源会把它 toggle 关掉——用户点「云文档」一定是想回到导航，不是想关掉它
      if (type === this.name + "cdhDock") {
        if (this.navVisible()) { event.preventDefault(); event.stopImmediatePropagation(); }
        return;
      }
      // 只拦思源自带的面板；第三方插件的 Dock 照常可用（不替别人做决定）
      if (!TAKEN_OVER_DOCKS.has(type)) { this.guardPauseUntil = Date.now() + 20000; return; }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (Date.now() - (this.nativeTipAt || 0) > 15000) {
        this.nativeTipAt = Date.now();
        showMessage("文档树 / 大纲 / 反链已由左侧「云文档」导航接管", 2600);
      }
      setTimeout(() => { if (this.leftColumnOpen() && !this.navVisible()) this.showNav(); }, 30);
    }, { capture: true, signal: this.lifecycle.signal });

    const tick = () => {
      if (this.lifecycle.signal.aborted) return;
      try { this.guardTick(); } catch (e) { this.trace?.("guard failed: " + (e?.message || e)); }
      this.guardTimer = setTimeout(tick, this.navVisible() ? 1500 : 500);
    };
    this.guardTimer = setTimeout(tick, 800);
    this.ensureNavTab();
  }

  guardTick() {
    this.syncDocContext();
    if (Date.now() < (this.guardPauseUntil || 0)) return; // 用户刚点过第三方面板，先别抢
    if (this.navVisible()) { this.navKicks = 0; return; }
    // 第三方插件的面板正在使用中：让位，直到用户自己切回云文档导航（插件功能完整可用）
    const act = this.activeLeftDockType();
    if (act && act !== this.name + "cdhDock" && !TAKEN_OVER_DOCKS.has(act)) { this.navKicks = 0; return; }
    // 整列收起是用户自己收的，不硬撑；但只要这一列开着，就必须是我们的导航
    if (!this.leftColumnOpen()) return;
    const now = Date.now();
    if (now - (this.navKickAt || 0) < 1200) return;
    this.navKickAt = now;
    this.navKicks = (this.navKicks || 0) + 1;
    if (this.navKicks > 8) return; // 不和思源打乒乓
    this.showNav();
  }

  /**
   * 启动默认页：先等思源把上次会话的标签页恢复完，再决定落点——
   * 有空白欢迎页就直接取代它（不新开标签）；已恢复首页标签就切过去；都没有才新开一个。
   */
  async ensureStartupHome(open) {
    let cfg;
    try { cfg = await this.loadConfig(); } catch { cfg = { pins: [] }; }
    if (cfg.openOnStartup === false) return;
    let retried = false;
    const settle = () => {
      this.trace?.("settle homeTab=" + !!this.homeTab?.headElement?.isConnected + " empty=" + document.querySelectorAll(".layout__empty").length);
      if (this.homeTab?.headElement?.isConnected) { open(); return; }
      const empty = document.querySelector(".layout__empty");
      if (empty && this.emptyViews) { this.mountEmptyPage(empty); return; }
      if (!retried) { retried = true; setTimeout(settle, 600); return; }
      open();
    };
    setTimeout(settle, 600);
  }

  onunload() {
    clearTimeout(this.documentEventTimer);
    clearTimeout(this.closedTabTimer);
    if (this.onClosedTabDelete) this.eventBus.off("ws-main", this.onClosedTabDelete);
    this.emptyObserver?.disconnect();
    this.emptyObserver = null;
    clearTimeout(this.navTabTimer);
    this.navTabTimer = null;
    clearTimeout(this.guardTimer);
    this.guardTimer = null;
    clearTimeout(this._afterTimer);
    clearTimeout(this._reconcileTimer);
    try { this.navView?.dispose(); } catch { }
    this.navView = null;
    this.lifecycle?.abort();
    for (const v of this.views) v.dispose();
    this.views.clear();
    if (this.emptyViews) {
      for (const panel of [...this.emptyViews.keys()]) this.releaseEmptyPanel(panel);
      this.emptyViews.clear();
    }
  }

  mountHome(element) {
    const root = document.createElement("div");
    root.style.height = "100%";
    element.appendChild(root);
    const view = new HomeView(root, this);
    this.views.add(view);
    this.trace?.("mountHome, views=" + this.views.size + " panelChildren=" + element.children.length);
  }

  /* ---------- 内核 API 封装 ---------- */
  async api(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw Error(`思源接口 ${path} 请求失败：HTTP ${r.status}`);
    if (!text) throw Error(`思源接口 ${path} 返回空响应`);
    let j;
    try { j = JSON.parse(text); } catch { throw Error(`思源接口 ${path} 返回了非 JSON 内容`); }
    if (j.code !== 0) throw Error(j.msg || "思源接口返回错误");
    return j.data;
  }

  async loadConfig() {
    if (this.config) return this.config;
    if (!this.configLoading) {
      this.configLoading = (async () => {
        const raw = await this.loadData("config.json");
        const config = typeof raw === "string" ? (raw ? JSON.parse(raw) : null) : raw;
        if (config != null && (typeof config !== "object" || Array.isArray(config))) {
          throw Error("云文档配置格式异常，已停止保存，请检查或恢复配置文件");
        }
        const result = config || {};
        if (result.pins !== undefined && !Array.isArray(result.pins)) {
          throw Error("云文档置顶配置格式异常，已停止保存");
        }
        result.pins ||= [];
        if (result.navigationOrder !== undefined && !Array.isArray(result.navigationOrder)) {
          throw Error("云文档排序配置格式异常，已停止保存");
        }
        this.config = result;
        if (this.nav) this.nav.sortMode = ["manual", "name", "time"].includes(result.documentSortMode)
          ? result.documentSortMode : result.navigationOrder?.length ? "manual" : "name";
        return result;
      })();
    }
    try { return await this.configLoading; }
    finally { this.configLoading = null; }
  }

  async saveConfig() {
    const config = await this.loadConfig();
    await this.saveData("config.json", config);
  }

  queueNavigationChange(change) {
    const pending = (this.navigationChange || Promise.resolve()).catch(() => {}).then(change);
    this.navigationChange = pending;
    return pending;
  }

  async setSortMode(mode) {
    return this.queueNavigationChange(async () => {
      const config = await this.loadConfig();
      const previous = config.documentSortMode;
      const previousMode = this.nav.sortMode;
      config.documentSortMode = ["manual", "time"].includes(mode) ? mode : "name";
      this.nav.sortMode = config.documentSortMode;
      try { await this.saveConfig(); }
      catch (error) {
        config.documentSortMode = previous;
        this.nav.sortMode = previousMode;
        throw error;
      }
      this.navView?.render();
      this.syncViews();
    });
  }

  manualOrder(a, b) {
    const ids = this.config?.navigationOrder || [];
    const left = ids.indexOf(a), right = ids.indexOf(b);
    if (left < 0 && right < 0) return 0;
    if (left < 0) return 1;
    if (right < 0) return -1;
    return left - right;
  }

  async reorderNavigation(source, target, after, siblings, isDocument = true) {
    return this.queueNavigationChange(async () => {
      const config = await this.loadConfig();
      const ids = siblings.filter(id => id !== source);
      if (!ids.includes(target) || source === target) return;
      ids.splice(ids.indexOf(target) + (after ? 1 : 0), 0, source);
      const previous = config.navigationOrder;
      const previousMode = config.documentSortMode;
      const previousNavMode = this.nav?.sortMode;
      config.navigationOrder = [...(previous || []).filter(id => !siblings.includes(id)), ...ids];
      if (isDocument) {
        config.documentSortMode = "manual";
        if (this.nav) this.nav.sortMode = "manual";
      }
      try { await this.saveConfig(); }
      catch (error) {
        config.navigationOrder = previous;
        config.documentSortMode = previousMode;
        if (this.nav) this.nav.sortMode = previousNavMode;
        throw error;
      }
      this.navView?.render();
      await this.syncViews();
    });
  }


  async fetchState() {
    const [nbData, docs, counts] = await Promise.all([
      this.api("/api/notebook/lsNotebooks", {}),
      this.api("/api/query/sql", { stmt: "SELECT id, box, hpath, content, updated FROM blocks WHERE type='d' AND id != box AND COALESCE(content,'') NOT LIKE '%(Conflicted %' ORDER BY updated DESC LIMIT 400" }),
      this.api("/api/query/sql", { stmt: "SELECT box, COUNT(id) AS c FROM blocks WHERE type='d' AND id != box AND COALESCE(content,'') NOT LIKE '%(Conflicted %' GROUP BY box" })
    ]);
    const notebooks = (nbData.notebooks || []).slice().sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
    const openNotebooks = notebooks.filter(n => !n.closed);
    const closedCount = notebooks.length - openNotebooks.length;
    const openBoxes = new Set(openNotebooks.map(n => n.id));
    const rows = (docs || []).filter(r => openBoxes.has(r.box) && !this.hideDeletedDoc(r.id));
    for (const [id, item] of this.pendingDocs || []) {
      if (openBoxes.has(item.row.box) && !this.deletedDocs?.has(id) && !rows.some(row => row.id === id)) rows.push(item.row);
    }
    rows.sort((a, b) => String(b.updated || "").localeCompare(String(a.updated || "")));
    const countMap = {}; for (const r of counts || []) countMap[r.box] = r.c;
    const newestByBox = {}; const seen = new Set();
    for (const r of rows) if (!seen.has(r.box)) { seen.add(r.box); newestByBox[r.box] = r; }
    const boxName = {}; for (const n of notebooks) boxName[n.id] = splitNotebookName(n.name).text;
    const totalDocs = openNotebooks.reduce((sum, n) => sum + (countMap[n.id] || 0), 0);
    return {
      notebooks, openNotebooks, closedCount, rows, countMap, newestByBox, boxName, totalDocs,
      recent: rows.slice(0, 8),
      config: await this.loadConfig()
    };
  }

  /* ---------- 目录树的展开状态 ----------
     默认全部折叠：打开一个库只看到顶层条目（日记库就是几个月），想看哪层点哪层。
     之前是"默认展开"，打开日记库一次铺开 172 篇（月份 → 每天全展开），树直接失控。
     展开 / 折叠都由用户点出来，按库记住，刷新或重开还在。 */

  expandedKey(box) { return `cdh-expanded:${box || ""}`; }

  loadExpanded(box) {
    try {
      const raw = JSON.parse(localStorage.getItem(this.expandedKey(box)) || "{}");
      return {
        open: new Set(Array.isArray(raw?.open) ? raw.open.filter(x => typeof x === "string") : []),
        closed: new Set(Array.isArray(raw?.closed) ? raw.closed.filter(x => typeof x === "string") : [])
      };
    } catch { return { open: new Set(), closed: new Set() }; }
  }

  saveExpanded() {
    try {
      localStorage.setItem(this.expandedKey(this.nav.openBoxId), JSON.stringify({
        open: [...this.nav.expanded], closed: [...(this.nav.closed || [])]
      }));
    } catch { /* 隐私模式等写不了就算了，不影响功能 */ }
  }

  toggleNode(path) {
    if (!path) return;
    const { expanded, closed } = this.nav;
    closed ||= new Set();
    if (expanded.has(path)) { expanded.delete(path); closed.add(path); }
    else { expanded.add(path); closed.delete(path); }
    this.nav.closed = closed;
    this.saveExpanded();
  }

  /** 取某个笔记本下的全部文档（含 hpath 层级路径），用于库目录树。
   *  这里不做过过滤，冲突副本由渲染层收进「同步冲突」入口，避免把数据藏死。 */
  async fetchBoxDocs(box) {
    const rows = await this.api("/api/query/sql", {
      stmt: `SELECT id, box, path, hpath, content, updated, ial FROM blocks WHERE type='d' AND box='${sqlSafe(box)}' ORDER BY hpath LIMIT 3000`
    }) || [];
    // 把还没被索引的新文档补回去；索引追上后自动移除（超过 30 秒没人认领就丢弃）
    for (const [id, item] of [...this.pendingDocs]) {
      if (Date.now() - item.at > 30000) { this.pendingDocs.delete(id); continue; }
      if (item.row.box !== box) continue;
      if (rows.some(r => r.id === id)) { this.pendingDocs.delete(id); continue; }
      rows.push(item.row);
    }
    const deleted = this.deletedDocs || new Map();
    for (const [id, item] of deleted) {
      if (item.box === box && !rows.some(row => row.id === id)) deleted.delete(id);
    }
    return rows.filter(row => !this.hideDeletedDoc(row.id));
  }

  hideDeletedDoc(id) {
    const entry = this.deletedDocs?.get(id);
    if (!entry) return false;
    if (Date.now() - entry.at < 30000) return true;
    this.deletedDocs.delete(id);
    return false;
  }

  async searchDocs(q) {
    const rows = await this.api("/api/query/sql", {
      stmt: `SELECT id, box, hpath, content, updated FROM blocks WHERE type='d' AND id != box AND COALESCE(content,'') NOT LIKE '%(Conflicted %' AND content LIKE '%${sqlSafe(q)}%' ESCAPE '\\' LIMIT 12`
    });
    return rows || [];
  }

  async openDoc(id) {
    try { await openTab({ app: this.app, doc: { id } }); }
    catch (e) { showMessage("打开文档失败：" + (e?.message || e), 3000, "error"); }
  }

  addSuiteDocument(entry) {
    if (!entry?.id || !entry.box || !entry.path || !entry.hpath) return false;
    const { id, box, path, hpath, title, kind } = entry;
    const row = { id, box, path, hpath, content: title, updated: this.stampNow() };
    if (typeof kind === "string" && /^[a-z-]+$/.test(kind)) row.ial = `custom-cloud-document-kind="${kind}"`;
    this.addDocLocal(row);
    return true;
  }

  async onSuiteDocumentCreated(entry) {
    if (this.addSuiteDocument(entry)) await this.afterDocChange();
  }

  async revealImportedDocument(entry) {
    if (!this.addSuiteDocument(entry)) return;
    const { id, box } = entry;
    void this.syncDocContext(id);
    if (this.nav.openBoxId !== box || !this.nav.boxDocs) await this.goBox(box, { keepEditor: true });
    if (this.lifecycle.signal.aborted || this.nav.openBoxId !== box || this.docCtxId !== id) return;
    this.navView?.revealDoc(id);
  }

  /* ---------- 文档操作 ----------
     原生文档树有的能力全部就地实现：新建子文档、重命名、副本、移动、删除、
     复制引用 / ID / Markdown、置顶、知识库改名与关闭。 */

  /** 增删改后就地刷新：导航树 + 内容区，不跳页、不额外开标签 */
  async afterDocChange() {
    this.navView?.render();
    this.syncViews();
    await this.refreshAllViews();
    if (this.lifecycle?.signal.aborted) return;
    // 思源的 SQL 索引有几百毫秒延迟：稍后再刷一次，免得树上还留着刚删掉的条目
    clearTimeout(this._afterTimer);
    clearTimeout(this._reconcileTimer);
    this._afterTimer = setTimeout(() => { this.refreshAllViews().catch(() => { }); }, 1600);
    this._reconcileTimer = setTimeout(() => { this.refreshAllViews().catch(() => { }); }, 5000);
  }

  async refreshAllViews() {
    const nav = this.nav;
    const box = nav.openBoxId;
    if (box) {
      const request = this.boxDocsRequest = (this.boxDocsRequest || 0) + 1;
      try {
        const docs = await this.fetchBoxDocs(box);
        if (nav.openBoxId === box && this.boxDocsRequest === request) {
          nav.boxDocs = docs;
          nav.boxError = "";
        }
      } catch (e) {
        if (nav.openBoxId === box && this.boxDocsRequest === request) nav.boxError = e?.message || String(e);
      }
    }
    if (this.navView) await this.navView.refresh();
    // 首页内容也重拉一次：删掉的文档不该还留在「最近」里
    for (const v of this.views) {
      try { if (!v.disposed) { if (v.reload) await v.reload(); else v.render(); } } catch { }
    }
  }

  /** 内核 SQL 索引有几秒延迟，改完先在本地树上改掉，用户才觉得"点一下就生效" */
  patchDocLocal(id, title) {
    const rows = this.nav.boxDocs;
    if (!rows) return;
    const hit = rows.find(r => r.id === id);
    if (!hit) return;
    const oldHp = String(hit.hpath || "");
    const newHp = oldHp.replace(/[^/]*$/, title);
    hit.content = title;
    hit.hpath = newHp;
    for (const r of rows) {
      const hp = String(r.hpath || "");
      if (hp.startsWith(oldHp + "/") && (!hit.path || this.isSelfOrDescendant(hit, r))) r.hpath = newHp + hp.slice(oldHp.length);
    }
  }

  dropDocLocal(id, box) {
    const rows = this.nav.boxDocs || [];
    const hit = rows.find(r => r.id === id);
    const hp = hit ? String(hit.hpath || "") : "";
    this.deletedDocs ||= new Map();
    const at = Date.now();
    for (const [deletedId, entry] of this.deletedDocs) {
      if (at - entry.at >= 30000) this.deletedDocs.delete(deletedId);
    }
    const isDeleted = row => row.id === id || (hit?.path
      ? this.isSelfOrDescendant(hit, row)
      : hp && row.box === hit.box && String(row.hpath || "").startsWith(hp + "/"));
    const knownBox = box || hit?.box || this.pendingDocs.get(id)?.row.box || this.deletedDocs.get(id)?.box;
    this.deletedDocs.set(id, { box: knownBox, at });
    for (const row of [...rows, ...Array.from(this.pendingDocs.values(), item => item.row)]) {
      if (!isDeleted(row)) continue;
      this.deletedDocs.set(row.id, { box: row.box, at });
      this.pendingDocs.delete(row.id);
    }
    if (this.nav.boxDocs) this.nav.boxDocs = rows.filter(row => !isDeleted(row));
  }

  /** 新建/复制的文档先插进本地树，并让它所在的父节点展开 */
  addDocLocal(row, parentID) {
    if (!row?.id) return;
    const parentHpath = String(row.hpath || "").replace(/\/[^/]*$/, "");
    const candidates = (this.nav.boxDocs || []).filter(item => item.box === row.box &&
      (parentID ? item.id === parentID : item.hpath === parentHpath));
    const parentDoc = candidates.length === 1 ? candidates[0] : null;
    if (!row.path && parentDoc?.path) row.path = parentDoc.path.replace(/\.sy$/, "") + "/" + row.id + ".sy";
    if (!row.path && !parentHpath) row.path = "/" + row.id + ".sy";
    this.deletedDocs?.delete(row.id);
    this.pendingDocs.set(row.id, { row, at: Date.now() });
    const rows = this.nav.boxDocs;
    if (!rows || (this.nav.openBoxId && this.nav.openBoxId !== row.box)) return;
    if (!rows.some(r => r.id === row.id)) rows.push(row);
    const parent = row.path && row.path.lastIndexOf("/") > 0
      ? row.path.slice(0, row.path.lastIndexOf("/")) + ".sy"
      : String(row.hpath || "").replace(/[^/]*$/, "").replace(/^\/+|\/+$/g, "");
    if (parent) {
      this.nav.expanded.add(parent);
      this.nav.closed?.delete(parent);
      this.saveExpanded();
    }
  }

  /** 思源格式的时间戳 20261030145655 */
  stampNow() {
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** 是不是自己或自己的子文档（移动时防止移进自己的子孙） */  isSelfOrDescendant(doc, other) {
    if (!doc || !other) return false;
    if (other.id === doc.id) return true;
    const path = String(doc.path || "").replace(/\.sy$/, "");
    return doc.box === other.box && !!path && String(other.path || "").startsWith(path + "/");
  }

  async renameDoc(doc) {
    let title = "";
    const ok = await showModal({
      title: "重命名文档",
      okText: "保存",
      body: `<label class="cdh-field"><span>标题</span>
        <input class="cdh-input" data-cdh-title value="${esc(doc.content || "")}" placeholder="文档标题"></label>`,
      onSubmit: card => {
        const v = card.querySelector("[data-cdh-title]").value.trim();
        if (!v) throw Error("标题不能为空");
        title = v;
      }
    });
    if (!ok) return;
    if (title === String(doc.content || "")) return;
    await this.api("/api/filetree/renameDocByID", { id: doc.id, title });
    this.patchDocLocal(doc.id, title);
    this.navView?.render();
    showMessage("已重命名", 1800);
    await this.afterDocChange();
  }

  /** 新建子文档：父路径取该文档的 hpath（思源里文档同时是"文件夹"） */
  async newChildDoc(doc) {
    let title = "";
    const ok = await showModal({
      title: "新建子文档",
      okText: "创建",
      body: `<label class="cdh-field"><span>标题</span>
          <input class="cdh-input" data-cdh-title value="未命名" placeholder="文档标题"></label>
        <p class="cdh-modal-tip">会建在《${esc(doc.content || "")}》下面。</p>`,
      onSubmit: card => {
        title = card.querySelector("[data-cdh-title]").value.trim() || "未命名";
      }
    });
    if (!ok) return;
    // 注意：createDocWithMd 的 path 是「包含新标题的完整路径」，不是父路径；
    // 只传父路径会建出一篇和父文档同名的新文档（实测过，会造重复）。
    const parent = String(doc.hpath || "").replace(/\/+$/, "");
    const path = `${parent}/${title.replace(/\//g, "_")}`;
    const data = await this.api("/api/filetree/createDocWithMd", { notebook: doc.box, path, parentID: doc.id, title, markdown: "" });
    const id = typeof data === "string" ? data : (data?.id || data?.root_id || null);
    if (id) this.addDocLocal({ id, box: doc.box, hpath: path, content: title, updated: this.stampNow() }, doc.id);
    this.navView?.render();
    await this.afterDocChange();
    if (id) await this.openDoc(id);
  }

  /** 在某个知识库里新建文档（知识库条目 / 分组节点用） */
  async newDocIn(box, parentHpath) {
    if (!box) return;
    let title = "";
    const ok = await showModal({
      title: "新建文档",
      okText: "创建",
      body: `<label class="cdh-field"><span>标题</span>
          <input class="cdh-input" data-cdh-title value="未命名" placeholder="文档标题"></label>`,
      onSubmit: card => { title = card.querySelector("[data-cdh-title]").value.trim() || "未命名"; }
    });
    if (!ok) return;
    const parent = String(parentHpath || "/").replace(/\/+$/, "");
    const path = `${parent}/${title.replace(/\//g, "_")}`;
    const data = await this.api("/api/filetree/createDocWithMd", { notebook: box, path, title, markdown: "" });
    const id = typeof data === "string" ? data : (data?.id || data?.root_id || null);
    if (id) this.addDocLocal({ id, box, hpath: path, content: title, updated: this.stampNow() });
    this.navView?.render();
    await this.afterDocChange();
    if (id) await this.openDoc(id);
  }

  /* ---------- 文件夹 ----------
     思源本身没有"文件夹"这种对象：文档树就是文档套文档，中间层也得是文档。
     所以这里做一个「文件夹」= 打了 custom-cdh-folder 标记的空壳文档：
     · 属性写在文档 ial 里，跟着思源同步走，换设备也还在；
     · 树里显示 📁，点一下只展开/收起，不会把你的空壳文档打开；
     · 里面放子文档（右键「新建子文档」或直接拖），和真文件夹用起来一样。 */

  async newFolderIn(box, parentHpath, parentID) {
    if (!box) return;
    let title = "";
    const ok = await showModal({
      title: "新建文件夹",
      okText: "创建",
      body: `<label class="cdh-field"><span>名称</span>
          <input class="cdh-input" data-cdh-title value="新建文件夹" placeholder="文件夹名称"></label>
        <p class="cdh-modal-tip">文件夹是一篇空壳文档（思源没有独立的文件夹类型），
        里面放子文档；在树里点它只展开/收起，不会打开正文。</p>`,
      onSubmit: card => { title = card.querySelector("[data-cdh-title]").value.trim() || "新建文件夹"; }
    });
    if (!ok) return;
    const parent = String(parentHpath || "/").replace(/\/+$/, "");
    const path = `${parent}/${title.replace(/\//g, "_")}`;
    const data = await this.api("/api/filetree/createDocWithMd", { notebook: box, path, parentID, title, markdown: "" });
    const id = typeof data === "string" ? data : (data?.id || data?.root_id || null);
    if (!id) { showMessage("创建文件夹失败", 3200, "error"); return; }
    try { await this.api("/api/attr/setBlockAttrs", { id, attrs: { "custom-cdh-folder": "true" } }); }
    catch (e) { showMessage("文件夹建好了，但标记失败：" + (e?.message || e), 3600, "error"); }
    this.addDocLocal({ id, box, hpath: path, content: title, updated: this.stampNow(), ial: 'custom-cdh-folder="true"' }, parentID);
    this.navView?.render();
    showMessage(`已创建文件夹「${title}」`, 2000);
    await this.afterDocChange();
  }

  /** 把已有文档标成文件夹 / 取消标记（内容不会动） */
  async setFolderFlag(doc, on) {
    try {
      // 属性值给空字符串 = 让内核删掉这条属性
      await this.api("/api/attr/setBlockAttrs", { id: doc.id, attrs: { "custom-cdh-folder": on ? "true" : "" } });
    } catch (e) {
      showMessage("操作失败：" + (e?.message || e), 3600, "error");
      return;
    }
    const hit = (this.nav.boxDocs || []).find(r => r.id === doc.id);
    if (hit) hit.ial = on ? 'custom-cdh-folder="true"' : "";
    this.navView?.render();
    showMessage(on ? "已标记为文件夹" : "已取消文件夹标记", 1800);
    await this.afterDocChange();
  }

  async duplicateDoc(doc) {
    const data = await this.api("/api/filetree/duplicateDoc", { id: doc.id });
    const hp = String(data?.hPath || "");
    if (data?.id && hp) {
      this.addDocLocal({
        id: data.id, box: data.notebook || doc.box, hpath: hp,
        content: hp.split("/").filter(Boolean).pop() || "", updated: this.stampNow()
      });
    }
    this.navView?.render();
    showMessage("已创建副本", 1800);
    await this.afterDocChange();
  }

  async removeDoc(doc) {
    const hp = String(doc.hpath || "");
    const kids = hp ? (this.nav.boxDocs || []).filter(d => d.id !== doc.id && String(d.hpath || "").startsWith(hp + "/")).length : 0;
    const ok = await showModal({
      title: "删除文档",
      okText: "删除",
      danger: true,
      body: `<p class="cdh-modal-text">确定删除《<b>${esc(doc.content || "未命名文档")}</b>》吗？</p>
        ${kids ? `<p class="cdh-modal-warn">它下面还有 ${kids} 篇子文档，会一起删除。</p>` : ""}
        <p class="cdh-modal-tip">删除后可以在思源「数据历史」里尝试恢复。</p>`
    });
    if (!ok) return;
    try {
      await this.api("/api/filetree/removeDocByID", { id: doc.id });
    } catch (e) {
      // 删失败也要重刷，别把已经不在库里的条目继续挂在树上
      await this.afterDocChange();
      throw e;
    }
    this.dropDocLocal(doc.id, doc.box);
    if (this.docCtxId === doc.id) { this.docCtxId = null; this.docCtx = null; }
    this.navView?.render();
    showMessage("已删除", 1800);
    await this.afterDocChange();
  }

  /** 移动到别的知识库 / 别的文档下面 */
  async moveDoc(doc) {
    const nb = await this.api("/api/notebook/lsNotebooks", {});
    const boxes = (nb.notebooks || []).filter(n => !n.closed);
    if (!boxes.length) throw Error("没有打开的笔记本");
    let target = null;
    const ok = await showModal({
      title: "移动到",
      okText: "移动",
      body: `<label class="cdh-field"><span>目标知识库</span>
          <select class="cdh-input" data-cdh-box>${boxes.map(n => `<option value="${esc(n.id)}"${n.id === doc.box ? " selected" : ""}>${esc(n.name)}</option>`).join("")}</select></label>
        <label class="cdh-field"><span>放到</span>
          <select class="cdh-input" data-cdh-parent><option value="">库根目录</option></select></label>
        <p class="cdh-modal-tip">文档连同它下面的子文档一起移动。</p>`,
      onMount: card => {
        const boxSel = card.querySelector("[data-cdh-box]");
        const parSel = card.querySelector("[data-cdh-parent]");
        const fill = async () => {
          const box = boxSel.value;
          parSel.innerHTML = '<option value="">库根目录</option><option disabled>正在读取…</option>';
          try {
            const rows = (await this.fetchBoxDocs(box))
              .filter(isVisibleDoc)
              .filter(r => box !== doc.box || !this.isSelfOrDescendant(doc, r))
              .sort((a, b) => String(a.hpath || "").localeCompare(String(b.hpath || ""), "zh-CN", { numeric: true }));
            parSel.innerHTML = '<option value="">库根目录</option>' + rows.map(r => {
              const label = String(r.hpath || "").replace(/^\/+/, "") || String(r.content || "");
              return `<option value="${esc(r.id)}">${esc(label)}</option>`;
            }).join("");
          } catch (e) {
            parSel.innerHTML = '<option value="">库根目录</option>';
            showMessage("读取目录失败：" + (e?.message || e), 3000, "error");
          }
        };
        boxSel.addEventListener("change", fill);
        fill();
      },
      onSubmit: card => {
        target = { box: card.querySelector("[data-cdh-box]").value, parent: card.querySelector("[data-cdh-parent]").value };
      }
    });
    if (!ok || !target) return;
    await this.moveDocTo(doc, target.parent || target.box);
  }

  async moveDocTo(doc, toID) {
    if (toID === doc.id) throw Error("不能移动到它自己下面");
    await this.api("/api/filetree/moveDocsByID", { fromIDs: [doc.id], toID });
    this.pendingDocs.delete(doc.id);
    showMessage("已移动", 1800);
    await this.afterDocChange();
  }

  async copyMarkdown(doc) {
    const data = await this.api("/api/export/exportMdContent", { id: doc.id });
    const md = String(data?.content || "");
    if (!md.trim()) { showMessage("这篇文档还没有内容", 2200); return; }
    await copyText(md);
  }

  /** 文档右键菜单项：左侧目录树和首页「最近」共用同一套 */
  docMenuItems(doc) {
    const cfg = this.config || { pins: [] };
    const pinned = (cfg.pins || []).some(x => x.id === doc.id);
    const folder = isFolderRow(doc);
    return [
      { icon: "iconFile", label: folder ? "打开（编辑这篇文件夹）" : "打开", click: () => this.openDoc(doc.id) },
      { icon: "iconAdd", label: "新建子文档", click: () => this.newChildDoc(doc) },
      { icon: "iconFolder", label: "新建子文件夹", click: () => this.newFolderIn(doc.box, doc.hpath, doc.id) },
      { sep: true },
      { icon: "iconEdit", label: "重命名", click: () => this.renameDoc(doc) },
      { icon: "iconCopy", label: "创建副本", click: () => this.duplicateDoc(doc) },
      { icon: "iconMove", label: "移动到…", click: () => this.moveDoc(doc) },
      folder
        ? { icon: "iconFiles", label: "取消文件夹标记", click: () => this.setFolderFlag(doc, false) }
        : { icon: "iconFolder", label: "标记为文件夹", click: () => this.setFolderFlag(doc, true) },
      { sep: true },
      { icon: "iconLink", label: "复制文档引用", click: () => copyText(`((${doc.id} "${String(doc.content || "").replace(/"/g, "”")}"))`) },
      { icon: "iconTag", label: "复制文档 ID", click: () => copyText(doc.id) },
      { icon: "iconCopy", label: "复制 Markdown", click: () => this.copyMarkdown(doc) },
      { sep: true },
      { icon: "iconPin", label: pinned ? "取消置顶" : "置顶到快捷访问", click: () => this.togglePin(doc) },
      { icon: "iconTrashcan", label: "删除", danger: true, click: () => this.removeDoc(doc) }
    ];
  }

  /** 置顶 / 取消置顶到首页「快捷访问」 */  async togglePin(doc) {
    const cfg = await this.loadConfig();
    const hit = cfg.pins.find(p => p.id === doc.id);
    if (hit) {
      cfg.pins = cfg.pins.filter(p => p.id !== doc.id);
      showMessage("已取消置顶", 1800);
    } else {
      cfg.pins.push({ id: doc.id, title: String(doc.content || "") });
      showMessage("已置顶到首页「快捷访问」", 2000);
    }
    await this.saveConfig();
    this.navView?.render();
    this.syncViews();
  }

  async renameNotebook(nb) {
    const cur = String(nb.name || "");
    let name = "";
    const ok = await showModal({
      title: "重命名知识库",
      okText: "保存",
      body: `<label class="cdh-field"><span>名称</span>
        <input class="cdh-input" data-cdh-name value="${esc(cur)}"></label>`,
      onSubmit: card => {
        const v = card.querySelector("[data-cdh-name]").value.trim();
        if (!v) throw Error("名称不能为空");
        name = v;
      }
    });
    if (!ok || name === cur) return;
    await this.api("/api/notebook/renameNotebook", { notebook: nb.id, name });
    showMessage("已重命名", 1800);
    await this.afterDocChange();
  }

  async closeNotebook(nb) {
    const ok = await showModal({
      title: "关闭知识库",
      okText: "关闭",
      danger: true,
      body: `<p class="cdh-modal-text">关闭「<b>${esc(splitNotebookName(nb.name).text)}</b>」后它不会出现在云文档里。</p>
        <p class="cdh-modal-tip">数据不会删除，随时可以在思源里重新打开这个笔记本。</p>`
    });
    if (!ok) return;
    await this.api("/api/notebook/closeNotebook", { notebook: nb.id });
    if (this.nav.openBoxId === nb.id) { this.nav.openBoxId = null; this.nav.boxDocs = null; }
    showMessage("已关闭", 1800);
    await this.afterDocChange();
  }

  openCreateDialog(state, defaultBox, defaultParent) {
    const openNbs = state.notebooks.filter(n => !n.closed);
    if (!openNbs.length) { showMessage("没有打开的笔记本，请先创建或打开笔记本", 3000, "error"); return; }
    const preBox = defaultBox && openNbs.some(n => n.id === defaultBox) ? defaultBox : openNbs[0].id;
    const dialog = new Dialog({
      title: "新建文档",
      width: "480px",
      content: `<div class="b3-dialog__content" style="display:grid;gap:12px">
        <label class="ft__on-surface">标题<input class="b3-text-field" data-cdh-title placeholder="无标题" style="width:100%;margin-top:6px"></label>
        <label class="ft__on-surface">笔记本<select class="b3-select" data-cdh-box style="width:100%;margin-top:6px">${openNbs.map(n => `<option value="${esc(n.id)}"${n.id === preBox ? " selected" : ""}>${esc(n.name)}</option>`).join("")}</select></label>
        <label class="ft__on-surface">保存位置<select class="b3-select" data-cdh-parent style="width:100%;margin-top:6px"></select></label>
        <div class="ft__secondary" data-cdh-location-status></div>
      </div>
      <div class="b3-dialog__action">
        <button class="b3-button b3-button--cancel" data-cdh-cancel>取消</button>
        <button class="b3-button b3-button--text" data-cdh-create>创建</button>
      </div>`
    });
    const el = dialog.element;
    const titleInput = el.querySelector("[data-cdh-title]");
    const boxInput = el.querySelector("[data-cdh-box]");
    const parentInput = el.querySelector("[data-cdh-parent]");
    const status = el.querySelector("[data-cdh-location-status]");
    const btn = el.querySelector("[data-cdh-create]");
    let locations = [];
    let request = 0;
    const loadLocations = async (preferred = "") => {
      const pending = ++request;
      btn.disabled = parentInput.disabled = true;
      status.textContent = "正在读取保存位置…";
      try {
        const rows = await this.fetchBoxDocs(boxInput.value);
        if (pending !== request) return;
        locations = rows.filter(isVisibleDoc).sort((a, b) => String(a.hpath || "").localeCompare(String(b.hpath || ""), "zh-CN", { numeric: true }));
        parentInput.innerHTML = '<option value="">笔记本根目录</option>' + locations.map(row =>
          `<option value="${esc(row.id)}">${esc(row.hpath)}</option>`).join("");
        if (locations.some(row => row.id === preferred)) parentInput.value = preferred;
        status.textContent = "";
        btn.disabled = parentInput.disabled = false;
      } catch (e) {
        if (pending === request) status.textContent = "读取目录失败：" + (e?.message || e);
      }
    };
    boxInput.addEventListener("change", () => void loadLocations());
    void loadLocations(defaultParent ?? (preBox === this.nav.folderSelection?.box ? this.nav.folderSelection.id : ""));
    titleInput.focus();
    const close = () => dialog.destroy();
    el.querySelector("[data-cdh-cancel]").addEventListener("click", close);
    el.querySelector("[data-cdh-create]").addEventListener("click", async () => {
      btn.disabled = boxInput.disabled = parentInput.disabled = true;
      try {
        const title = titleInput.value.trim() || "无标题";
        const box = boxInput.value;
        const parent = locations.find(row => row.id === parentInput.value);
        const path = `${String(parent?.hpath || "").replace(/\/+$/, "")}/${title.replace(/\//g, "_")}`;
        const data = await this.api("/api/filetree/createDocWithMd", { notebook: box, path, parentID: parent?.id, title, markdown: "" });
        close();
        const id = typeof data === "string" ? data : (data?.id || data?.root_id || null);
        if (id) {
          this.addDocLocal({ id, box, hpath: path, content: title, updated: this.stampNow(),
            path: parent?.path ? parent.path.replace(/\.sy$/, "") + "/" + id + ".sy" : parent ? undefined : "/" + id + ".sy" }, parent?.id);
          this.navView?.render();
          this.syncViews();
        }
        if (parent && this.nav.openBoxId === box) {
          const folderPath = parent.path || parent.hpath.replace(/^\/+/, "");
          this.nav.expanded.add(folderPath);
          this.nav.closed?.delete(folderPath);
        }
        await this.afterDocChange();
        if (id) await this.openDoc(id); else showMessage("文档已创建");
      } catch (e) { btn.disabled = boxInput.disabled = parentInput.disabled = false; showMessage("创建失败：" + (e?.message || e), 4000, "error"); }
    });
  }

  openSettingsDialog() {
    const cfg = this.config || { pins: [] };
    const dlg = new Dialog({
      title: "云文档首页设置",
      width: "440px",
      content: `<div class="b3-dialog__content" style="display:grid;gap:12px">
        <label class="fn__flex" style="align-items:center;gap:8px;font-size:14px;cursor:pointer">
          <input type="checkbox" data-cdh-startup ${cfg.openOnStartup === false ? "" : "checked"}>
          <span>打开思源时自动进入「云文档」首页</span>
        </label>
        <label class="fn__flex" style="align-items:center;gap:8px;font-size:14px;cursor:pointer">
          <input type="checkbox" data-cdh-navtab ${cfg.navOnStartup === false ? "" : "checked"}>
          <span>左侧始终显示「云文档」导航（思源原生面板已停用）</span>
        </label>
        <div class="b3-label__text" style="font-size:12px;color:var(--b3-theme-on-surface-light);margin-top:-4px">
          导航常驻在左侧，切到文档标签页也在；大纲、反链都在导航底部就地展开，不会再唤起思源原生面板。关掉这一项只会停止「启动时自动切回」，原生面板的图标仍然不可用。
        </div>
      </div>
      <div class="b3-dialog__action"><button class="b3-button b3-button--text" data-cdh-done>完成</button></div>`
    });
    const el = dlg.element;
    el.querySelector("[data-cdh-done]").addEventListener("click", async () => {
      const on = !!el.querySelector("[data-cdh-startup]").checked;
      const navTab = !!el.querySelector("[data-cdh-navtab]").checked;
      const c = await this.loadConfig();
      c.openOnStartup = on;
      c.navOnStartup = navTab;
      await this.saveConfig().catch(() => { });
      if (navTab) this.showNav();
      showMessage(on ? "已开启：打开思源自动进入云文档首页" : "已关闭：打开思源时不再自动跳转", 2500);
      dlg.destroy();
    });
  }
}

/* ---------- 常驻导航（渲染进 Dock 面板，切标签页不消失） ----------
   放在 Dock 而不是标签页里，是因为标签页一切走就整块隐藏；
   Dock 面板是思源唯一能跨标签页常驻的挂载点，文档页左侧因此也能保持云文档导航。 */
class NavView {
  constructor(element, plugin) {
    this.el = element;
    this.plugin = plugin;
    this.state = null;
    this.disposed = false;
    this.el.classList.add("cdh-nav-root");
    this.handleClick = event => {
      const el = event.target instanceof Element ? event.target.closest("[data-act]") : null;
      if (!el || !this.el.contains(el)) return;
      event.preventDefault();
      this.run(() => this.onAction(el.dataset.act, el.dataset.id, el));
    };
    this.el.addEventListener("click", this.handleClick);
    // 右键：文档 / 目录 / 知识库 / 冲突副本各有各的菜单
    this.handleContext = event => {
      const t = event.target instanceof Element ? event.target.closest("[data-menu]") : null;
      if (!t || !this.el.contains(t)) return;
      event.preventDefault();
      event.stopPropagation();
      this.menuFor(t, null, { x: event.clientX, y: event.clientY });
    };
    this.el.addEventListener("contextmenu", this.handleContext);
    this.el.addEventListener("dragstart", this.startDocDrag);
    this.el.addEventListener("dragover", this.overDocDrop);
    this.el.addEventListener("dragleave", this.leaveDocDrop);
    this.el.addEventListener("drop", this.dropDoc);
    this.el.addEventListener("dragend", this.endDocDrag);
    this.refresh();
  }

  dispose() {
    this.disposed = true;
    CdMenu.close();
    this.el.removeEventListener("click", this.handleClick);
    this.el.removeEventListener("contextmenu", this.handleContext);
    this.el.removeEventListener("dragstart", this.startDocDrag);
    this.el.removeEventListener("dragover", this.overDocDrop);
    this.el.removeEventListener("dragleave", this.leaveDocDrop);
    this.el.removeEventListener("drop", this.dropDoc);
    this.el.removeEventListener("dragend", this.endDocDrag);
    this.endDocDrag();
    this.el.innerHTML = "";
  }

  run(fn) { Promise.resolve().then(fn).catch(e => showMessage(e?.message || e, 4000, "error")); }

  startDocDrag = event => {
    const row = event.target.closest?.('.cdh-tree-row[draggable="true"], .cdh-side-item[data-menu="box"]');
    if (row?.dataset.menu === "box" && event.dataTransfer && !this.movingDoc) {
      this.draggedDoc = { id: row.dataset.box, notebook: true };
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/x-cloud-docs-home-document", row.dataset.box);
      return;
    }
    const doc = this.plugin.nav.boxDocs?.find(item => item.id === row?.dataset.id);
    if (!doc || !event.dataTransfer || this.movingDoc) return;
    this.draggedDoc = doc;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-cloud-docs-home-document", doc.id);
  };

  docDropTarget(event) {
    if (!this.draggedDoc || !Array.from(event.dataTransfer?.types || []).includes("application/x-cloud-docs-home-document")) return null;
    if (this.draggedDoc.notebook) {
      const scroll = event.target.closest?.(".cdh-side-scroll");
      if (scroll && this.el.contains(scroll)) {
        const rows = [...scroll.querySelectorAll('.cdh-side-item[data-menu="box"]')]
          .filter(item => item.dataset.box !== this.draggedDoc.id);
        const row = rows.find(item => {
          const rect = item.getBoundingClientRect();
          return event.clientY < rect.top + rect.height / 2;
        }) || rows.at(-1);
        if (!row) return null;
        const rect = row.getBoundingClientRect();
        return { row, id: row.dataset.box, order: event.clientY < rect.top + rect.height / 2 ? "before" : "after" };
      }
    }
    const row = event.target.closest?.('.cdh-tree-row[data-menu="doc"], .cdh-side-item[data-menu="box"]');
    if (!row || !this.el.contains(row)) return null;
    if (row.dataset.menu === "box") {
      if (!this.draggedDoc.notebook) return { row, id: row.dataset.box };
      if (row.dataset.box === this.draggedDoc.id) return null;
      const rect = row.getBoundingClientRect();
      return { row, id: row.dataset.box, order: event.clientY >= rect.top + rect.height / 2 ? "after" : "before" };
    }
    if (this.draggedDoc.notebook) return null;
    const doc = this.plugin.nav.boxDocs?.find(item => item.id === row.dataset.id);
    if (!doc || this.plugin.isSelfOrDescendant(this.draggedDoc, doc)) return null;
    const parent = item => String(item.path || "").slice(0, String(item.path || "").lastIndexOf("/"));
    if (doc.box === this.draggedDoc.box && parent(doc) === parent(this.draggedDoc) && row.getBoundingClientRect) {
      const rect = row.getBoundingClientRect();
      const offset = event.clientY - rect.top;
      if (offset < rect.height * 0.3 || offset > rect.height * 0.7) {
        return { row, id: doc.id, order: offset < rect.height / 2 ? "before" : "after" };
      }
    }
    return { row, id: doc.id };
  }

  highlightDocDrop(row) {
    if (this.dropRow === row) return;
    this.dropRow?.classList.remove("cdh-drop-target", "cdh-drop-before", "cdh-drop-after");
    this.dropRow = row;
    row?.classList.add("cdh-drop-target");
  }

  overDocDrop = event => {
    const target = this.docDropTarget(event);
    this.highlightDocDrop(target?.row);
    target?.row.classList.toggle?.("cdh-drop-before", target.order === "before");
    target?.row.classList.toggle?.("cdh-drop-after", target.order === "after");
    target?.row.classList.toggle?.("cdh-drop-target", !target.order);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  leaveDocDrop = event => {
    if (!this.dropRow?.contains(event.relatedTarget)) this.highlightDocDrop();
  };

  endDocDrag = () => {
    this.highlightDocDrop();
    this.draggedDoc = null;
  };

  dropDoc = event => {
    const target = this.docDropTarget(event);
    const doc = this.draggedDoc;
    this.endDocDrag();
    if (!target || event.dataTransfer.getData("application/x-cloud-docs-home-document") !== doc.id) return;
    event.preventDefault();
    event.stopPropagation();
    this.movingDoc = true;
    this.run(async () => {
      try {
        if (target.order) {
          const parent = item => String(item.path || "").slice(0, String(item.path || "").lastIndexOf("/"));
          const siblings = doc.notebook
            ? [...(this.state?.openNotebooks || [])].sort((a, b) => this.plugin.manualOrder(a.id, b.id)).map(item => item.id)
            : (this.plugin.nav.boxDocs || []).filter(item => item.box === doc.box && parent(item) === parent(doc))
                .sort((a, b) => (this.plugin.nav.sortMode === "manual" ? this.plugin.manualOrder(a.id, b.id) : 0) ||
                  (this.plugin.nav.sortMode === "time" ? String(b.updated || "").localeCompare(String(a.updated || "")) : 0) ||
                  String(a.content || "").localeCompare(String(b.content || ""), "zh-CN", { numeric: true }))
                .map(item => item.id);
          await this.plugin.reorderNavigation(doc.id, target.id, target.order === "after", siblings, !doc.notebook);
        } else {
          await this.plugin.moveDocTo(doc, target.id);
        }
      }
      finally { this.movingDoc = false; }
    });
  };

  async refresh() {
    try { this.state = await this.plugin.fetchNavState(); }
    catch (e) {
      this.el.innerHTML = `<div class="cdh-side-tip cdh-error">导航加载失败：${esc(e?.message || e)}</div>`;
      return;
    }
    this.render();
  }

  render() {
    if (!this.state || this.disposed) return;
    CdMenu.close();
    const scroll = this.el.querySelector(".cdh-side-scroll");
    const prev = scroll ? scroll.scrollTop : 0;
    this.el.innerHTML = this.sideHTML();
    const next = this.el.querySelector(".cdh-side-scroll");
    if (next) next.scrollTop = prev;
    if (this.revealId && this.revealId !== this.plugin.docCtxId) this.revealId = null;
    if (this.revealId) {
      const row = next?.querySelector(".cdh-tree-row.is-current");
      if (row?.dataset.id === this.revealId) {
        row.scrollIntoView({ block: "nearest", inline: "nearest" });
        this.revealId = null;
      }
    }
  }

  revealDoc(id) {
    for (const path of this.currentTrail()) this.plugin.nav.closed.delete(path);
    this.revealId = id;
    this.render();
  }

  sideHTML() {
    const s = this.state;
    const nav = this.plugin.nav;
    return `
      <div class="cdh-side cdh-side--dock">
        <div class="cdh-side-head">
          <span class="cdh-side-logo">${uiIcon("book")}</span><b>云文档</b>
        </div>
        <div class="cdh-side-scroll">
          <button class="cdh-side-item${nav.openBoxId ? "" : " is-on"}" data-act="home">
            <span class="cdh-side-ico">${uiIcon("home")}</span><span class="cdh-side-name">首页</span>
          </button>
          <div class="cdh-side-label">知识库</div>
          ${[...s.openNotebooks].sort((a, b) => this.plugin.manualOrder(a.id, b.id)).map(n => {
            const { emoji, text } = splitNotebookName(n.name);
            const on = nav.openBoxId === n.id;
            return `
            <button class="cdh-side-item${on ? " is-on" : ""}" draggable="true" data-act="openBox" data-box="${esc(n.id)}" data-menu="box"
                    title="${esc(text)}${on ? " · 再点一次收起" : ""}" aria-expanded="${on ? "true" : "false"}">
              <span class="cdh-side-chevron${on ? " is-open" : ""}">${uiIcon("chevron")}</span><span class="cdh-side-dot">${uiIcon("book")}</span>
              <span class="cdh-side-name">${esc(text)}</span>
              <small>${s.countMap[n.id] || 0}</small>
            </button>
            ${on ? `<div class="cdh-side-tree">${this.sideTreeHTML()}</div>` : ""}`;
          }).join("") || '<div class="cdh-side-empty">还没有打开的笔记本</div>'}
        </div>
        <div class="cdh-side-foot">
          ${this.docBoxHTML()}
          <button class="cdh-side-item" data-act="settings"><span class="cdh-side-ico">⚙</span><span class="cdh-side-name">云文档设置</span></button>
        </div>
      </div>`;
  }

  /** 当前文档的大纲 / 反链：都在导航里，不再唤起任何原生面板 */
  docBoxHTML() {
    const ctx = this.plugin.docCtx;
    if (!ctx) return "";
    const mode = this.plugin.nav.docTab || "";
    const ol = ctx.outline, bl = ctx.backlinks;
    const nOl = ol ? ol.length : "";
    const nBl = bl ? bl.length : "";
    let body = "";
    if (mode === "outline") {
      body = ol === null
        ? `<div class="cdh-side-tip">正在读取大纲…</div>`
        : ol.length
          ? ol.map(h => `
            <button class="cdh-ol-row" data-act="jump" data-id="${esc(h.id)}"
                    style="--depth:${Math.min(h.depth, 4)}" title="${esc(h.name)}">
              <span class="cdh-ol-h">${esc(h.sub.toUpperCase())}</span><span class="cdh-ol-name">${esc(h.name)}</span>
            </button>`).join("")
          : `<div class="cdh-side-tip">这篇文档还没有标题</div>`;
    } else if (mode === "backlink") {
      body = bl === null
        ? `<div class="cdh-side-tip">正在读取反链…</div>`
        : bl.length
          ? bl.map(b => `
            <button class="cdh-bl-row" data-act="gotoRef" data-id="${esc(b.docId)}" data-block="${esc(b.id)}" title="${esc(b.doc)}｜${esc(b.snip)}">
              <span class="cdh-bl-doc">${esc(b.doc)}</span>
              <span class="cdh-bl-snip">${esc(b.snip || "（无文字内容）")}</span>
            </button>`).join("")
          : `<div class="cdh-side-tip">还没有文档链接到这篇文档</div>`;
    }
    return `
      <div class="cdh-docbox">
        <div class="cdh-docbox-head" title="${esc(ctx.title || "当前文档")}">📄<b>${esc(ctx.title || "当前文档")}</b></div>
        <div class="cdh-docbox-tabs">
          <button class="cdh-docbox-tab${mode === "outline" ? " is-on" : ""}" data-act="docTab" data-mode="outline">大纲${nOl === "" ? "" : " " + nOl}</button>
          <button class="cdh-docbox-tab${mode === "backlink" ? " is-on" : ""}" data-act="docTab" data-mode="backlink">反链${nBl === "" ? "" : " " + nBl}</button>
        </div>
        ${body ? `<div class="cdh-docbox-body">${body}</div>` : ""}
      </div>`;
  }

  /** 左侧栏里的目录树（只显示当前库） */
  sideTreeHTML() {
    const nav = this.plugin.nav;
    if (nav.boxError) return `<div class="cdh-side-tip cdh-error">读取失败</div>`;
    if (!nav.boxDocs) return `<div class="cdh-side-tip">正在读取…</div>`;
    const docs = (nav.boxDocs || []).filter(isVisibleDoc);
    const conflicts = (nav.boxDocs || []).filter(isConflictDoc);
    let html = "";
    // 冲突入口放树顶：库很大时它要滚到底才看得见，等于藏起来
    if (conflicts.length) {
      html += `
        <button class="cdh-side-conflicts${nav.showConflicts ? " is-open" : ""}" data-act="conflicts" title="思源同步时生成的冲突副本，平时折叠不显示">
          <span class="cdh-side-conflicts-ico">⚠</span>
          <span class="cdh-side-conflicts-text">${conflicts.length} 个同步冲突副本</span>
          <span class="cdh-side-conflicts-arrow">${nav.showConflicts ? "▾" : "▸"}</span>
        </button>`;
      if (nav.showConflicts) {
        html += `<div class="cdh-side-conflict-list">${conflicts.map(d => `
          <button class="cdh-conflict-row" data-act="open" data-id="${esc(d.id)}" data-menu="conflict" title="${esc(d.content)}">
            <span class="cdh-conflict-ico">📄</span>
            <span class="cdh-conflict-name">${esc(conflictLabel(d.content))}</span>
          </button>`).join("")}</div>`;
      }
    }
    html += docs.length
      ? this.renderTree(this.buildTree(docs))
      : `<div class="cdh-side-tip">这个库还没有正文文档</div>`;
    return html;
  }

  /** 当前文档在树里的祖先链：用来定位，自动展开但不写进用户的展开状态 */
  currentTrail() {
    const trail = new Set();
    const cur = (this.plugin.nav.boxDocs || []).find(r => r.id === this.plugin.docCtxId);
    if (!cur?.hpath) return trail;
    if (cur.path) {
      const parts = cur.path.split("/").filter(Boolean);
      let parentPath = "";
      for (const part of parts.slice(0, -1)) {
        parentPath += "/" + part;
        trail.add(parentPath + ".sy");
      }
      return trail;
    }
    const parts = String(cur.hpath).split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? acc + "/" + parts[i] : parts[i];
      trail.add(acc);
    }
    return trail;
  }

  /** 节点是否展开：用户点开过 → 展开；用户点收过 → 收起；
   *  都没动过就按默认（全折叠），只把「当前文档所在的那条路径」自动展开，方便定位。 */
  isOpen(path, depth, trail) {
    const { expanded, closed } = this.plugin.nav;
    if (expanded.has(path)) return true;
    if (closed && closed.has(path)) return false;
    return trail.has(path);
  }

  renderTree(tree) {
    const nav = this.plugin.nav;
    const trail = this.currentTrail();
    const cmp = (a, b) => {
      const manual = nav.sortMode === "manual" ? this.plugin.manualOrder(a.doc?.id, b.doc?.id) : 0;
      if (manual) return manual;
      if (nav.sortMode === "time") {
        const ta = a.doc?.updated || "", tb = b.doc?.updated || "";
        if (ta !== tb) return tb.localeCompare(ta);
      }
      return a.name.localeCompare(b.name, "zh-CN", { numeric: true });
    };
    const out = [];
    const walk = (node, depth) => {
      for (const k of [...node.children.values()].sort(cmp)) {
        const hasKids = k.children.size > 0;
        const isDoc = !!k.doc;
        const isFolder = !isDoc || k.folder;
        const open = hasKids && this.isOpen(k.path, depth, trail);
        const fileKind = isDoc && !isFolder ? suiteFileKind(k.doc) : null;
        const fileLabel = suiteFileLabels.get(fileKind);
        const iconKind = isFolder ? "folder" : fileKind === "xmind" ? "mindmap" : fileLabel ? fileKind : "file";
        // 每一行都带 data-menu：右键和 hover 出来的「⋯」用的是同一套菜单
        const menuAttrs = isDoc
          ? `data-menu="doc" data-id="${esc(k.doc.id)}" data-box="${esc(k.doc.box)}"`
          : `data-menu="group" data-box="${esc(nav.openBoxId || "")}" data-hpath="${esc(k.path)}"`;
        // 文件夹点一下是展开/收起（它本身是空壳文档，没什么可看的），要看内容用右键「打开」
        const action = isFolder
          ? (hasKids ? `data-act="toggle" data-path="${esc(k.path)}"` : `data-act="folderEmpty"`)
          : (isDoc ? `data-act="open" data-id="${esc(k.doc.id)}"` : (hasKids ? `data-act="toggle" data-path="${esc(k.path)}"` : ""));
        const hint = isFolder ? " · 文件夹" : ` · ${fileLabel || "文档"} · 更新于 ${esc(relTime(k.doc.updated))}`;
        out.push(`
          <div class="cdh-tree-row${isDoc ? "" : " cdh-tree-group"}${isFolder ? " is-folder" : ""}${isDoc && k.doc.id === this.plugin.docCtxId ? " is-current" : ""}" style="--depth:${depth}"
               ${isDoc ? 'draggable="true"' : ""}
               ${menuAttrs}
               ${action}
               title="${esc(prettyDocName(k.name))}${hint}">
            ${hasKids ? `<button type="button" class="cdh-tree-toggle" data-act="toggle" data-path="${esc(k.path)}" aria-expanded="${open}" aria-label="${open ? "收起" : "展开"} ${esc(prettyDocName(k.name))}">${uiIcon("chevron")}</button>` : '<span class="cdh-tree-toggle is-empty" aria-hidden="true"></span>'}
            <span class="cdh-tree-icon${fileLabel ? ` cdh-file-${iconKind}` : ""}">${uiIcon(iconKind)}</span>
            <span class="cdh-tree-name">${esc(prettyDocName(k.name))}</span>
            ${isDoc ? `<time>${esc(relTime(k.doc.updated))}</time>` : `<small>${k.children.size} 项</small>`}
            <span class="cdh-tree-more" data-act="menu" ${menuAttrs} title="更多操作">⋯</span>
          </div>`);
        if (hasKids && open) walk(k, depth + 1);
      }
    };
    walk(tree, 0);
    return out.join("");
  }

  /** 把 hpath（形如 /A/B/C）拼成层级树；思源里中间层通常也是文档，故节点可能自带 doc */  buildTree(rows) {
    const root = { name: "", path: "", children: new Map(), doc: null };
    if (rows.length && rows.every(row => typeof row.path === "string" && row.path.endsWith(".sy"))) {
      const nodes = new Map(rows.map(row => [row.path, {
        name: String(row.content || row.hpath?.split("/").at(-1) || "未命名文档"),
        path: row.path, children: new Map(), doc: row, folder: isFolderRow(row)
      }]));
      for (const node of nodes.values()) {
        const slash = node.path.lastIndexOf("/");
        const parent = slash > 0 ? nodes.get(node.path.slice(0, slash) + ".sy") : null;
        (parent || root).children.set(node.doc.id, node);
      }
      return root;
    }
    for (const r of rows) {
      const hp = String(r.hpath || "").replace(/^\/+|\/+$/g, "");
      const parts = hp ? hp.split("/").filter(Boolean) : [];
      if (!parts.length) {
        const key = "\u0000" + r.id;
        root.children.set(key, { name: String(r.content || "未命名文档"), path: key, children: new Map(), doc: r });
        continue;
      }
      let node = root, acc = "";
      for (const part of parts) {
        acc = acc ? acc + "/" + part : part;
        let child = node.children.get(part);
        if (!child) { child = { name: part, path: acc, children: new Map(), doc: null }; node.children.set(part, child); }
        node = child;
      }
      node.doc = r;
      node.folder = isFolderRow(r);
      if (!node.name) node.name = String(r.content || parts[parts.length - 1]);
    }
    return root;
  }

  /* ---------- 右键菜单（原生文档树同款能力） ---------- */

  docMenuItems(doc) { return this.plugin.docMenuItems(doc); }

  boxMenuItems(nb) {
    const p = this.plugin;
    const on = p.nav.openBoxId === nb.id;
    return [
      { icon: on ? "iconDown" : "iconForward", label: on ? "收起目录" : "展开目录", click: () => on ? p.goHome() : p.goBox(nb.id) },
      ...(on && p.nav.boxDocs?.length ? [
        { icon: "iconDown", label: "全部展开", click: () => this.onAction("expandAll") },
        { icon: "iconForward", label: "全部收起", click: () => this.onAction("collapseAll") }
      ] : []),
      { icon: "iconAdd", label: "新建文档", click: () => p.newDocIn(nb.id, "/") },
      { icon: "iconFolder", label: "新建文件夹", click: () => p.newFolderIn(nb.id, "/") },
      { icon: "iconRefresh", label: "刷新目录", click: () => p.goBox(nb.id, { force: true }) },
      { sep: true },
      { icon: "iconEdit", label: "重命名知识库", click: () => p.renameNotebook(nb) },
      { icon: "iconClose", label: "关闭知识库", danger: true, click: () => p.closeNotebook(nb) }
    ];
  }

  groupMenuItems(box, hpath) {
    const p = this.plugin;
    const nav = p.nav;
    const closed = !nav.expanded.has(hpath);
    return [
      { icon: "iconAdd", label: "新建子文档", click: () => p.newDocIn(box, "/" + hpath) },
      { icon: "iconFolder", label: "新建子文件夹", click: () => p.newFolderIn(box, "/" + hpath) },
      { icon: closed ? "iconForward" : "iconDown", label: closed ? "展开" : "折叠", click: () => { p.toggleNode(hpath); this.render(); } }
    ];
  }

  conflictMenuItems(doc) {
    const p = this.plugin;
    return [
      { icon: "iconFile", label: "打开（只看看内容）", click: () => p.openDoc(doc.id) },
      { icon: "iconTag", label: "复制文档 ID", click: () => copyText(doc.id) },
      { sep: true },
      { icon: "iconTrashcan", label: "删除这个冲突副本", danger: true, click: () => p.removeDoc(doc) }
    ];
  }

  /** 根据点到的元素（带 data-menu）弹出对应菜单 */
  menuFor(target, anchor, point) {
    const p = this.plugin, nav = p.nav;
    const kind = target?.dataset?.menu || "";
    const id = target?.dataset?.id || "";
    let items = null, tree = null;
    if (kind === "doc" || kind === "conflict") {
      const doc = (nav.boxDocs || []).find(d => d.id === id);
      if (!doc) return;
      items = kind === "doc" ? this.docMenuItems(doc) : this.conflictMenuItems(doc);
      // 文档：让第三方插件（云文档套件等）注入自己的项
      if (kind === "doc") tree = { type: "doc", id: doc.id, hpath: doc.hpath, notebookId: doc.box, elements: [target] };
    } else if (kind === "box") {
      const nb = (this.state?.notebooks || []).find(n => n.id === (target.dataset.box || ""));
      if (!nb) return;
      items = this.boxMenuItems(nb);
      // 知识库：同理，注入进去的「新建脑图」会落在库根
      tree = { type: "notebook", id: nb.id, elements: [target] };
    } else if (kind === "group") {
      items = this.groupMenuItems(target.dataset.box || nav.openBoxId, target.dataset.hpath || "");
    }
    if (items) CdMenu.open(items, { ...(anchor ? { anchor } : { x: point?.x ?? 0, y: point?.y ?? 0 }), emitter: p, tree });
  }

  async onAction(act, id, el) {
    const plugin = this.plugin, nav = plugin.nav;
    const folder = el?.closest(".cdh-tree-row.is-folder[data-id]");
    if (folder && (act === "toggle" || act === "folderEmpty")) {
      nav.folderSelection = { id: folder.dataset.id, box: folder.dataset.box };
    }
    if (act === "home") return plugin.goHome();
    if (act === "openBox") {
      const box = el?.dataset.box || "";
      if (!box) return;
      return box === nav.openBoxId ? plugin.goHome() : plugin.goBox(box);
    }
    if (act === "toggle") {
      const p = el?.dataset.path;
      if (!p) return;
      plugin.toggleNode(p);
      return this.render();
    }
    if (act === "folderEmpty") {
      showMessage("这个文件夹还是空的：右键它 → 新建子文档", 2600);
      return;
    }
    if (act === "conflicts") { nav.showConflicts = !nav.showConflicts; return this.render(); }
    if (act === "expandAll" || act === "collapseAll") {
      const all = new Set();
      const collect = node => {
        for (const child of node.children.values()) {
          if (child.children.size) all.add(child.path);
          collect(child);
        }
      };
      collect(this.buildTree(nav.boxDocs || []));
      if (act === "expandAll") { nav.expanded = all; nav.closed = new Set(); }
      else { nav.expanded = new Set(); nav.closed = all; }
      plugin.saveExpanded();
      return this.render();
    }
    if (act === "sort") return plugin.setSortMode(el.dataset.mode);
    if (act === "open" && id) return plugin.openDoc(id);
    if (act === "menu") {
      // 延到本次 click 处理完之后再开：思源在 document 上挂了「点任何地方关菜单」，
      // 同步开出来的菜单会被这次点击自己关掉（右键没有 click 事件，所以只有这里要延）。
      const anchor = el;
      setTimeout(() => this.menuFor(anchor, anchor), 0);
      return;
    }
    if (act === "settings") return plugin.openSettingsDialog();
    if (act === "docTab") {
      const mode = el?.dataset.mode || "outline";
      nav.docTab = nav.docTab === mode ? "" : mode;
      return this.render();
    }
    if (act === "jump" && id) return plugin.scrollToBlock(id);
    if (act === "gotoRef" && id) return plugin.openDocAt(id, el?.dataset.block);
  }
}

/* ---------- 首页视图（纯 DOM，无框架） ---------- */
class HomeView {
  constructor(root, plugin) {
    this.root = root; this.plugin = plugin;
    this.state = null; this.searchTimer = null; this.searchVersion = 0; this.disposed = false;
    root.classList.add("cdh-root");
    this.handleClick = e => {
      const el = e.target.closest("[data-act]"); if (!el || !root.contains(el)) return;
      this.run(() => this.onAction(el.dataset.act, el.dataset.id, el));
    };
    root.addEventListener("click", this.handleClick);
    this.handleInput = e => {
      if (e.target.matches?.("[data-cdh-search]")) {
        this.hideSearch();
        const query = e.target.value.trim();
        if (query) this.searchTimer = setTimeout(() => this.doSearch(query), 250);
      }
    };
    root.addEventListener("input", this.handleInput);
    root.addEventListener("contextmenu", this.handleContext = e => {
      const t = e.target instanceof Element ? e.target.closest("[data-menu]") : null;
      if (!t || !root.contains(t)) return;
      e.preventDefault(); e.stopPropagation();
      const id = t.dataset.id;
      const doc = (this.state?.rows || []).find(x => x.id === id)
        || (this.plugin.nav.boxDocs || []).find(x => x.id === id)
        || (id ? { id, box: t.dataset.box || "", hpath: t.dataset.hpath || "", content: t.dataset.title || "" } : null);
      if (!doc) return;
      CdMenu.open(this.plugin.docMenuItems(doc), {
        x: e.clientX, y: e.clientY, emitter: this.plugin,
        tree: { type: "doc", id: doc.id, hpath: doc.hpath, notebookId: doc.box, elements: [t] }
      });
    });
    this.handleSearchKey = e => {
      if (!e.target.matches?.("[data-cdh-search]") || e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape" && e.target.value) {
        e.preventDefault(); e.stopPropagation();
        e.target.value = ""; this.hideSearch();
        return;
      }
      const results = Array.from(root.querySelectorAll(".cdh-search-result[data-id]"));
      if (!results.length) return;
      const current = results.findIndex(row => row.classList.contains("is-selected"));
      if (e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        results[Math.max(0, current)].click();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopPropagation();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = current < 0 ? (delta > 0 ? 0 : results.length - 1) : (current + delta + results.length) % results.length;
        results.forEach((row, index) => {
          row.classList.toggle("is-selected", index === next);
          row.setAttribute("aria-selected", String(index === next));
        });
        results[next].scrollIntoView({ block: "nearest" });
      }
    };
    root.addEventListener("keydown", this.handleSearchKey);
    this.refresh();
  }
  dispose() {
    this.plugin?.trace?.("view dispose (root isConnected=" + this.root.isConnected + ")");
    this.disposed = true; clearTimeout(this.searchTimer);
    this.root.removeEventListener("click", this.handleClick);
    this.root.removeEventListener("input", this.handleInput);
    this.root.removeEventListener("keydown", this.handleSearchKey);
    if (this.handleContext) this.root.removeEventListener("contextmenu", this.handleContext);
    CdMenu.close();
    this.root.innerHTML = "";
  }
  run(fn) { fn().catch(e => showMessage(e?.message || e, 4000, "error")); }
  async refresh() {
    this.root.innerHTML = '<div class="cdh-loading">正在加载…</div>';
    await this.reload(true);
  }
  hideSearch() {
    clearTimeout(this.searchTimer);
    this.searchVersion++;
    const box = this.root.querySelector(".cdh-search-box");
    if (!box) return;
    box.classList.remove("cdh-search-open");
    box.querySelector(".cdh-search-results").replaceChildren();
  }

  /** 数据变了但不想闪"正在加载"：静默重拉，保持滚动位置 */
  async reload(showError = false) {
    const request = this.stateRequest = (this.stateRequest || 0) + 1;
    const current = () => !this.disposed && this.stateRequest === request;
    try {
      const state = await this.plugin.fetchState();
      if (!current()) return;
      this.state = state;
    } catch (error) {
      if (showError && current()) this.root.innerHTML = `<div class="cdh-loading cdh-error">${esc(error?.message || error)}</div>`;
      return;
    }
    this.render();
  }

  async doSearch(q) {
    const results = this.root.querySelector(".cdh-search-results");
    if (!results || !q) return;
    const version = ++this.searchVersion;
    const isCurrent = () => !this.disposed && version === this.searchVersion &&
      this.root.querySelector(".cdh-search-results") === results &&
      this.root.querySelector("[data-cdh-search]")?.value.trim() === q;
    try {
      const rows = await this.plugin.searchDocs(q);
      if (!isCurrent()) return;
      results.parentElement.classList.add("cdh-search-open");
      results.innerHTML = rows.length
        ? rows.map(r => `<div class="cdh-search-result" role="option" aria-selected="false" data-act="open" data-id="${esc(r.id)}" data-menu="doc"
            data-box="${esc(r.box)}" data-hpath="${esc(r.hpath || "")}" data-title="${esc(r.content)}"><span class="cdh-row-icon">${uiIcon("file")}</span><div><b>${esc(prettyDocName(r.content))}</b><small>${esc(this.state.boxName[r.box] || "")}${esc(r.hpath || "")}</small></div></div>`).join("")
        : '<div class="cdh-search-empty">没有匹配的文档标题</div>';
    } catch {
      if (!isCurrent()) return;
      results.parentElement.classList.add("cdh-search-open");
      results.innerHTML = '<div class="cdh-search-empty" role="status">搜索失败，请重新输入</div>';
    }
  }

  render(keepScroll = true) {
    const s = this.state; if (!s || this.disposed) return;
    const nav = this.plugin.nav;
    if (nav.openBoxId && !s.notebooks.some(n => n.id === nav.openBoxId)) nav.openBoxId = null;
    if (this.browseBox !== nav.openBoxId) {
      this.browseBox = nav.openBoxId;
      this.browseParent = "";
    }
    const prev = keepScroll ? (this.root.querySelector(".cdh-pane")?.scrollTop || 0) : 0;
    // 导航常驻在 Dock 里，标签页内只剩内容区，整块宽度都留给内容
    this.root.innerHTML = `
      <div class="cdh-shell cdh-shell--single">
        <section class="cdh-pane">${nav.openBoxId ? this.boxPaneHTML() : this.homePaneHTML()}</section>
      </div>`;
    const pane = this.root.querySelector(".cdh-pane");
    if (pane) pane.scrollTop = prev;
  }

  homePaneHTML() {
    const s = this.state;
    const pinned = s.config.pins.filter(p => p.id && p.title);
    return `
      <header class="cdh-banner cdh-banner--home">
        <div class="cdh-box-banner-content">
        <div class="cdh-banner-top">
          <div class="cdh-home-title">
            <span class="cdh-box-cover">${uiIcon("book")}</span>
            <div class="cdh-greet"><h1>知识库</h1><p>${s.openNotebooks.length} 个知识库 · ${s.totalDocs} 篇文档</p></div>
          </div>
          <div class="cdh-banner-actions">
            <button class="cdh-gear" data-act="settings" aria-label="首页设置" title="首页设置">⚙</button>
            <button class="cdh-new" data-act="create">＋ 新建</button>
          </div>
        </div>
        <div class="cdh-search-box">
          <span class="cdh-search-icon">${uiIcon("search")}</span>
          <input data-cdh-search aria-label="搜索文档标题" placeholder="搜索文档标题…" autocomplete="off">
          <div class="cdh-search-results" role="listbox" aria-label="搜索结果"></div>
        </div>
        </div>
      </header>
      <main class="cdh-main cdh-home-main">
        ${pinned.length ? `<section class="cdh-section">
          <div class="cdh-section-head"><h2>快捷访问</h2></div>
          <div class="cdh-pins">
            ${pinned.map(p => `
              <div class="cdh-pin" data-act="open" data-id="${esc(p.id)}" >
                <span class="cdh-pin-emoji">${uiIcon("pin")}</span>
                <div class="cdh-pin-text"><b>${esc(p.title)}</b></div>
                <button class="cdh-pin-remove" data-act="unpin" data-id="${esc(p.id)}" title="移除">✕</button>
              </div>`).join("")}
          </div>
        </section>` : ""}
        <section class="cdh-section">
          <div class="cdh-section-head"><h2>我的知识库</h2><button class="cdh-refresh" data-act="refresh" title="刷新">⟳</button></div>
          <div class="cdh-grid">
            ${[...s.openNotebooks].sort((a, b) => this.plugin.manualOrder(a.id, b.id)).map(n => this.notebookCard(n)).join("") || '<div class="cdh-hint">还没有打开的笔记本</div>'}
          </div>
          ${s.closedCount ? `<div class="cdh-closed-hint">另有 ${s.closedCount} 个已关闭的笔记本未显示</div>` : ""}
        </section>
        <section class="cdh-section">
          <div class="cdh-section-head"><h2>最近</h2></div>
          <div class="cdh-recent">
            ${s.recent.map(r => `
              <div class="cdh-recent-row" data-act="open" data-id="${esc(r.id)}" data-menu="doc"
                   data-box="${esc(r.box)}" data-hpath="${esc(r.hpath || "")}" data-title="${esc(r.content)}">
                <span class="cdh-row-icon">${uiIcon("file")}</span>
                <div class="cdh-recent-text"><b>${esc(prettyDocName(r.content))}</b><small>${esc(s.boxName[r.box] || "")}${r.hpath ? " · " + esc(String(r.hpath).replace(/^\/+/, "")) : ""}</small></div>
                <time>${esc(relTime(r.updated))}</time>
                <button class="cdh-pin-add" data-act="pin" data-id="${esc(r.id)}" data-title="${esc(r.content)}" title="置顶">📌</button>
              </div>`).join("") || '<div class="cdh-hint">还没有文档，点右上角「新建」开始</div>'}
          </div>
        </section>
      </main>`;
  }

  notebookCard(n) {
    const s = this.state;
    const newest = s.newestByBox[n.id];
    const count = s.countMap[n.id] || 0;
    const { emoji, text } = splitNotebookName(n.name);
    const meta = `${count} 篇文档${newest ? " · 更新于 " + relTime(newest.updated) : ""}`;
    return `
      <button type="button" class="cdh-card" draggable="true" data-act="openBox" data-box="${esc(n.id)}" title="查看「${esc(text)}」的目录">
        <span class="cdh-cover" aria-hidden="true">${emoji ? esc(emoji) : uiIcon("book")}</span>
        <span class="cdh-card-body">
          <b>${esc(text)}</b>
          <small>${esc(meta)}</small>
        </span>
        <span class="cdh-card-arrow">${uiIcon("chevron")}</span>
      </button>`;
  }

  boxPaneHTML() {
    const s = this.state;
    const n = s.notebooks.find(x => x.id === this.openBoxId) || s.notebooks[0];
    if (!n) return '<div class="cdh-hint">没有可用的知识库</div>';
    const { text } = splitNotebookName(n.name);
    const docs = this.treeDocs();
    const conflicts = this.conflictDocs();
    const count = this.boxDocs ? docs.length : (s.countMap[n.id] || 0);
    const byId = new Map(docs.map(doc => [doc.id, doc]));
    const byPath = new Map(docs.filter(doc => doc.path).map(doc => [doc.path, doc.id]));
    const byTitlePath = new Map(docs.map(doc => [doc.hpath, doc.id]));
    const parentIds = new Map();
    const children = new Map();
    for (const doc of docs) {
      const parentPath = String(doc.path || "").replace(/\/[^/]+$/, "");
      const titleParentPath = String(doc.hpath || "").replace(/\/[^/]+$/, "");
      const parentId = (doc.path ? byPath.get(parentPath + ".sy") : titleParentPath && byTitlePath.get(titleParentPath)) || "";
      parentIds.set(doc.id, parentId);
      if (!children.has(parentId)) children.set(parentId, []);
      children.get(parentId).push(doc);
    }
    const folder = byId.get(this.browseParent);
    const trail = [];
    for (let item = folder; item; item = byId.get(parentIds.get(item.id))) trail.unshift(item);
    const rows = (children.get(folder?.id || "") || []).sort((a, b) => {
      const manual = this.sortMode === "manual" ? this.plugin.manualOrder(a.id, b.id) : 0;
      if (manual) return manual;
      const order = this.sortMode === "time" ? String(b.updated || "").localeCompare(String(a.updated || "")) : 0;
      return order || String(a.content || "").localeCompare(String(b.content || ""), "zh-CN", { numeric: true });
    });

    let body;
    if (this.boxError) {
      body = `<div class="cdh-hint cdh-error">读取目录失败：${esc(this.boxError)}</div>`;
    } else if (!this.boxDocs) {
      body = '<div class="cdh-loading">正在读取目录…</div>';
    } else if (!rows.length) {
      body = `<div class="cdh-hint">${folder ? "此目录暂无子文档" : "这个知识库还没有文档"}</div>`;
    } else {
      body = rows.map(r => {
        const kind = suiteFileKind(r);
        const childCount = children.get(r.id)?.length || 0;
        const browse = isFolderRow(r) || childCount > 0;
        const icon = browse ? "folder" : kind === "xmind" ? "mindmap" : suiteFileLabels.has(kind) ? kind : "file";
        return `
        <button type="button" class="cdh-recent-row cdh-directory-row" data-act="${browse ? "browse" : "open"}" data-id="${esc(r.id)}" data-menu="doc"
             data-box="${esc(r.box)}" data-hpath="${esc(r.hpath || "")}" data-title="${esc(r.content)}">
          <span class="cdh-row-icon cdh-list-icon-${icon}">${uiIcon(icon)}</span>
          <span class="cdh-recent-text"><b>${esc(prettyDocName(r.content))}</b>${browse ? `<small>${childCount} 个子项</small>` : ""}</span>
          <time>${esc(relTime(r.updated))}</time>
          <span class="cdh-directory-arrow">${browse ? uiIcon("chevron") : ""}</span>
        </button>`;
      }).join("");
    }

    return `
      <header class="cdh-banner cdh-banner--box">
        <div class="cdh-box-banner-content">
        <div class="cdh-banner-top">
          <button class="cdh-back" data-act="home">← 全部知识库</button>
          <div class="cdh-banner-actions">
            <button class="cdh-new" data-act="create-here" data-id="${esc(folder?.id || "")}">＋ 新建</button>
          </div>
        </div>
        <div class="cdh-box-head">
          <div class="cdh-box-cover">${uiIcon("book")}</div>
          <div class="cdh-box-meta">
            <h1>${esc(text)}</h1>
            <p>${count} 篇文档</p>
          </div>
        </div>
        </div>
      </header>
      <main class="cdh-main cdh-box-main">
        <section class="cdh-box-list" aria-label="目录">
        <div class="cdh-tree-toolbar">
          <nav class="cdh-directory-trail" aria-label="目录路径">
            ${folder ? `<button type="button" data-act="browse">${esc(text)}</button>` : '<span aria-current="location">根目录</span>'}
            ${trail.map(item => `<span aria-hidden="true">›</span>${item === folder
              ? `<span aria-current="location">${esc(prettyDocName(item.content))}</span>`
              : `<button type="button" data-act="browse" data-id="${esc(item.id)}">${esc(prettyDocName(item.content))}</button>`}`).join("")}
          </nav>
          <div class="cdh-sort">
            <button data-act="sort" data-mode="manual" class="${this.sortMode === "manual" ? "is-on" : ""}">手动</button>
            <button data-act="sort" data-mode="name" class="${this.sortMode === "name" ? "is-on" : ""}">名称</button>
            <button data-act="sort" data-mode="time" class="${this.sortMode === "time" ? "is-on" : ""}">更新</button>
          </div>
        </div>
        <div class="cdh-recent">${body}</div>
        </section>
        ${conflicts.length ? `<div class="cdh-hint cdh-hint--conflict">这个库还有 ${conflicts.length} 个同步冲突副本（标题带 <code>(Conflicted …)</code>），已折叠到左侧目录底部，需要时点开查看，不建议当作正文使用。</div>` : ""}
      </main>`;
  }

  /* 状态真源在插件上：Dock 里的导航与标签页里的内容读同一份，只读 */
  get openBoxId() { return this.plugin.nav.openBoxId; }
  get boxDocs() { return this.plugin.nav.boxDocs; }
  get boxError() { return this.plugin.nav.boxError; }
  get sortMode() { return this.plugin.nav.sortMode; }

  /** 真正放进目录树的文档：剔除「库根壳文档」和「同步冲突副本」 */
  treeDocs() { return (this.plugin.nav.boxDocs || []).filter(isVisibleDoc); }
  /** 当前库里被折叠起来的同步冲突副本 */
  conflictDocs() { return (this.plugin.nav.boxDocs || []).filter(isConflictDoc); }

  async onAction(act, id, el) {
    const s = this.state; if (!s) return;
    const nav = this.plugin.nav;
    if (act === "openBox") {
      const box = el?.dataset.box || "";
      if (!box) return;
      // 再点一次已经展开的库＝把它收起（回到首页卡片墙）
      return box === nav.openBoxId ? this.plugin.goHome() : this.plugin.goBox(box);
    }
    if (act === "home") return this.plugin.goHome();
    if (act === "sort") return this.plugin.setSortMode(el.dataset.mode);
    if (act === "browse") {
      this.browseParent = id || "";
      return this.render(false);
    }
    if (act === "create-here") return this.plugin.openCreateDialog(s, nav.openBoxId, id || "");
    if (act === "open" && id) {
      if (el?.classList.contains("cdh-search-result")) {
        const input = this.root.querySelector("[data-cdh-search]");
        if (input) input.value = "";
        this.hideSearch();
      }
      return this.plugin.openDoc(id);
    }
    if (act === "noop") return;
    if (act === "refresh") {
      this.plugin.navView?.refresh();
      if (nav.openBoxId) return this.plugin.goBox(nav.openBoxId, { force: true });
      return this.refresh();
    }
    if (act === "settings") return this.plugin.openSettingsDialog();
    if (act === "create") return this.plugin.openCreateDialog(s);
    if (act === "pin") {
      if (s.config.pins.some(p => p.id === id)) return;
      s.config.pins.push({ id, title: el.dataset.title || "" });
      await this.plugin.saveConfig(); this.render(); return;
    }
    if (act === "unpin") {
      s.config.pins = s.config.pins.filter(p => p.id !== id);
      await this.plugin.saveConfig(); this.render(); return;
    }
  }
}

module.exports = CloudDocsHome;

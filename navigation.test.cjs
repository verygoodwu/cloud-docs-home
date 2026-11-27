const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const context = { module: { exports: {} }, require: () => ({ Plugin: class {}, showMessage() {}, Dialog: class {
  constructor() { this.element = context.dialogElement; }
  destroy() {}
} }) };
const [NavView, HomeView] = vm.runInNewContext(fs.readFileSync(path.join(__dirname, "index.js"), "utf8") + "\n[NavView, HomeView];", context);

function directoryRefreshFixture() {
  return Object.assign(Object.create(context.module.exports.prototype), {
    nav: { openBoxId: "book-a", boxDocs: [], expanded: new Set() },
    pendingDocs: new Map(),
    deletedDocs: new Map(),
    saveExpanded() {}
  });
}

const documentInBookB = { id: "doc-b", box: "book-b", path: "/doc-b.sy", hpath: "/示例" };

test("revealing an import expands its collapsed ancestors, highlights only the imported row and scrolls to it", async () => {
  const plugin = directoryRefreshFixture();
  const folder = { id: "outer", box: "book-a", path: "/outer.sy", hpath: "/外层" };
  const nested = { id: "inner", box: "book-a", path: "/outer/inner.sy", hpath: "/外层/内层" };
  const imported = { id: "new", box: "book-a", path: "/outer/inner/new.sy", hpath: "/外层/内层/新文件.mm", title: "新文件.mm", kind: "mindmap" };
  plugin.nav.boxDocs = [folder, nested];
  plugin.nav.closed = new Set([folder.path, nested.path, "/other.sy"]);
  plugin.lifecycle = new AbortController();
  plugin.fetchOutline = async () => ({ title: imported.title, outline: [] });
  plugin.fetchBacklinks = async () => [];
  plugin.showHome = () => assert.fail("revealing an import must keep its editor visible");

  const view = Object.create(NavView.prototype);
  let scrollCount = 0;
  let html = "";
  const scroll = { scrollTop: 0, querySelector: () => html.includes("is-current") ? {
    dataset: { id: imported.id }, scrollIntoView: () => scrollCount++
  } : null };
  Object.assign(view, {
    plugin, state: {},
    sideHTML: () => view.renderTree(view.buildTree(plugin.nav.boxDocs)),
    el: { querySelector: () => scroll, set innerHTML(value) { html = value; } }
  });
  plugin.navView = view;

  await plugin.revealImportedDocument(imported);
  assert.match(html, /class="cdh-tree-row is-current"[^>]*data-id="new"/);
  assert.equal(html.match(/is-current/g).length, 1);
  assert.equal(scrollCount, 1);
  assert.deepEqual([...plugin.nav.closed], ["/other.sy"]);
  assert.equal(plugin.pendingDocs.has(imported.id), true);
});

test("revealing an import in another notebook switches the sidebar without opening home", async () => {
  const plugin = directoryRefreshFixture();
  const selections = [];
  plugin.nav.closed = new Set();
  plugin.navView = { render() {}, revealDoc: id => selections.push(id) };
  plugin.lifecycle = new AbortController();
  plugin.loadExpanded = () => ({ open: new Set(), closed: new Set() });
  plugin.fetchBoxDocs = async box => [...plugin.pendingDocs.values()].map(item => item.row).filter(row => row.box === box);
  plugin.fetchOutline = async () => ({ title: "示例", outline: [] });
  plugin.fetchBacklinks = async () => [];
  plugin.showHome = () => assert.fail("revealing an import must keep its editor visible");
  plugin.syncViews = () => {};

  await plugin.revealImportedDocument({ ...documentInBookB, title: "示例" });
  assert.equal(plugin.nav.openBoxId, documentInBookB.box);
  assert.equal(plugin.nav.boxDocs[0].id, documentInBookB.id);
  assert.deepEqual(selections, [documentInBookB.id]);
});

test("creating in another notebook does not insert into the open directory", () => {
  const plugin = directoryRefreshFixture();
  plugin.addDocLocal({ ...documentInBookB });
  assert.equal(plugin.pendingDocs.has(documentInBookB.id), true);
  assert.equal(plugin.nav.boxDocs.some(row => row.id === documentInBookB.id), false);
});

test("deletion clears a pending creation even when no directory is open", () => {
  const plugin = directoryRefreshFixture();
  plugin.nav.boxDocs = null;
  plugin.pendingDocs.set(documentInBookB.id, { row: documentInBookB, at: Date.now() });
  plugin.dropDocLocal(documentInBookB.id);
  assert.equal(plugin.pendingDocs.has(documentInBookB.id), false);
});

test("homepage recent documents exclude a deleted item in another notebook", async () => {
  const plugin = directoryRefreshFixture();
  plugin.config = { pins: [] };
  plugin.api = async (endpoint, body) => {
    if (endpoint.endsWith("/lsNotebooks")) return { notebooks: [{ id: "book-b" }] };
    return body.stmt.includes("COUNT") ? [] : [documentInBookB];
  };
  plugin.dropDocLocal(documentInBookB.id);
  const { recent } = await plugin.fetchState();
  assert.equal(recent.some(row => row.id === documentInBookB.id), false);
});

test("an older homepage refresh cannot replace a newer result", async () => {
  const view = Object.create(HomeView.prototype);
  let finishFirst;
  let finishSecond;
  const requests = [
    new Promise(resolve => { finishFirst = resolve; }),
    new Promise(resolve => { finishSecond = resolve; })
  ];
  view.plugin = { fetchState: () => requests.shift() };
  view.render = () => {};
  const first = view.reload();
  const second = view.reload();
  finishSecond({ recent: [] });
  await second;
  finishFirst({ recent: [documentInBookB] });
  await first;
  assert.equal(view.state.recent.length, 0);
});

test("closed tab cleanup preserves live, custom and unindexed tabs and skips a changed list", async () => {
  const key = "local-closed-tabs";
  const open = "20260101000000-openbox";
  const closed = "20260101000001-closedb";
  const missing = "20260101000002-missing";
  const live = "20260101000003-livedoc";
  const editor = (rootId, notebookId) => ({ children: { instance: "Editor", rootId, notebookId } });
  const stale = editor(missing, open);
  const keep = [editor(live, open), editor(missing, closed), { children: { instance: "Custom", rootId: missing } }];
  const tabs = [stale, ...keep, stale];
  const plugin = Object.create(context.module.exports.prototype);
  plugin.lifecycle = new AbortController();
  plugin.app = { appId: "test-client" };
  context.siyuan = { storage: { [key]: tabs } };
  const writes = [];
  let persisted = tabs.concat(editor(live, open));
  plugin.api = async (url, body) => {
    if (url.endsWith("/lsNotebooks")) return { notebooks: [{ id: open, closed: false }, { id: closed, closed: true }] };
    if (url.endsWith("/sql")) return [{ id: live, box: open }, { id: "", box: open }];
    if (url.endsWith("/getLocalStorage")) return { [key]: persisted };
    if (url.endsWith("/setLocalStorageVal")) { writes.push(body); return; }
    assert.fail(url);
  };
  try {
    await plugin.pruneClosedTabs();
    assert.equal(writes.length, 0);
    persisted = tabs.map(({ children }) => ({ children: Object.fromEntries(Object.entries(children).reverse()) }));
    await plugin.pruneClosedTabs();
    assert.equal(writes.length, 1);
    assert.equal(writes[0].app, "test-client");
    assert.equal(JSON.stringify(writes[0].val), JSON.stringify(keep));
    assert.equal(JSON.stringify(context.siyuan.storage[key]), JSON.stringify(keep));
  } finally {
    delete context.siyuan;
  }
});

test("refresh does not replace a newly selected notebook's documents", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  plugin.nav = { openBoxId: "A", boxDocs: [] };
  plugin.views = [];
  let finish;
  plugin.fetchBoxDocs = () => new Promise(resolve => { finish = resolve; });
  const pending = plugin.refreshAllViews();
  plugin.nav.openBoxId = "B";
  plugin.nav.boxDocs = [{ box: "B" }];
  finish([{ box: "A" }]);
  await pending;
  assert.equal(plugin.nav.boxDocs[0].box, "B");
});

test("tree drag moves by ID and rejects descendants and external files", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  const source = { id: "source", box: "box", path: "/source.sy", hpath: "/重名" };
  const descendant = { id: "child", box: "box", path: "/source/child.sy" };
  const destination = { id: "folder", box: "box", path: "/other/folder.sy", hpath: "/重名/文件夹" };
  plugin.nav = { boxDocs: [source, descendant, destination] };
  plugin.pendingDocs = new Map();
  plugin.afterDocChange = async () => {};
  const calls = [];
  plugin.api = async (endpoint, body) => calls.push([endpoint, body.fromIDs[0], body.toID]);
  const listeners = {};
  const view = new NavView({
    contains: () => true,
    classList: { add() {} },
    addEventListener: (type, callback) => { listeners[type] = callback; }
  }, Object.assign(plugin, { fetchNavState: async () => new Promise(() => {}) }));
  let pending;
  view.run = fn => { pending = fn(); };
  const row = id => ({ dataset: { menu: "doc", id }, classList: { add() {}, remove() {} } });
  const store = new Map();
  const transfer = { get types() { return [...store.keys()]; }, setData: store.set.bind(store), getData: store.get.bind(store) };
  let accepted = false;
  const event = (id, dataTransfer = transfer) => ({
    target: { closest: () => row(id) }, dataTransfer,
    preventDefault() { accepted = true; }, stopPropagation() {}
  });
  listeners.dragstart(event("source"));
  listeners.dragover(event("child"));
  listeners.dragover(event("folder", { types: ["Files"] }));
  assert.equal(accepted, false);
  listeners.dragover(event("folder"));
  assert.equal(accepted, true);
  listeners.drop(event("folder"));
  await pending;
  assert.deepEqual(calls, [["/api/filetree/moveDocsByID", "source", "folder"]]);
});

test("new document defaults to the clicked folder and creates under its ID", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  const folder = { id: "folder", box: "box", hpath: "/项目/资料", content: "资料" };
  plugin.nav = { openBoxId: "box", expanded: new Set(), closed: new Set() };
  await NavView.prototype.onAction.call({ plugin }, "folderEmpty", null, {
    closest: () => ({ dataset: { id: folder.id, box: folder.box } })
  });
  const fields = Object.fromEntries(["title", "box", "parent", "location-status", "create", "cancel"].map(name => [
    name, { addEventListener(type, fn) { this[type] = fn; }, focus() {} }
  ]));
  fields.title.value = "会议纪要";
  fields.box.value = "box";
  context.dialogElement = { querySelector: selector => fields[selector.slice(10, -1)] };
  plugin.fetchBoxDocs = async () => [folder];
  plugin.afterDocChange = async () => {};
  plugin.pendingDocs = new Map();
  plugin.views = new Set();
  plugin.nav.boxDocs = [folder];
  plugin.saveExpanded = () => {};
  let created, opened;
  plugin.api = async (_endpoint, body) => { created = body; return "new"; };
  plugin.openDoc = async id => { opened = id; };
  plugin.openCreateDialog({ notebooks: [{ id: "box", name: "知识库" }] }, "box");
  await new Promise(setImmediate);
  assert.equal(fields.parent.value, folder.id);
  await fields.create.click();
  assert.equal(created.parentID, folder.id);
  assert.equal(created.path, "/项目/资料/会议纪要");
  assert.equal(opened, "new");
  assert.equal(plugin.nav.boxDocs.some(doc => doc.id === "new"), true);
});

test("compact tree separates folder expansion, document opening and typed files", () => {
  const view = Object.create(NavView.prototype);
  view.plugin = { manualOrder: context.module.exports.prototype.manualOrder, nav: { openBoxId: "box", expanded: new Set(), boxDocs: [
    { id: "folder", box: "box", hpath: "/资料", content: "资料", ial: 'custom-cdh-folder="true"' },
    { id: "doc", box: "box", hpath: "/硬件", content: "硬件" },
    { id: "sheet", box: "box", hpath: "/盘点", content: "盘点", ial: '{: custom-cloud-document-kind="spreadsheet"}' },
    { id: "child", box: "box", hpath: "/硬件/配置", content: "配置" }
  ] } };
  const html = view.sideTreeHTML();
  assert.doesNotMatch(html, /cdh-tree-tools/);
  assert.match(html, /data-id="folder"[^>]+data-act="folderEmpty"/);
  assert.match(html, /data-id="doc"[^>]+data-act="open"[^>]+>\s*<button[^>]+aria-expanded="false"/);
  assert.match(html, /电子表格[^>]+>\s*<span[^>]+>\s*<\/span>\s*<span class="cdh-tree-icon cdh-file-spreadsheet"/);
  assert.ok(view.boxMenuItems({ id: "box" }).some(item => item.label === "全部收起"));
});
test("notebook browsing uses document IDs to keep same-title branches separate", async () => {
  const view = Object.create(HomeView.prototype);
  const doc = (id, hpath, path, ial) => ({ id, box: "box", content: hpath.split("/").at(-1), hpath, path, ial });
  view.state = { notebooks: [{ id: "box", name: "Notebook" }], countMap: {} };
  view.plugin = { manualOrder: context.module.exports.prototype.manualOrder, nav: { openBoxId: "box", boxDocs: [
    doc("a", "/Same", "/a.sy"), doc("b", "/Same", "/b.sy"),
    doc("leaf", "/Same/Leaf", "/a/leaf.sy"),
    doc("empty", "/Same/Empty", "/b/empty.sy", 'custom-cdh-folder="true"')
  ] } };
  view.render = () => view.boxPaneHTML();
  const root = view.render();
  assert.match(root, /data-act="browse" data-id="a"/);
  assert.doesNotMatch(root, /data-id="leaf"/);
  const folder = await view.onAction("browse", "a");
  assert.match(folder, /data-act="open" data-id="leaf"/);
  assert.doesNotMatch(folder, /data-id="empty"/);
  assert.match(folder, /data-act="create-here" data-id="a"/);
  assert.match(await view.onAction("browse", "b"), /data-act="browse" data-id="empty"/);
  assert.match(await view.onAction("browse", "empty"), /aria-current="location">Empty/);
  assert.match(await view.onAction("browse", ""), /data-act="browse" data-id="a"/);
});

test("manual ordering persists IDs, survives reload and rolls back a failed save", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  plugin.config = { pins: [], navigationOrder: ["other"] };
  plugin.loadConfig = async () => plugin.config;
  let saved;
  plugin.saveConfig = async () => { saved = JSON.parse(JSON.stringify(plugin.config)); };
  plugin.syncViews = async () => {};
  await plugin.reorderNavigation("c", "a", false, ["a", "b", "c"]);
  assert.equal(JSON.stringify(saved.navigationOrder), JSON.stringify(["other", "c", "a", "b"]));
  plugin.config = saved;
  assert.ok(plugin.manualOrder("c", "a") < 0);
  plugin.saveConfig = async () => { throw Error("write failed"); };
  await assert.rejects(plugin.reorderNavigation("a", "c", false, ["c", "a", "b"]), /write failed/);
  assert.equal(JSON.stringify(plugin.config.navigationOrder), JSON.stringify(["other", "c", "a", "b"]));
});

test("drop edges reorder siblings while the center moves into a document", () => {
  const source = { id: "a", box: "book", path: "/a.sy" };
  const target = { id: "b", box: "book", path: "/b.sy" };
  const view = Object.create(NavView.prototype);
  view.draggedDoc = source;
  view.el = { contains: () => true };
  view.plugin = { nav: { boxDocs: [source, target] }, isSelfOrDescendant: () => false };
  const row = { dataset: { menu: "doc", id: "b" }, getBoundingClientRect: () => ({ top: 100, height: 40 }) };
  const event = y => ({ target: { closest: selector => selector === ".cdh-side-scroll" ? null : row }, clientY: y, dataTransfer: { types: ["application/x-cloud-docs-home-document"] } });
  assert.equal(view.docDropTarget(event(102)).order, "before");
  assert.equal(view.docDropTarget(event(138)).order, "after");
  assert.equal(view.docDropTarget(event(120)).order, undefined);
  view.draggedDoc = { id: "first", notebook: true };
  row.dataset = { menu: "box", box: "second" };
  assert.equal(view.docDropTarget(event(102)).order, "before");
  assert.equal(view.docDropTarget(event(138)).order, "after");
});

test("notebook gaps accept ordering instead of requiring a row hit", () => {
  const view = Object.create(NavView.prototype);
  view.draggedDoc = { id: "career", notebook: true };
  const row = (id, top) => ({ dataset: { box: id }, getBoundingClientRect: () => ({ top, height: 30 }) });
  const rows = [row("inbox", 100), row("saved", 140), row("career", 180)];
  const scroll = { querySelectorAll: () => rows };
  view.el = { contains: () => true };
  const event = y => ({
    clientY: y, target: { closest: selector => selector === ".cdh-side-scroll" ? scroll : null },
    dataTransfer: { types: ["application/x-cloud-docs-home-document"] }
  });
  assert.equal(view.docDropTarget(event(95)).id, "inbox");
  assert.equal(view.docDropTarget(event(95)).order, "before");
  assert.equal(view.docDropTarget(event(135)).id, "saved");
  assert.equal(view.docDropTarget(event(135)).order, "before");
});

test("failed or corrupt config reads cannot overwrite settings and can be retried", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  let writes = 0;
  plugin.saveData = async () => { writes++; };
  plugin.loadData = async () => { throw Error("offline"); };
  await assert.rejects(plugin.loadConfig(), /offline/);
  await assert.rejects(plugin.saveConfig(), /offline/);
  assert.equal(writes, 0);
  plugin.loadData = async () => "{bad json";
  await assert.rejects(plugin.saveConfig());
  assert.equal(writes, 0);
  plugin.loadData = async () => ({ pins: [{ id: "old", title: "Saved" }], navigationOrder: ["b", "a"] });
  const recovered = await plugin.loadConfig();
  assert.equal(recovered.pins[0].id, "old");
  await plugin.saveConfig();
  assert.equal(writes, 1);
});

test("manual, name and updated modes reorder both document views and survive reload", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  const docs = [
    { id: "a", box: "book", path: "/a.sy", hpath: "/Apple", content: "Apple", updated: "20260101" },
    { id: "b", box: "book", path: "/b.sy", hpath: "/Banana", content: "Banana", updated: "20260103" },
    { id: "c", box: "book", path: "/c.sy", hpath: "/Cherry", content: "Cherry", updated: "20260102" }
  ];
  plugin.config = { pins: [], navigationOrder: ["c", "b", "a"] };
  plugin.nav = { openBoxId: "book", expanded: new Set(), boxDocs: docs, sortMode: "manual" };
  let persisted;
  plugin.saveData = async (_key, config) => { persisted = JSON.stringify(config); };
  plugin.syncViews = () => {};
  const tree = Object.create(NavView.prototype); tree.plugin = plugin;
  const home = Object.create(HomeView.prototype); home.plugin = plugin;
  home.state = { notebooks: [{ id: "book", name: "Book" }], countMap: {} };
  const order = html => [...html.matchAll(/data-id="([abc])"/g)].map(match => match[1])
    .filter((id, index, ids) => ids.indexOf(id) === index);
  for (const [mode, ids] of [["manual", ["c","b","a"]], ["name", ["a","b","c"]], ["time", ["b","c","a"]]]) {
    await plugin.setSortMode(mode);
    assert.deepEqual(order(tree.sideTreeHTML()), ids);
    assert.deepEqual(order(home.boxPaneHTML()), ids);
  }
  const restored = Object.create(context.module.exports.prototype);
  restored.nav = {};
  restored.loadData = async () => persisted;
  await restored.loadConfig();
  assert.equal(restored.nav.sortMode, "time");
  assert.equal(restored.config.navigationOrder[0], "c");
});

test("homepage notebook cards use the same saved order as sidebar", () => {
  const plugin = Object.create(context.module.exports.prototype);
  plugin.config = { pins: [], navigationOrder: ["b", "a"] };
  const home = Object.create(HomeView.prototype);
  home.plugin = plugin;
  home.state = { config: plugin.config, openNotebooks: [{id:"a"},{id:"b"}], recent: [] };
  home.notebookCard = book => "<article>" + book.id + "</article>";
  assert.match(home.homePaneHTML(), /<article>b<.article><article>a<.article>/);
});

test("queued sorting preserves the newest choice after an earlier save fails", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  plugin.config = { pins: [], documentSortMode: "manual" };
  plugin.nav = { sortMode: "manual" };
  plugin.syncViews = () => {};
  let rejectFirst, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  let count = 0;
  plugin.saveConfig = async () => {
    count++;
    if (count === 1) { entered(); await new Promise((_resolve, reject) => { rejectFirst = reject; }); }
  };
  const first = plugin.setSortMode("name");
  const rejected = assert.rejects(first, /failed/);
  await ready;
  const second = plugin.setSortMode("time");
  rejectFirst(Error("failed"));
  await rejected; await second;
  assert.equal(plugin.nav.sortMode, "time");
  assert.equal(plugin.config.documentSortMode, "time");
});

test("same-title folders stay separate by physical document IDs", () => {
  const view = Object.create(NavView.prototype);
  view.plugin = { nav: {} };
  const row = (id, path, hpath) => ({ id, path, hpath, content: hpath.split("/").at(-1) });
  const tree = view.buildTree([
    row("a", "/a.sy", "/Same"), row("b", "/b.sy", "/Same"),
    row("leaf", "/a/leaf.sy", "/Same/Leaf")
  ]);
  assert.equal(tree.children.size, 2);
  assert.equal(tree.children.get("a").children.get("leaf").doc.id, "leaf");
  assert.equal(tree.children.get("b").children.size, 0);
});

test("created child stays visible while the SQL index still has the old list", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  const parent = {id:"folder", box:"book", path:"/folder.sy", hpath:"/Same", content:"Same"};
  plugin.nav = {boxDocs:[parent], expanded:new Set(), closed:new Set()};
  plugin.pendingDocs = new Map();
  plugin.deletedDocs = new Map();
  plugin.saveExpanded = () => {};
  plugin.api = async () => [{...parent}];
  plugin.addDocLocal({id:"new",box:"book",hpath:"/Same/New",content:"New"}, "folder");
  assert.equal(plugin.nav.boxDocs[1].path, "/folder/new.sy");
  assert.equal(plugin.nav.expanded.has("/folder.sy"), true);
  const rows = await plugin.fetchBoxDocs("book");
  assert.equal(rows.some(row => row.id === "new"), true);
});

test("deleted subtree cannot return from a stale SQL response and same-name siblings remain", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  const rows = [
    {id:"folder",box:"book",path:"/folder.sy",hpath:"/Same"},
    {id:"child",box:"book",path:"/folder/child.sy",hpath:"/Same/Child"},
    {id:"other",box:"book",path:"/other.sy",hpath:"/Same"}
  ];
  plugin.nav = {boxDocs:rows.map(row=>({...row}))};
  plugin.pendingDocs = new Map([["child",{row:rows[1],at:Date.now()}]]);
  plugin.deletedDocs = new Map();
  plugin.api = async () => rows.map(row=>({...row}));
  plugin.dropDocLocal("folder");
  assert.deepEqual(plugin.nav.boxDocs.map(row=>row.id), ["other"]);
  assert.deepEqual((await plugin.fetchBoxDocs("book")).map(row=>row.id), ["other"]);
  assert.equal(plugin.pendingDocs.has("child"), false);
  plugin.api = async () => [rows[2]];
  await plugin.fetchBoxDocs("book");
  assert.equal(plugin.deletedDocs.size, 0);
});

test("document changes render local rows before a slow directory fetch resolves", async () => {
  const plugin = Object.create(context.module.exports.prototype);
  const seen = [];
  let finish;
  plugin.navView = {render:()=>seen.push("tree")};
  plugin.syncViews = ()=>seen.push("content");
  plugin.refreshAllViews = ()=>new Promise(resolve=>{finish=resolve});
  context.setTimeout = () => 1;
  context.clearTimeout = () => {};
  try {
    const pending = plugin.afterDocChange();
    assert.deepEqual(seen,["tree","content"]);
    finish();
    await pending;
  } finally {delete context.setTimeout;delete context.clearTimeout;}
});

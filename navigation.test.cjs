const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const context = { module: { exports: {} }, require: () => ({ Plugin: class {} }) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "index.js"), "utf8"), context);

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

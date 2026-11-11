const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const context = { module: { exports: {} }, require: () => ({ Plugin: class {} }) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "index.js"), "utf8"), context);

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

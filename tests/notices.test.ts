import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { checkOrigin, normalizeNotice, readJSON, requireOwner } from "../lib/notice-input.ts";
import { deleteNotices, importNotices, listNotices, updateNotice } from "../lib/notice-store.ts";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(`drizzle/${file}`, "utf8"));
  function prepare(sql: string) {
    let values: unknown[] = [];
    const statement = {
      bind(...args: unknown[]) { values = args; return statement; },
      async all() { return { results: sqlite.prepare(sql).all(...values as never[]) }; },
      async first() { return sqlite.prepare(sql).get(...values as never[]) ?? null; },
    };
    return statement;
  }
  const db = {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      sqlite.exec("BEGIN");
      try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  } as unknown as D1Database;
  return { db, close: () => sqlite.close() };
}
const notice = (title = "测试通知") => ({ title, content: "这是测试原文。", category: "课程学习", deadline: "2026-10-25" });

test("Agent 导入、重试去重、面板读取，保留原文与保存编号", async () => {
  const { db, close } = database();
  try {
    const first = await importNotices(db, "alice", [notice()]);
    assert.equal(first.imported, 1);
    assert.ok(first.created[0].id);
    const second = await importNotices(db, "alice", [{ ...notice(), summary: "另一个摘要" }]);
    assert.equal(second.skipped, 1);
    assert.equal(second.duplicates[0].id, first.created[0].id);
    const list = await listNotices(db, "alice");
    assert.equal(list.length, 1);
    assert.equal(list[0].content, "这是测试原文。");
    assert.equal(list[0].importedBy, "agent");
  } finally { close(); }
});

test("不同用户的数据隔离，不能更新或删除别人的通知", async () => {
  const { db, close } = database();
  try {
    const { created } = await importNotices(db, "alice", [notice()]);
    assert.deepEqual(await listNotices(db, "bob"), []);
    await assert.rejects(updateNotice(db, "bob", created[0].id, { title: "篡改" }), /不存在/);
    await deleteNotices(db, "bob", [created[0].id]);
    assert.equal((await listNotices(db, "alice")).length, 1);
    assert.equal((await importNotices(db, "bob", [notice()])).imported, 1);
  } finally { close(); }
});

test("批次中一条不合法时整批不写入；日期不猜测且空日期可保存", async () => {
  const { db, close } = database();
  try {
    await assert.rejects(importNotices(db, "alice", [notice(), { ...notice("另一条"), deadline: "2026-02-30" }]), /有效/);
    assert.deepEqual(await listNotices(db, "alice"), []);
    await importNotices(db, "alice", [{ ...notice(), deadline: "", sourceUrl: "https://example.org/notice" }]);
    assert.equal((await listNotices(db, "alice"))[0].deadline, "");
    assert.throws(() => normalizeNotice({ ...notice(), sourceUrl: "javascript:alert(1)" }), /HTTP/);
    await assert.rejects(importNotices(db, "alice", Array.from({ length: 51 }, () => notice())), /50/);
  } finally { close(); }
});

test("手动修改和删除不会覆盖 Agent 同时导入的其他通知", async () => {
  const { db, close } = database();
  try {
    const { created } = await importNotices(db, "alice", [notice()], "manual");
    await importNotices(db, "alice", [notice("Agent 新通知")]);
    await updateNotice(db, "alice", created[0].id, { read: true, favorite: true });
    let list = await listNotices(db, "alice");
    assert.equal(list.length, 2);
    assert.equal(list.find(n => n.id === created[0].id)?.favorite, true);
    await deleteNotices(db, "alice", [created[0].id]);
    list = await listNotices(db, "alice");
    assert.equal(list[0].title, "Agent 新通知");
  } finally { close(); }
});

test("登录、跨站请求和请求体大小边界", async () => {
  assert.throws(() => requireOwner(new Headers()), /登录/);
  assert.equal(requireOwner(new Headers({ "oai-authenticated-user-id": "alice" })), "alice");
  assert.throws(() => checkOrigin(new Request("https://notice.test/api/notices", { headers: { origin: "https://evil.test" } })), /跨站/);
  const request = new Request("https://notice.test/api/notices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }) });
  await assert.rejects(readJSON(request), /2 MB/);
});

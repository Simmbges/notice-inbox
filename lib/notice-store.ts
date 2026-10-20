import { categories, fingerprint, InputError, normalizeEvents, normalizeNotice, noticeDefaults, type Notice } from "./notice-input.ts";

export async function listNotices(db: D1Database, owner: string): Promise<Notice[]> {
  const result = await db.prepare("SELECT data, updated_at FROM notices WHERE owner_id = ? ORDER BY created_at DESC, id DESC").bind(owner).all<{ data: string; updated_at: number }>();
  return result.results.map(row => {
    const notice = JSON.parse(row.data);
    return noticeDefaults({ ...notice, events: normalizeEvents(notice.events), updatedAt: row.updated_at });
  });
}

export async function importNotices(db: D1Database, owner: string, values: unknown, importedBy = "agent", getCategories = () => categories) {
  if (!Array.isArray(values) || !values.length || values.length > 50) throw new InputError("每次请导入 1 至 50 条事件。");
  // 整批校验完成后再原子写入，避免半批成功。
  const allowedCategories = getCategories();
  const notices = values.map(value => normalizeNotice(value, importedBy, allowedCategories));
  const hashes = await Promise.all(notices.map(fingerprint));
  const currentCategories = getCategories();
  if (notices.some(notice => !currentCategories.includes(notice.category))) throw new InputError("分类已变更，请刷新后重新选择分类。", 409);
  const statements = notices.map((notice, i) => db.prepare(
    "INSERT INTO notices (owner_id, id, fingerprint, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING data"
  ).bind(owner, notice.id, hashes[i], JSON.stringify(notice), notice.createdAt, Date.now()));
  const results = await db.batch<{ data: string }>(statements);
  const created: Notice[] = [], duplicates: { id: string; title: string }[] = [];
  for (let i = 0; i < results.length; i++) {
    const row = results[i].results[0];
    if (row) created.push(JSON.parse(row.data));
    else {
      const existing = await db.prepare("SELECT id, data FROM notices WHERE owner_id = ? AND (fingerprint = ? OR id = ?) LIMIT 1").bind(owner, hashes[i], notices[i].id).first<{ id: string; data: string }>();
      if (existing) duplicates.push({ id: existing.id, title: JSON.parse(existing.data).title });
    }
  }
  return { created, duplicates, imported: created.length, skipped: duplicates.length };
}

export async function updateNotice(db: D1Database, owner: string, id: string, patch: unknown, getCategories = () => categories, expectedUpdatedAt?: unknown) {
  if (typeof id !== "string" || !id || id.length > 160) throw new InputError("请提供有效的事件编号。");
  const row = await db.prepare("SELECT data, updated_at FROM notices WHERE owner_id = ? AND id = ?").bind(owner, id).first<{ data: string; updated_at: number }>();
  if (!row) throw new InputError("事件不存在。", 404);
  if (expectedUpdatedAt !== undefined && (!Number.isSafeInteger(expectedUpdatedAt) || Number(expectedUpdatedAt) < 0)) throw new InputError("请提供有效的最新 updatedAt。");
  if (expectedUpdatedAt !== undefined && expectedUpdatedAt !== row.updated_at) throw new InputError("事件已被修改，请刷新后重试。", 409);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new InputError("更新内容必须是一个对象。");
  const previous: Notice = JSON.parse(row.data);
  const notice = normalizeNotice({ ...previous, ...patch, id, createdAt: previous.createdAt }, previous.importedBy, getCategories());
  const hash = await fingerprint(notice);
  const duplicate = await db.prepare("SELECT id FROM notices WHERE owner_id = ? AND fingerprint = ? AND id != ?").bind(owner, hash, id).first();
  if (duplicate) throw new InputError("事件库中已有相同事件。", 409);
  const updatedAt = Math.max(Date.now(), row.updated_at + 1);
  try {
    if (!getCategories().includes(notice.category)) throw new InputError("分类已变更，请刷新后重新选择分类。", 409);
    const changed = await db.prepare("UPDATE notices SET data = ?, fingerprint = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND updated_at = ? RETURNING data").bind(JSON.stringify(notice), hash, updatedAt, owner, id, row.updated_at).first();
    if (!changed) throw new InputError("事件已被修改或删除，请刷新后重试。", 409);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) throw new InputError("事件库中已有相同事件。", 409);
    throw error;
  }
  return { ...notice, updatedAt };
}

export async function deleteNotices(db: D1Database, owner: string, ids: unknown) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || ids.some(id => typeof id !== "string" || !id || id.length > 160)) throw new InputError("请提供 1 至 50 个有效的事件编号。");
  await db.batch(ids.map(id => db.prepare("DELETE FROM notices WHERE owner_id = ? AND id = ?").bind(owner, id)));
}

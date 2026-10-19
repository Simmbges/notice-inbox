import { categories, InputError } from '../lib/notice-input.ts';

const fallback = '其他通知';
function categoryName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 30 || /[\u0000-\u001f\u007f]/.test(value)) throw new InputError('分类名称需为 1—30 个字符，不能含换行或控制字符。');
  return value.trim();
}

export function createCategoryStore(sqlite) {
  function list(owner) {
    sqlite.prepare('INSERT OR IGNORE INTO notice_categories (owner_id, names) VALUES (?, ?)').run(owner, JSON.stringify(categories));
    return JSON.parse(sqlite.prepare('SELECT names FROM notice_categories WHERE owner_id = ?').get(owner).names);
  }
  function change(owner, method, body) {
    const name = categoryName(body.name);
    const renamed = method === 'PATCH' ? categoryName(body.newName) : '';
    sqlite.exec('BEGIN IMMEDIATE');
    try {
      const names = list(owner);
      let next;
      if (method === 'POST') {
        if (names.includes(name)) throw new InputError('这个分类已经存在。', 409);
        if (names.length >= 30) throw new InputError('最多可创建 30 个分类。');
        next = [...names.slice(0, -1), name, fallback];
      } else {
        if (name === fallback) throw new InputError('“其他通知”用于接收未分类的通知，不能重命名或删除。');
        if (!names.includes(name)) throw new InputError('分类不存在，请刷新后重试。', 404);
        if (method === 'PATCH' && renamed !== name && names.includes(renamed)) throw new InputError('这个分类名称已经存在。', 409);
        next = method === 'PATCH' ? names.map(value => value === name ? renamed : value) : names.filter(value => value !== name);
        sqlite.prepare("UPDATE notices SET data = json_set(data, '$.category', ?), updated_at = ? WHERE owner_id = ? AND json_extract(data, '$.category') = ?").run(method === 'PATCH' ? renamed : fallback, Date.now(), owner, name);
      }
      sqlite.prepare('UPDATE notice_categories SET names = ? WHERE owner_id = ?').run(JSON.stringify(next), owner);
      sqlite.exec('COMMIT');
      return { categories: next };
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  return { list, change };
}

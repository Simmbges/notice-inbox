import { categories, InputError } from '../lib/notice-input.ts';

const fallback = '其他通知';
const scheduleCategory = '日程';
const courseCategory = '课程';
function categoryName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 30 || /[\u0000-\u001f\u007f]/.test(value)) throw new InputError('分类名称需为 1—30 个字符，不能含换行或控制字符。');
  return value.trim();
}

export function createCategoryStore(sqlite) {
  function list(owner) {
    const initial = [...categories.filter(name => name !== fallback), scheduleCategory, courseCategory, fallback];
    sqlite.prepare('INSERT OR IGNORE INTO notice_categories (owner_id, names, schedule_category, course_category) VALUES (?, ?, ?, ?)').run(owner, JSON.stringify(initial), scheduleCategory, courseCategory);
    return JSON.parse(sqlite.prepare('SELECT names FROM notice_categories WHERE owner_id = ?').get(owner).names);
  }
  function defaultCategory(owner, recordType = 'schedule') {
    const names = list(owner);
    const defaults = sqlite.prepare('SELECT schedule_category, course_category FROM notice_categories WHERE owner_id = ?').get(owner);
    const name = recordType === 'course' ? defaults.course_category : defaults.schedule_category;
    return names.includes(name) ? name : fallback;
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
        if (name === fallback) throw new InputError('“其他事件”用于接收未分类的事件，不能重命名或删除。');
        if (!names.includes(name)) throw new InputError('分类不存在，请刷新后重试。', 404);
        if (method === 'PATCH' && renamed !== name && names.includes(renamed)) throw new InputError('这个分类名称已经存在。', 409);
        next = method === 'PATCH' ? names.map(value => value === name ? renamed : value) : names.filter(value => value !== name);
        const destination = method === 'PATCH' ? renamed : fallback, now = Date.now();
        sqlite.prepare("UPDATE notices SET data = json_set(data, '$.category', ?), updated_at = MAX(?, updated_at + 1) WHERE owner_id = ? AND json_extract(data, '$.category') = ?").run(destination, now, owner, name);
        sqlite.prepare("UPDATE notice_events SET data = json_set(data, '$.category', ?, '$.version', version + 1, '$.revision', version + 1, '$.updatedAt', MAX(?, updated_at + 1)), version = version + 1, updated_at = MAX(?, updated_at + 1) WHERE owner_id = ? AND json_extract(data, '$.category') = ?").run(destination, now, now, owner, name);
        sqlite.prepare('UPDATE notice_categories SET schedule_category = ? WHERE owner_id = ? AND schedule_category = ?').run(destination, owner, name);
        sqlite.prepare('UPDATE notice_categories SET course_category = ? WHERE owner_id = ? AND course_category = ?').run(destination, owner, name);
      }
      sqlite.prepare('UPDATE notice_categories SET names = ? WHERE owner_id = ?').run(JSON.stringify(next), owner);
      sqlite.exec('COMMIT');
      return { categories: next };
    } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  return { list, change, defaultCategory };
}

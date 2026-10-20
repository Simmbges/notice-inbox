ALTER TABLE notice_categories ADD COLUMN course_category TEXT NOT NULL DEFAULT '课程';

-- 旧记录只根据明确的课表来源识别课程；周期健身等个人安排仍是日程。
UPDATE notice_events
SET data = json_set(data, '$.recordType', CASE
  WHEN COALESCE(json_extract(data, '$.sourceName'), '') || COALESCE(json_extract(data, '$.sourceText'), '') LIKE '%课表%'
    OR COALESCE(json_extract(data, '$.sourceName'), '') || COALESCE(json_extract(data, '$.sourceText'), '') LIKE '%课程表%'
    OR COALESCE(json_extract(data, '$.sourceName'), '') || COALESCE(json_extract(data, '$.sourceText'), '') LIKE '%教务%'
    OR COALESCE(json_extract(data, '$.sourceName'), '') || COALESCE(json_extract(data, '$.sourceText'), '') LIKE '%上课%'
    OR COALESCE(json_extract(data, '$.sourceName'), '') || COALESCE(json_extract(data, '$.sourceText'), '') LIKE '%授课%'
  THEN 'course' ELSE 'schedule' END)
WHERE json_extract(data, '$.recordType') IS NULL;

UPDATE notice_events AS child
SET data = json_set(data, '$.recordType', (
  SELECT json_extract(parent.data, '$.recordType') FROM notice_events AS parent
  WHERE parent.owner_id = child.owner_id AND parent.id = json_extract(child.data, '$.seriesId')
))
WHERE EXISTS (
  SELECT 1 FROM notice_events AS parent
  WHERE parent.owner_id = child.owner_id AND parent.id = json_extract(child.data, '$.seriesId')
);

-- 拆分原始默认分类，用户已经重命名或另行归类的记录保持原分类。
UPDATE notice_events
SET data = json_set(data, '$.category', CASE
  WHEN json_extract(data, '$.recordType') = 'course' THEN '课程' ELSE '日程' END)
WHERE json_extract(data, '$.category') IS NULL OR (
  json_extract(data, '$.category') = '日程与课表' AND NOT EXISTS (
    SELECT 1 FROM notice_categories WHERE notice_categories.owner_id = notice_events.owner_id AND schedule_category != '日程与课表'
  )
);

UPDATE notices
SET data = json_set(data, '$.category', '日程'), updated_at = MAX(unixepoch() * 1000, updated_at + 1)
WHERE json_extract(data, '$.category') = '日程与课表' AND NOT EXISTS (
  SELECT 1 FROM notice_categories WHERE notice_categories.owner_id = notices.owner_id AND schedule_category != '日程与课表'
);

UPDATE notice_categories
SET names = (
  SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(notice_categories.names)
    WHERE value != '其他通知' AND NOT (value = '日程与课表' AND schedule_category = '日程与课表')
    UNION ALL SELECT '日程' WHERE schedule_category = '日程与课表' AND NOT EXISTS (SELECT 1 FROM json_each(notice_categories.names) WHERE value = '日程')
    UNION ALL SELECT '课程' WHERE NOT EXISTS (SELECT 1 FROM json_each(notice_categories.names) WHERE value = '课程')
    UNION ALL SELECT '其他通知'
  )
);

UPDATE notice_categories SET schedule_category = '日程' WHERE schedule_category = '日程与课表';

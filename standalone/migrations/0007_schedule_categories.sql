ALTER TABLE notice_categories ADD COLUMN schedule_category TEXT NOT NULL DEFAULT '日程与课表';

UPDATE notice_categories
SET names = (
  SELECT json_group_array(value) FROM (
    SELECT value FROM json_each(notice_categories.names) WHERE value != '其他通知'
    UNION ALL SELECT '日程与课表' WHERE NOT EXISTS (SELECT 1 FROM json_each(notice_categories.names) WHERE value = '日程与课表')
    UNION ALL SELECT '其他通知'
  )
);

UPDATE notice_events
SET data = json_set(data, '$.category', '日程与课表')
WHERE json_extract(data, '$.category') IS NULL;

UPDATE notice_events
SET data = json_set(data, '$.favorite', json('false'))
WHERE json_type(data, '$.favorite') IS NULL;

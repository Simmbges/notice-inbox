# 知会独立版 MCP 约定

实际工具发现结果优先。已连接客户端可直接调用工具，无需重新配置服务或提供密钥。

## 权限和更新规则

`import` 只允许 `import_notices`；`read` 允许事件、日程、任务、偏好及复盘的只读工具；`read_import` 具有以上读取能力并可导入事件；`manage` 允许所有工具。旧密钥不会自动获得管理能力，需用户在连接面板创建所需权限的密钥。不要替用户更换或扩权。

管理更新使用本轮读取的真实编号和版本。个人日程、任务、偏好提交 `expectedVersion`；事件事项提交 `expectedUpdatedAt`。版本冲突意味着数据已经变化，重新读取、比较后只更新仍在授权范围内的字段，不盲目重试。每个成功或错误结果都按实际返回说明，不把建议当作已保存。

## import_notices

```json
{
  "notices": [{
    "title": "材料提交提醒",
    "content": "这里保留用户提供的完整事件原文。",
    "summary": "只根据原文生成的简要说明。",
    "recordType": "schedule",
    "participation": "reference",
    "category": "课程学习",
    "sourceName": "",
    "sourceUrl": "",
    "publishedAt": "",
    "deadline": "",
    "events": [{
      "title": "材料提交截止",
      "date": "2026-10-23",
      "time": "17:00",
      "endDate": "",
      "endTime": "",
      "kind": "deadline",
      "evidence": "原文明确写明：材料于2026年10月23日17:00前提交。"
    }],
    "audience": "",
    "location": ""
  }]
}
```

只有 `title` 必填；`content`、来源、日期和 `events` 都可空，不伪造占位原文或时间。根 `recordType` 为 `schedule`（事件，默认）或 `course`（课程）；`participation` 为 `reference`（资料信息，默认）或 `planned`（纳入我的安排），`active` 默认为 true。只收集资料使用 reference，用户明确要求安排的才用 planned。类型、周期和参与状态分别表达不同含义。

分类按账号自定义，包含原有分类及“日程”“课程”；保留分类的接口值 `其他通知` 在面板显示为“其他事件”。新普通事件省略分类使用保留分类，课程省略分类使用当前课程默认分类。实际名称以当前 MCP schema 的分类枚举或 `list_notices` 返回的 `categories` 为准，未知分类会被拒绝；需先在面板添加，不会由 Agent 导入自动创建。文本上限分别为 title 120、content 20000、summary 240、sourceName 80、sourceUrl 2000、audience/location 120 字符。日期为有效的 `YYYY-MM-DD` 或空字符串。过长原文不能静默截断，应说明限制后与用户确定保存方式。

`events` 是可省略的数组，最多 50 项，每项为一条独立时间事项：

- `title` 必填，最多 120 字；`date` 为有效 `YYYY-MM-DD` 或空。日期未知时通常只保存根事件；若保留标题及依据作为待定时间点，不能填写时分、结束范围或非空 recurrence，不会生成时间表实例，也不能称为已排程。
- `time` 可空，为 `HH:mm`；`endDate` 可空，为不早于 `date` 的有效日期。
- `endTime` 可空，为 `HH:mm`；填写时必须有开始 `time`，且整体结束时间晚于开始。省略 `endDate` 表示同日结束，缺少时分不能补成 00:00。
- `kind` 为 `event`（默认）或 `deadline`。截止事项不能有 `endDate` 或 `endTime`；活动区间使用 `event`。
- `evidence` 可空，最多 500 字；有原文时填写支撑日期和时间的片段，不把建议或推测存成原文证据。没有原文可留空。日期不可靠时留空，可保留为待定时间点，并在回复中列为待确认。
- 每项可分别带 `recurrence`，null 或省略表示不重复；周期结构与 `import_events` 相同，为 `{until,weekdays,intervalWeeks,weeks,excludeDates}`。同一事件可同时有一次性和每周重复时间项，展开时保留各项规则。

活动发生日放入 `events`，`deadline` 保留明确截止日。一次事件可以同时包含报名截止和活动区间。列表及详情会返回 `events`；旧数据可能为空，需要读取正文核对，不能把空数组当作没有活动。当前工具 schema 若尚未提供此字段，不传未知参数，说明连接版本限制，并在回复中整理时间事项。

成功返回 `imported`、`skipped`、`created` 和 `duplicates`，后两项包含保存编号。有非空原文时继续按标题、正文和来源链接去重，原文为空时还纳入时间事项，以区分同名不同时间的记录。重复导入会跳过，不覆盖或回填已存事件；管理连接可在用户要求修正时间后用 `update_notice_events`，其他修改需在面板编辑，不能声称重复导入已更新。所有条目先校验再原子保存，超过 50 条时分批调用。

## list_notices

```json
{"query":"奖学金","limit":50,"offset":0,"sort":"newest"}
```

```json
{"deadlineWindow":"next_7_days","sort":"deadline","limit":50,"offset":0}
```

全部参数可选：`query`（最多 200 字）、`category`、`deadlineFrom`、`deadlineTo`、`deadlineWindow`、`sort`（newest/deadline）、`limit`（1—50，默认 20）、`offset`（非负整数）。日期上下限包含当天；`deadlineWindow` 与具体日期范围互斥。`deadlineWindow` 可取 today、next_7_days、this_week。

返回 `{today,timeZone,categories,notices,total,limit,offset,hasMore,filters}`。`categories` 是当前账号可用的分类名称。每条事件含 id、title、summary、recordType、participation、active、category、sourceName、sourceUrl、publishedAt、deadline、events、audience、location、excerpt；**没有完整正文**，原文为空时摘录也可能为空。关键词搜索匹配标题、摘要、正文、发布单位；一个长句不会自动拆成多个关键字。

日期筛选只看 `deadline`，不筛 `events`，空截止日期不在筛选结果中。要找活动发生日期、截止日期未知的安排或原文中的细节，应不带日期筛选分页查询并读取原文。

此工具返回 notices 记录，可能是普通事件、课程或已纳入计划的安排；不读取原个人日程库。查询两路课程的日期安排统一使用 `list_events`，按 sourceType 和真实编号选择后续工具，不因某一路查不到就重复导入。

## get_notice

```json
{"id":"使用当前查询或导入结果返回的完整编号"}
```

返回 `{today,timeZone,notice,updatedAt}`，`notice.content` 是完整原文，也可以为空；`notice.events` 是已存的结构化时间事项，根 participation 区分资料与个人安排。没有原文就说明未附原文，不要求用户补写才能保存。原文与时间不一致时明确说明差异，不悄悄改写或当作已更正数据库。事件不存在或不属于当前账号会返回错误；不能绕过权限查别的账号。工具失败、权限不足、连接中断需要如实告知，不使用旧结果冒充实时信息。

## list_events

```json
{"from":"2026-10-19","to":"2026-10-25","type":"all","recordType":"all","kind":"all","query":"","limit":200,"offset":0}
```

专门查询范围内已录入的时间，汇总 notices 的每个时间项、个人一次或周期日程、任务的计划和截止实例。`sourceType` 区分 `notice`、`event`、`task`，只用于追溯来源与选择更新工具，不能据此判断是否已参加。两路记录的 `participation` 决定是 reference 资料信息还是 planned 我的安排；只有 planned 可作为个人忙闲约束。周期返回实际发生日期的实例，不是把一条规则当成一次课；结果可能包含原周期编号及原发生日，调课必须使用工具返回的标识。

`from/to` 为有效日期，含首尾日，单次最多 366 天；省略时默认今天起七天。`type` 为 `all/once/recurring`；`recordType` 为 `all/schedule/course`，省略或 `all` 汇总全部来源及任务，`schedule` 或 `course` 筛选两路相应类型的记录，不包含任务。`kind` 为 `all/event/deadline`，另有 `query`、`limit`（1—200，默认 100）及非负 `offset`。返回 `today,timeZone,events,total,hasMore,limit,offset`；有下一页时按实际已返回数量继续分页。个人日程用 `eventId`、任务用 `taskId`、notices 记录用 `noticeId` 追溯，`id` 是实例标识，不用于修改原规则。相交的活动区间保留真实起止，不能改成窗口边界。

此工具覆盖已结构化事项。列表没有某项，不代表事件原文中从未提及；需要完整核对事件时再读事件，说明未整理正文的缺口。不用 `list_notices` 补造从未导入的课表。任务已出现在这里时，不能再把 `list_tasks` 的计划重复展示一遍。

两路记录的实例含 `recordType`（schedule 事件／course 课程）、`participation` 及归类信息。课程类型、是否周期发生和是否纳入计划彼此独立；归类与收藏不改变参与状态。`list_events` 仍是日期范围实例查询，没有新增按分类或收藏筛选的工具参数；不得把界面的分类卡片数当作实例数。无日期不产生实例，取消的记录或系列也不产生实例，不能仅凭未返回课程判断它已被删除，或凭旧版本恢复；没有可读取的最新版本时说明需在面板显示取消项后恢复。旧普通事件按 reference、旧个人日程按 planned 兼容。

## 个人日程：import_events / update_event / change_event_occurrence

```json
{"events":[{"title":"高等数学","recordType":"course","date":"2026-09-07","time":"08:00","endTime":"09:35","kind":"event","location":"A201","sourceName":"用户课表截图","sourceText":"周一，第1—16周单周，第1—2节，A201。","notes":"学期第1周周一为2026-09-07；第1节08:00—08:45，第2节08:50—09:35。","recurrence":{"until":"2026-12-27","weekdays":[1],"intervalWeeks":1,"weeks":[1,3,5,7,9,11,13,15],"excludeDates":[]}}]}
```

以上仅为格式示例，不能当作用户课表。`import_events` 每批 1—100 项，以返回的 `imported,skipped,created,duplicates` 为凭证；重复不覆盖，只有标题必填，date 未知可空，但不能填时分、结束范围或周期规则，不生成时间表实例。日程字段为 `title,recordType,participation,date,time,endDate,endTime,kind,location,notes,sourceName,sourceText,noticeId,recurrence,active,category,favorite`；返回另含 `id,version`。`recordType` 省略默认为 `schedule`，课表截图仍推荐此工具并显式传 `course`；`participation` 默认 planned，用户只是收集候选时明确传 reference。两种类型均可一次性或周期发生。默认省略 `category`，分别使用当前日程或课程默认分类（初始为“日程”“课程”，重命名后跟随，删除后回退到保留分类）；用户明确指定时才传当前账号已有名称，不能传旧分类名。`favorite` 默认为 false。个人来源不用伪造 `noticeId`；截图转写放在 `sourceText`，节次与换算依据放在 `notes`，不传真实图片文件。`recurrence: null` 为一次安排。

课程自动进入面板“全部事件”及对应分类，不需要通过另一路接口再建副本。类型、分类和收藏不改变周期规则，也不参与导入去重；重复导入不覆盖用户已修改的分类、收藏、调课、停课或取消状态。已有个人日程修改应使用 `update_event` 更新同一真实编号；notices 记录则沿用其自己的编号和更新工具，不能把 noticeId 传作 eventId。

周期规则 `recurrence` 包含 `until`、`weekdays`（周一 1 至周日 7）、`intervalWeeks`（1—52，默认 1）、`weeks`（适用周次 1—60，空数组不限）和 `excludeDates`。`date` 所在周周一为第 1 周，只发生在 `date` 至 `until` 内；间隔周与指定周次同时满足才发生。周期同日时段不跨天。结束时分需开始时分，且结束晚于开始；截止事项不能有结束范围。

```json
{"id":"真实日程编号","expectedVersion":3,"patch":{"time":"10:00","endTime":"11:35"}}
```

`update_event` 更新原个人日程库中的一次日程或整个系列；仅传用户要求修改的字段。可用 `recordType` 更改事件／课程类型，未显式指定分类且仍在原类型默认分类时，跟随到新类型默认分类；自定义分类保留。单次调课子项的类型、分类和收藏跟随父系列，不能独立修改。可用 `category` 改到当前已有分类、用 `favorite` 收藏或取消收藏、用 `participation` 按用户要求改为 reference 或 planned；这些属性与周期独立。停止整个系列可按授权更新 `active`，不能用来代替某周停课。恢复需要最新版本，不能根据旧查询猜测。

```json
{"id":"真实周期编号","expectedVersion":3,"occurrenceDate":"2026-10-19","changes":{"date":"2026-10-21","time":"10:00","endTime":"11:35","location":"A202"}}
```

`change_event_occurrence` 只调整原 `occurrenceDate` 的一次发生，`changes` 可有 `date,time,endTime,location,title`；`changes: null` 表示取消这一次，不是恢复默认，也不修改后续周。先确认原日期是该系列实际发生日，再核对目标日期和课表。详细转换及调课范围见 [课表导入与调课](course-import.md)。

## update_notice_events

```json
{"id":"真实事件编号","expectedUpdatedAt":1792396800000,"events":[{"title":"讲座","date":"2026-10-23","time":"14:00","endTime":"16:00","kind":"event","evidence":"原文明确写明10月23日14:00至16:00。"}]}
```

管理权限可修正 notices 记录的结构化时间事项及每项 recurrence。`events` 使用 `import_notices` 的 NoticeEvent 格式；这是替换整个事项数组，先读取原文（可为空）和已有数组，保留未被授权修改的其他事项及周期规则。`expectedUpdatedAt` 是本轮 `get_notice` 返回的整数 `updatedAt`，示例数值必须替换。工具仅接受 id、expectedUpdatedAt、events，不支持修改根 participation、active、分类或原文；需要时说明在面板编辑。不要通过重新导入假装更新或另建副本。

网页普通事件编辑也使用 `expectedUpdatedAt` 检测并发修改；冲突后重新读取，不覆盖其他更新。合并表单没有增加普通根属性的 Agent 更新工具。

## 个人任务：list_tasks / create_task / update_task

`list_tasks({status,query})` 返回 `{tasks,today,timeZone}`；`status` 可为 `all/todo/in_progress/done/cancelled`，省略默认 `all`。任务字段：

- `title,notes,noticeId`：任务及真实关联来源，个人任务可以没有事件。
- `status`：`todo/in_progress/done/cancelled`；`priority`：`high/normal/low`。
- `dueDate`：明确截止日；`estimatedMinutes`：预计分钟数。
- `plannedDate,plannedStartTime,plannedEndTime`：计划日期及起止时分，不能作为实际用时。
- `id,version,completedAt`：服务端返回的标识、版本和完成记录，不能伪造。

```json
{"task":{"title":"完成实验报告","status":"todo","priority":"high","dueDate":"2026-10-23","estimatedMinutes":60,"plannedDate":"2026-10-21","plannedStartTime":"19:00","plannedEndTime":"20:00"}}
```

`create_task` 以实际返回判断新增或已存在，不因重复调用就声称新增。`update_task({id,expectedVersion,patch})` 只修改授权字段，可按用户自然反馈完成、重开、取消、改计划和优先级。取消用状态，不删除；服务端维护完成记录。创建前查相关已有任务；新增或移动计划时再核对固定课程、容量与缓冲，纯状态反馈无需额外读取课表。执行边界见 [计划与任务](planning.md)。

## 时间偏好：get_preferences / update_preferences

`get_preferences({})` 返回当前账号的持久偏好及 `version`，首次为 0；首次返回的容量、缓冲、日间边界是系统默认值，不能说成用户已确认。`update_preferences({patch,expectedVersion})` 更新用户明确要求记住的字段：

- `timeZone`：`Asia/Shanghai`；`dailyCapacityMinutes`：日常可用容量；`bufferMinutes`：安排间缓冲。
- `dayStart,dayEnd`：日常安排边界；`notes`：其他已确认偏好。
- `semesterStart,semesterEnd`：学期第 1 周日期锚点和学期结束；不能从今天或常见学期推定。
- `classPeriods`：最多 30 项，每项 `{period:1,start:"08:00",end:"08:45"}`，为已确认的节次与钟表起止映射。

先读后改，保留无关字段。没有保存的长期偏好就说明缺口，不冒充已知。临时约束不自动持久化；截图已有可靠锚点、作息时可复用，但未提供的作息不能猜测。

## review_period

`review_period({from,to})` 读取最多 366 天的完成、逾期、计划安排及历史修改等复盘依据。`completed` 是目前仍完成且完成时刻落在窗口的任务，`scheduled/due` 按当前计划日或截止日落在窗口筛选；`overdue` 是查询今天的全部未完成逾期任务，不保证截止日落在复盘窗口。`statusCounts` 按返回的 `statusCountsScope` 解释；`changes` 最多 200 条，`changesTruncated` 为真时说明历史不完整。不要从当前状态伪造历史，也不能把预计分钟数、计划区间或完成时刻当作实际投入。见 [阶段复盘](reflection.md)。

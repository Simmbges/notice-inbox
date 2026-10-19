# 知会独立版 MCP 约定

实际工具发现结果优先。已连接客户端可直接调用工具，无需重新配置服务或提供密钥。

## import_notices

```json
{
  "notices": [{
    "title": "材料提交提醒",
    "content": "这里保留用户提供的完整通知原文。",
    "summary": "只根据原文生成的简要说明。",
    "category": "课程学习",
    "sourceName": "",
    "sourceUrl": "",
    "publishedAt": "",
    "deadline": "",
    "audience": "",
    "location": ""
  }]
}
```

`title` 和 `content` 必填；分类按账号自定义，初始为课程学习、校园活动、竞赛报名、校园事务、其他通知。实际以当前 MCP schema 的分类枚举或 `list_notices` 返回的 `categories` 为准，未知分类会被拒绝；需先在面板添加，不会由 Agent 导入自动创建。文本上限分别为 title 120、content 20000、summary 240、sourceName 80、sourceUrl 2000、audience/location 120 字符。两项日期为有效的 `YYYY-MM-DD` 或空字符串。过长原文不能静默截断，应说明限制后与用户确定保存方式。

成功返回 `imported`、`skipped`、`created` 和 `duplicates`，后两项包含保存编号。重复内容会跳过，不覆盖已存通知。只有日期不同但标题、正文和来源链接相同也可能判为重复；不能声称已更新旧通知。所有条目先校验再原子保存，超过 50 条时分批调用。

## list_notices

```json
{"query":"奖学金","limit":50,"offset":0,"sort":"newest"}
```

```json
{"deadlineWindow":"next_7_days","sort":"deadline","limit":50,"offset":0}
```

全部参数可选：`query`（最多 200 字）、`category`、`deadlineFrom`、`deadlineTo`、`deadlineWindow`、`sort`（newest/deadline）、`limit`（1—50，默认 20）、`offset`（非负整数）。日期上下限包含当天；`deadlineWindow` 与具体日期范围互斥。`deadlineWindow` 可取 today、next_7_days、this_week。

返回 `{today,timeZone,categories,notices,total,limit,offset,hasMore,filters}`。`categories` 是当前账号可用的分类名称。每条通知含 id、title、summary、category、sourceName、sourceUrl、publishedAt、deadline、audience、location、excerpt；**没有完整正文**。关键词搜索匹配标题、摘要、正文、发布单位；一个长句不会自动拆成多个关键字。

日期筛选只看 `deadline`，空截止日期不在筛选结果中。要找活动发生日期、截止日期未知的安排或原文中的细节，必须读取原文。

## get_notice

```json
{"id":"使用当前查询或导入结果返回的完整编号"}
```

返回 `{today,timeZone,notice}`，`notice.content` 是完整原文。通知不存在或不属于当前账号会返回错误；不能绕过权限查别的账号。工具失败、权限不足、连接中断需要如实告知，不使用旧结果冒充实时信息。

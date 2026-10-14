# 知会 · 校园通知整理

一个原生 HTML / CSS / JavaScript 的基础前端。通知保存在当前浏览器的 localStorage 中。

## 使用

直接打开 `dist/index.html` 即可使用。也可以在本目录执行：

```powershell
python -m http.server 4173 --bind 127.0.0.1 --directory dist
```

然后访问 `http://127.0.0.1:4173`。直接打开文件与通过 HTTP 打开使用不同的浏览器存储，请通过 JSON 备份迁移记录。

## 基础功能

- 手动添加、编辑、删除通知；删除后可撤销。
- 分类、全文关键词搜索、最近添加或截止日期排序。
- 全部、未读、7 天内截止、收藏视图。
- 查看完整正文和来源链接；未注明的字段保持为空。
- 当前浏览器保存记录，支持 JSON 备份导出和导入。
- 适配桌面和手机宽度。

首次打开有六条明确标注的自编示例，可以移除。它们不是实际校园通知。

## 数据与边界

这是前端基础版：目前通过手动表单录入，尚未接入 Agent、OCR、链接抓取或语音识别。摘要由使用者填写，未填时列表展示正文预览。

不同浏览器、地址和设备之间不自动同步；清理浏览器数据会移除记录，建议定期导出备份。示例、真实通知的原文与个人数据均保存在访问者当前浏览器，不随源代码发布。

备份为 `{ "version": 1, "exportedAt": "…", "notices": [...] }`，导入会按通知 id 跳过已存在记录，不覆盖当前记录。

后续 Agent 接入可以复用 `normalizeNotice` 对应的字段：title、content、summary、category、sourceName、sourceUrl、publishedAt、deadline、audience、location。日期为 YYYY-MM-DD；原文链接仅接受 HTTP / HTTPS。

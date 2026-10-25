# Chat 中的正文读取与工具发现

阅读器界面、模型上下文和模型可调用工具是三条不同的通道。看到论文标题或“全文已缓存”，不能据此认定这一轮模型已经获得正文读取工具。正文成功返回后，才可以基于论文进行总结。

## 读取入口

公开 MCP 工具明确声明 `ui.visibility: [model, app]`，不挂载阅读器 UI resource；调用正文工具不会重新打开面板。读取工具声明 readOnlyHint=true、destructiveHint=false、openWorldHint=false。上传、写批注、删除、取消等操作保留各自的写入属性。

在支持 WebMCP 的桌面宿主中，展开的阅读器还提供固定、只读的页面内工具：

| 页面内工具 | 功能 |
| --- | --- |
| `reader_read_pages` | 当前论文的本机页面文字 |
| `reader_read_full_text` | 当前论文已缓存的 MinerU 全文，支持分页和版本复用 |
| `reader_read_annotations` | 当前论文的高亮和完整评论 |
| `reader_ocr_status` | 当前论文 OCR 状态，不启动识别 |
| `reader_research_status` | 当前明确选中的研究文献状态 |
| `reader_research_annotations` | 所选研究文献之一的批注 |
| `reader_research_full_text` | 所选研究文献之一的缓存全文 |

页面内工具将 `content` 中的实际正文和 `structuredContent` 中的状态一起返回，不能只读取后者。它们仅操作当前论文或本阅读器已选的研究文献；没有通用执行器，也没有额外暴露上传或写入入口。阅读器关闭后，页面内工具随其注销。

## 验证与能力边界

- 本机 MCP 测试能确认服务端工具存在、声明正确且可以返回正文。
- AppBridge 测试能确认页面内工具通过真实工具通道返回正文和评论，分页、错误、文献范围限制有效。
- 上述测试不等同于 Chat 模型实际发现了工具。最终工具集合由宿主、对话的执行环境和插件连接状态决定。
- 当前插件依赖本机 Zotero、PDFKit 和 Python，保留 requires_local_executor；不能靠删除该标记或伪造配置，使云端直接获得本地文件。
- 官方说明本地 MCP 插件用于支持本地执行的对话。如果在 Chat 中已选中插件仍完全没有工具，需要核对宿主是否向该对话提供了本地执行/MCP；单凭标题上下文不能判断连接成功。
- 更新后完全重启桌面应用以刷新服务与工具定义。需要时用新对话验证，避免旧对话仍使用缓存的工具集合。

测试使用隔离文库和模拟 OCR。真实 Chat 的工具发现仍需在目标宿主验证，不能用“元数据可见”作为验证通过的替代。

参考：[工具可见性与返回格式](https://developers.openai.com/plugins/reference)、[桌面本地插件](https://developers.openai.com/plugins/deploy/desktop-only)、[WebMCP](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#webmcp)。

# Claude 群文件与轻办公

部署在 Claude 独立 Aurabot 数据目录的用户模块，按当前群绑定工具，不修改共享 Aurabot 源码。模块热加载即可生效。

群里 @Claude 后说“帮我总结群文件里的 XX.pdf，列出重点和待办”，或“看看有哪些群文件”。文件夹支持逐层列出。通过 NapCat 当前群文件 API 验证文件身份，不接受用户任意网址或服务器路径。下载最多12MB、20秒，解析最多25秒，临时文件请求结束删除，不执行文档宏或脚本。

支持 TXT/MD/CSV/JSON/LOG/YAML/PDF/DOCX/XLSX。PDF最多前60页，扫描件没有OCR；Word只提取正文；Excel最多10表，每表500行80列，不计算公式，保留公式及已有缓存值，日期可能为原始数值。最多返回60000字符，并标记截断。群文件目录返回最多100项；找不到文件时应让用户确认位置。暂不支持私聊附件读取、生成回传办公附件、DOC/XLS、OCR、通用Shell和任意网站浏览。

验证：`node --test work.test.mjs`。服务器已安装 poppler-utils 提供 pdftotext。工具注册使用现有social会话限制，管理员私聊仍保持chat档位。

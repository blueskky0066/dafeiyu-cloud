# OneBot 重连修复

本目录保存从项目服务器取得的原始客户端和修复版。修复版部署到 Aurabot `src/onebot/client.js`。

改动：旧连接的关闭、消息、打开事件不能影响新连接；握手10秒超时后关闭并退避重试；错误事件缺少close时仍可重试；主动停止时及时拒绝等待中的WS请求。

`node --test onebot-client.test.mjs` 验证旧事件隔离、不重复连接、握手超时、错误重试和主动停止。

部署先比较服务器文件与 original 的SHA256，备份原文件后覆盖。需要重启 dsh-web 才生效。不会删除QQ登录数据或修改模型、人格和群策略。回滚时恢复备份的客户端文件并重启 dsh-web。

2026-10-29 辅助模型调用兼容修复：llm.mjs 对应共享 Aurabot src/core/llm.js。移除写死的 low 推理档位，遵循显式配置或模型默认；默认不附加自定义temperature。若显式temperature被上游明确拒绝，仅在未收到任何输出时去掉该参数重试一次，并按provider/model缓存该限制。其他错误不重试。已备份原文件 llm.js.before-20261029，只重启Claude/Gemini服务加载，大肥鱼进程未重启。运行 node --test llm.test.mjs 验证。

## 语境学习来源补丁（2026-10-29）

hub-learning.mjs 是当时共享 Aurabot src/chat/hub.js 的完整参考版本，给 prompt 事件传递 sourceMessageIds，覆盖群聊合并、排队和 steer。不同版本应合并来源编号相关改动，不要直接覆盖其他版本的 hub.js；原仓库 plugins/aurabot-src/hub.js 仍保留。dafeiyu-social-understanding 会读取 social-learning.reference，把范围内的人工解释交给分析器。

# Gemini 订阅模型网关

通过未修改的官方 Antigravity CLI 1.4.9，使用用户主动完成的 Google OAuth 登录。服务器实测识别 Google AI Pro。旧 Gemini CLI 0.65.0 / 0.66.0 返回 UNSUPPORTED_CLIENT，因此不使用旧客户端，也不伪造客户端或绕过额度。

服务：gemini-gateway，独立系统账号与 HOME /srv/gemini-gateway，仅监听127.0.0.1:8328。私有随机网关token由服务器生成，文件600；在管理后台和机器人中单独加密/私有配置。源代码不包含OAuth凭据。CLI 自带文件/命令/网页/MCP操作全部通过显式deny规则禁用，模型仅负责生成回复或选择外层工具；外层DSH继续执行自身的会话权限检查。

模型ID gemini-subscription 为本网关别名，当前实际模型固定 gemini-3.8-flash-low，通过 /etc/systemd/system/gemini-gateway.service.d/model.conf 设置。不可据此假定Pro会员无限调用或所有模型均可访问，以官方账号实际模型列表、配额和使用条件为准。

支持 /v1/models、/v1/chat/completions。按请求传入完整外层历史，不复用CLI对话ID，避免不同QQ群串会话。文本和结构化工具调用转换；工具名限制在当前请求定义中。每次CLI运行有90秒上限、1个并发，繁忙返回429。SSE在结果完成后发出完整内容，当前不是逐token流式。不支持原生图片、音视频或二进制附件；需先由外层提取文字。max_tokens并非CLI原生生成上限，响应体与请求体另有限制。

官方CLI日志与会话存储仍由该专用账号管理，不宣称无持久化。生产systemd服务限制写入自身HOME，700MB内存加700MB swap上限。交互登录时已关闭可选的Interactions改进数据收集；CLI权限以安装后的settings.json为准。

验证：node --test gateway.test.mjs。已验证普通文本、结构化qq_chat_history工具选择；最终QQ收发须在手机号扫码后验证。QQ账号1159873127，独立DSH_HOME /srv/gemini-qqbot、runtime63484、NapCat容器napcat-gemini、WebUI6097、WS3021。

安装与身份认证文档：https://antigravity.google/docs/install/ 。不能从登录文档推断账号是否仍可调用，必须实测官方客户端。重新登录时使用服务器专用账号启动agy，完成Google官方OAuth流程，不把密码写入配置。

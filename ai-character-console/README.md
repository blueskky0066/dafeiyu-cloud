# 共栖 · AI 角色管理台

为大肥鱼、Gemini、Grok、ChatGPT 等独立 AI 角色提供一个私人管理空间。版本 0.4.1，2026-10-29。

## 0.4.1 增量

新增「理解与学习」页：聊天逐句标注、表情搜索与含义解释、表达候选确认、角色偏好/世界背景参考、召回预览与实际召回记录。需要绑定角色的 Aurabot 同时加载 social-learning 模块；图片由认证后的同角色代理提供。支持 Anthropic Messages 协议及独立运行实例注册。以下较早的功能清单描述初始版本，当前实例以运行绑定为准。

## 已实现

- 管理密码登录、一次性初始化口令、会话和请求校验。
- 创建角色；四个初始角色空间；角色资料、QQ账号登记、模型连接与凭据分别保存。
- 大肥鱼连接真实 DSH：运行状态、当前人格、长期记忆、聊天日志、群聊策略和群聊理解模块设置。
- 大肥鱼人格修改带原文冲突校验和应用预览；下一轮对话生效。
- DSH 人格、群策略与理解模块设置先保存旧配置，写入后读取实际结果核对。支持查看备份和撤销；后续有其他修改时停止撤销，失败或不确定结果保留备份并标注。
- 其他角色的独立人格、手动记忆、后台试聊与模型适配器。
- 新增 Claude 角色类型，支持通过本机 CLI 兼容网关使用用户提供的 Sonnet 模型别名；实际第三方角色仍需分别绑定 QQ 渠道。
- 模型接口支持 Gemini generateContent、Responses API、Chat Completions 兼容接口。配置已保存和运行在线分别显示。
- 乐观配置版本校验、角色级修改串行保护、历史版本恢复、管理操作日志。
- 凭据服务端 AES-256-GCM 加密，不通过查询接口返回；不会写入历史版本和操作日志。
- 手机与桌面布局，无外部字体、CDN、前端依赖或构建步骤。
- QQ 连接页：读取真实登录阶段，在后台展示自动更新的登录二维码，扫码后暂停刷新；手机授权由用户完成。
- 每15秒检查 QQ 与 DSH，只在已登录、账号匹配且聊天开关开启时尝试重连；失败后至少30秒再试，不会自动重启容器或退出账号。
- 聊天诊断页：接话判断、理解结果、回退、沉默、生成的回复与人工标注。总览可见时每15秒更新状态。

## 当前边界

目前只绑定大肥鱼的现有 DSH 运行系统。其他角色初始没有密钥、模型或 QQ 登录态；登记QQ号不会自动登录或建立消息渠道。每个新角色都需要自己的渠道适配器/网关实例，这部分尚未自动部署。

后台试聊会调用所配置的模型；不会发QQ消息、执行工具或自动写入长期记忆。大肥鱼的后台试聊读取她的当前人格和相关长期记忆，但不复现 DSH 工具链。模型选择页中大肥鱼的模型设置只用于后台试聊；对外回复模型继续由 DSH 管理。

后台对其他角色的凭据、人格、记忆、试聊进行了角色隔离测试。现有 DSH 的群聊/私聊权限和内部记忆共享规则继续由 Aurabot 管理；此后台未改造这些既有规则。

群聊理解从模块0.2.0起记录本模块指定群的新诊断，旧聊天不补造分析。最新接口返回150条，内存最多保留500条，日志文件约8MB滚动。回复按会话和最近600字输入片段关联；歧义回复单列，生成不代表QQ送达。人工标注不自动修改人格或训练模型。管理日志还记录连接状态变化，但不等于收集所有插件运行日志。

历史恢复针对后台角色资料、人格草稿和模型配置，不回滚密钥。DSH 实际人格须在人格页明确应用；DSH 人格、群策略和理解设置的恢复在「配置历史 → DSH 实际配置修改」中操作；只撤销与当前状态匹配的已确认修改。

## 运行

需要 Node.js >=22.20，使用内置 node:sqlite，首次运行先执行 `npm ci`。二维码由固定版本的 qrcode 依赖在服务器生成。

```bash
npm ci
npm start
```

默认绑定 `127.0.0.1:6380`，数据在 `.data/`。首次登录需使用 `.data/setup-token` 中的一次性口令设置至少12位管理密码。

环境变量：

| 变量 | 默认值 |
|---|---|
| HOST | 127.0.0.1 |
| PORT | 6380 |
| CONSOLE_DATA_DIR | 项目 .data/ |
| DSH_BASE_URL | http://127.0.0.1:63482 |
| BOT_DATA_DIR | /srv/dsh/plugins-data/aurabot |
| NAPCAT_WEBUI_URL | http://127.0.0.1:6099 |
| NAPCAT_CREDENTIAL_FILE | 本地运行可指定网关webui.json；生产用systemd凭据目录 |
| COOKIE_SECURE | 未设置；直接 HTTPS 部署时设为 1 |

DSH 接口地址是部署配置，浏览器不能任意代理 DSH 接口。新角色由各自模型配置连接外部服务；连接地址需 HTTPS，回环地址支持 HTTP。本机网关可不配置密钥。模型 ID 由用户填写，不把可用模型名称写死为所谓“最新”。

## 本次服务器部署

- 服务器：45.205.21.40。
- 服务：`cohabit-console.service`，开机启动，独立系统用户 `cohabit-console`。
- 源码：`/opt/cohabit-console/current`，指向 releases 中的具体版本。
- 数据：`/var/lib/cohabit-console`，其中包含 SQLite、WAL 和凭据加密密钥。
- 监听：服务器 `127.0.0.1:6380`。
- systemd 通过只读绑定挂载提供聊天日志目录，没有修改 `/srv/dsh` 的目录权限。
- DSH、本机模型网关与 QQ 网关继续使用原来的服务。
- systemd LoadCredential 将 NapCat 的 webui.json 提供给管理台服务；认证令牌只留在服务端，不返回浏览器。二维码票据不写SQLite、审计或版本历史。
- 本次对 Aurabot OneBot 客户端增加握手超时和旧连接事件隔离；原文件备份位于部署备份目录。

本机已安装登录后运行、自动重连的私有访问隧道（launchd 标签 `com.kira.cohabit-tunnel`），不会随开发任务结束而关闭。其中包含服务器127.0.0.1:8317到Mac127.0.0.1:8317的私有反向转发，供Claude模型使用；因此Claude仍依赖Mac和本机代理在线。配置位于 `~/Library/LaunchAgents/com.kira.cohabit-tunnel.plist`，日志在 `~/Library/Logs/Cohabit/`。

需要重新安装自动隧道时执行 `python3 scripts/install-access-agent.py`。停用：`launchctl bootout gui/$(id -u)/com.kira.cohabit-tunnel`。

未使用自动隧道的 Mac 可以手动建立访问隧道：

```bash
bash scripts/access.sh
```

保持这个终端运行，在浏览器访问 http://127.0.0.1:6380 。若本机6380已被占用，先确认既有隧道是否可用，不要关闭无关进程。

首次初始化口令可在服务器用管理员权限读取 `/var/lib/cohabit-console/setup-token`。初次交付时，已通过本机预览传入一次性初始化口令；需要用户自行设置管理密码。未设置默认生产密码。

服务端状态：`systemctl status cohabit-console`。日志：`journalctl -u cohabit-console`。

## 更新、备份和回滚

部署新版本放入 `/opt/cohabit-console/releases/<version>/`，然后以 root 执行该版本的 `deploy/install.sh <absolute-release-path>`。脚本将上一个源码路径记录到数据目录的 previous-release，保留数据库。

备份时应先停止 cohabit-console，再备份整个 `/var/lib/cohabit-console`（包括 encryption.key），完成后恢复服务。仅备份 SQLite 主文件可能遗漏 WAL 数据；丢失加密密钥会导致已存凭据不可读。备份包含私人数据，应存放于受控目录。

回滚源码：恢复 current 软链到上一个 release，再重启 cohabit-console。不要恢复整份 DSH 配置来回滚此后台。关闭后台只需 `systemctl disable --now cohabit-console`，大肥鱼仍由现有 DSH 服务运行。

## 验证

- `npm test`：登录与请求校验、凭据隔离、记忆隔离、跨角色删除保护、配置冲突与恢复、QQ账号唯一性、试聊隔离、群设置更新和API协议映射。
- `python3 test/browser_qa.py`：独立临时数据库，验证登录、创建角色、保存配置、人格差异预览、记忆添加与隔离、对话模式、筛选、设置、手机布局和退出。截图位于 test-results/，其中为隔离的测试环境，并非生产角色数据。
- `python3 test/browser_dsh_qa.py`：隔离环境验证 DSH 配置恢复、QQ二维码页面、诊断筛选与标注；不会让真实QQ退出或发送测试消息。
- `node scripts/integration-readonly.mjs`：只读检查实际 DSH 状态、人格、记忆、聊天和理解模块。服务器检查已读取到16条记忆、96条聊天记录、理解模块active；QQ当时处于connecting，因此页面显示“需检查”。
- 第三方模型协议经过模拟接口测试；Gemini、Grok、OpenAI 尚无此项目凭据，尚未做真实账号联调。

接口依据：[OpenAI Responses](https://developers.openai.com/api/reference/responses/overview)、[Gemini generateContent](https://ai.google.dev/api/generate-content)、[xAI Responses](https://docs.x.ai/developers/rest-api-reference/inference/responses)。

## Claude 接入状态

已创建 id=claude 的独立角色，初始人格、后台会话和记忆与其他角色分别保存；模型为用户提供并实测可用的 claude-sonnet-5-5，服务端通过私有转发访问本机CLI网关，API密钥使用现有加密存储。QQ号码尚待用户提供，暂未绑定Claude的QQ渠道，不表示QQ机器人已上线。

## Claude 独立运行环境

Claude QQ 2083346400 使用独立 claude-qqbot 服务、NapCat 容器、人格、会话和记忆目录。受信任的 runtime-bindings 将管理操作路由到各角色的本地运行系统；注册后的 QQ 账号不可通过一般配置更换。默认仅接收管理员私聊和允许群中的 @ / 名字唤醒，关闭主动插话。模型通过 Mac 的私有 SSH 反向隧道接入 Sonnet，Mac 和本地代理需要持续运行。

角色世界编辑页：已启用 claude-world 的角色可编辑 ST V2 角色卡、关键词世界书及现有会话状态。每次保存检查旧内容并记录实际运行配置备份；历史回滚遇到后续修改会阻止覆盖。模块服务负责对当前角色白名单和状态字段再次校验。

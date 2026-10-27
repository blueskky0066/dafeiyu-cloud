# 大肥鱼 · 云端部署包（2026-10-27 最新版）

一台 Linux 云服务器上跑完整套：**QQ 聊天 + 刷小黑盒 + 刷 B 站 + 表情包 + 记忆**。

## 这套东西是什么

```
你的 QQ ←→ NapCat(OneBot v11) ←→ Aurabot ←→ DSH web ←→ wb-proxy ←→ WorkBuddy 模型
                                              ↑
                                     dsh-fish（刷B站）/ heybox（刷小黑盒）
```

和原版插件相比，这份包多了这些**实机验证过的修补**：

| 问题 | 修法 | 文件 |
|---|---|---|
| DSH 只有桌面版，没有 Linux 发行版 | 从 macOS App 拷 runtime，替换 8 个 darwin 原生模块为 linux-x64 | `scripts/01-runtime.sh` |
| 国际版/国服要同时可用 | 跑两个 wb-proxy 进程（8377 国际、8378 国服） | `services/` |
| 模型报 `UNSUPPORTED_REASONING_EFFORT` | provider 里必须显式声明 `reasoningEfforts`，不能写 `false` | `profile/cordis.patch.yml` |
| 群里其他机器人刷屏 | 给 aurabot 加 `ignoreQQ` 忽略名单 | `plugins/aurabot-src/` |
| 她分享小黑盒链接 404 | 正确格式是 `/app/bbs/link/{id}`，不是 `/post/{id}` | `modules/heybox-share/` |
| 群里不能查小黑盒 | 模块去掉 `level === 'full'` 限制 | `modules/heybox-share/` |
| QQ 发卡片提示「版本过低」 | 无解（腾讯侧版本白名单），改走纯文本+链接 | `modules/heybox-share/` |

## 目录

```
profile/           DSH profile 配置（provider 路由、bundles）
plugins/aurabot-src/  改过的 aurabot 源码（hub.js / config.js / cordis.patch.yml）
modules/heybox-share/ 自定义模块：小黑盒分享
services/          systemd 单元（dsh-web / wb-proxy / wb-proxy-cn）
conf/              aurabot 配置、人格、小黑盒配置
data/              记忆、表情库索引、会话映射
scripts/           安装脚本
```

## 安装

需要：Ubuntu 22.04+、2 核 2G 起、Node 22、pnpm、ffmpeg、docker

```bash
# 1. 传上去
rsync -av fish-pkg/ user@server:/tmp/fish-pkg/

# 2. 装依赖（Node22 + pnpm + ffmpeg + docker）
bash /tmp/fish-pkg/scripts/00-deps.sh

# 3. 装 DSH runtime（从你本机 macOS App 拷）
bash /tmp/fish-pkg/scripts/01-runtime.sh

# 4. 装插件 + profile
bash /tmp/fish-pkg/scripts/02-plugins.sh

# 5. 起服务
bash /tmp/fish-pkg/scripts/03-services.sh

# 6. NapCat（QQ 网关）
bash /tmp/fish-pkg/scripts/04-napcat.sh
```

每一步都是幂等的，失败可以重跑。

## 装完之后要手动做的

1. **NapCat 扫码登录**（QQ 小号）
2. **WorkBuddy 登录**（国际版 + 国服各一次，给浏览器链接）
3. **小黑盒扫码登录**
4. **B 站 cookie**（设置 → 大肥鱼）

## 关键配置说明

### 模型路由（profile/cordis.patch.yml）

```yaml
workbuddy-intl:            # 国际版，8377
  baseURL: http://127.0.0.1:8377/v1
  models:
    - id: deepseek-v4.1-flash
      reasoningEfforts:    # ← 必须写，不能 false，否则 Aurabot 报错
        off:
        low: low
        high: high

workbuddy-cn:              # 国服，8378
  baseURL: http://127.0.0.1:8378/v1
```

默认走国际版（flash 免费）。国服唯一免费档是 `hy3`（混元）。

### 群聊策略（conf/aurabot-config.json）

```json
"group": {
  "overrides": {
    "你的群号": {
      "interjectChance": 1.0,   // 100% 插话
      "cooldownSec": 0,          // 无冷却
      "maxPerHour": 120,         // 每小时上限
      "minRelevance": 0,         // 不看话题相关度
      "quietHours": []           // 不静默
    }
  }
}
```

### 忽略名单

`ignoreQQ` 里的号发的消息不会触发她说话。用来挡群里的欢迎机器人。

## 已知限制

| 限制 | 原因 |
|---|---|
| QQ 卡片发不出去 | 腾讯校验发送方版本，Linux 上的 QQ 不在白名单 |
| 小黑盒链接没有预览 | 分享页没有 OG 标签，纯 JS 渲染 |
| 翻唱功能不可用 | 依赖 Windows 路径（`env/Scripts/python.exe`） |
| 云端不能跑桌宠 | 需要图形界面 |

## 数据位置

```
/srv/dsh/plugins-data/aurabot/     QQ 相关（表情、记忆、日志、会话）
/srv/dsh/nekowhale-stickers/       小黑盒表情库 manifest
/srv/dsh/heybox/                   小黑盒登录态和任务配置
/opt/llm-gateway/auth/             WorkBuddy 登录态（auth.json / auth-cn.json）
/srv/dsh/napcat/                   QQ 登录数据（别删，删了要重新扫码）
```

## 安全提醒

- **QQ 一定用小号**。非官方工具登录有封号风险。
- **机器人号别加重要群**，尤其别给管理权限。
- **WorkBuddy 和 B 站凭据在磁盘上是明文**，服务器被入侵就等于账号泄露。
- **反代必须加鉴权**。那个网页界面等于「用你的账号发消息」的入口。

---

## 关于 data/ 和凭据

这个仓库**不含**任何登录凭据、聊天记录、记忆数据。原因：

- `auth.json` / `auth-cn.json` 是 WorkBuddy 的 token
- `state.json` 是小黑盒的 cookie
- `memories.json` / `chatlog/` / `diary.json` 是她的聊天内容和日记

这些都在 `.gitignore` 里。要迁移数据，从旧服务器手工拷。

---

## 用之前必须改的地方

`conf/aurabot-config.json` 里是占位符，装之前换成你自己的：

| 字段 | 现在的值 | 换成 |
|---|---|---|
| `botQQ` | `YOUR_BOT_QQ` | 机器人小号 QQ |
| `ownerQQ` | `YOUR_QQ` | 你的主号 QQ |
| `allow.groups` | `["YOUR_GROUP_ID"]` | 允许她说话的群号 |
| `group.overrides` | `YOUR_GROUP_ID` | 同上，键名也要改 |
| `ignoreQQ` | `["111111111","222222222"]` | 要忽略的号（比如群里的欢迎机器人） |

## ⚠️ 关于 QQ 账号安全

**这份方案用的是非官方客户端（NapCat）登录 QQ。**

- **必须用不想要的小号**，别用主号
- 有被腾讯限制或封号的风险，这是这类工具的共同问题
- 新号在云服务器 IP 上登录，更容易触发风控（可能要短信或好友验证）
- 别一上线就高频发言，也别拿它加重要群

WorkBuddy 的代理脚本（`gateway/wb-proxy.mjs`）同理：它模拟官方客户端调接口，账号也可能被限制。

**这份代码是自用配置的备份，不是能直接分发的产品。** 用之前请确认你接受这些风险。

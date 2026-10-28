# Claude Bot 配置（1pkapi）

> 踩了 4 个坑之后的可用配置。2026-10-28 验证。

## 一、为什么不用 cpa（claude-official）

原方案是本机跑 `cli-proxy-api`，用 Claude 订阅账号的 OAuth token 冒充官方 CLI。
结果：

```json
{"error":"OAuth access token has been revoked."}
```

Anthropic 明确禁止订阅账号的 token 给第三方应用用，被检测到就吊销。
**这条路走不通，换中转站。**

## 二、provider 配置

```yaml
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: claude-gateway
    model: claude-sonnet-5-5

- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      claude-gateway:
        displayName: Claude (1pkapi)
        apiKeyEnv: CLAUDE_PROXY_KEY
        api: anthropic-messages          # ★ 原生协议，不是 openai-completions
        baseURL: https://1pkapi.com      # ★ 不带 /v1
        defaultContextWindow: 1000000
        defaultMaxTokens: 128000
        models:
          - id: claude-sonnet-5-5
            name: Claude Sonnet
            contextWindow: 1000000
            reasoningEfforts: false      # ★ 关键
```

密钥（`/srv/claude-qqbot/credentials/model.env`）：

```bash
CLAUDE_PROXY_KEY="sk-..."
```

---

## 三、四个坑，按踩的顺序

### 坑 1：token 被吊销

```
401 OAuth access token has been revoked.
```

**原因**：用 Claude 订阅账号的 OAuth token 冒充官方 CLI 调 API。

**解法**：换中转站（1pkapi）。

---

### 坑 2：404 page not found

```
404 404 page not found   code: PI_AI_ERROR
```

**原因**：`anthropic-messages` 协议会**自己拼 `/v1/messages`**。

```
配的 baseURL:  https://1pkapi.com/v1
DSH 拼的:      + /v1/messages
实际请求:      https://1pkapi.com/v1/v1/messages   ← 404
```

**验证**：
```bash
curl -o /dev/null -w "%{http_code}\n" -X POST https://1pkapi.com/v1/v1/messages ...
# → 404

curl -o /dev/null -w "%{http_code}\n" -X POST https://1pkapi.com/v1/messages ...
# → 200
```

**解法**：`baseURL` 只写到域名，**不带 `/v1`**。

> 抓包确认：配 `http://127.0.0.1:8899` 时，DSH 请求的是 `/v1/messages`。

---

### 坑 3：400 requires adaptive thinking

```
400 {"error":{"message":"claude-sonnet-5-5 requires adaptive thinking
or thinking.type=between_tools; omit thinking or use one of those modes",
"type":"invalid_request_error"}}
```

**原因**：`claude-sonnet-5-5` 这个模型**只接受 `thinking.type: adaptive`**，不接受其他值。

参考 opencode 的正确配置：
```json
"options": {
  "thinking": { "type": "adaptive" },
  "effort": "high"
}
```

**但 pi-ai 不会生成 `adaptive`** —— 它只支持 `deepseek` 这一种 thinking 格式。

**解法**：模型声明 `reasoningEfforts: false`，让请求里**干脆不带 thinking 参数**，由服务端用默认值。

---

### 坑 4：does not support reasoning effort "low"

```
provider "claude-gateway" model "claude-sonnet-5-5"
does not support reasoning effort "low"   code: UNSUPPORTED_REASONING_EFFORT
```

**原因**：两边打架。

| 位置 | 设置 |
|---|---|
| DSH 模型声明 | `reasoningEfforts: false`（不支持任何档位）|
| Aurabot 配置 | `reasoningEffort: "low"`（要传 low）|

**解法**：把 Aurabot 那边的 `low` 清掉。

改两个地方：

```json
// /srv/claude-qqbot/plugins-data/aurabot/config.json
"model": {
  "provider": "claude-gateway",
  "model": "claude-sonnet-5-5",
  "reasoningEffort": ""          // 清空
}
```

```json
// /srv/claude-qqbot/plugins-data/aurabot/sessions.json
// 每个会话的 model 字符串从 "provider::model::low" 改成 "provider::model"
```

脚本：
```python
import json

p1 = '/srv/claude-qqbot/plugins-data/aurabot/config.json'
c = json.load(open(p1, encoding='utf-8'))
c['model'] = {'provider': 'claude-gateway', 'model': 'claude-sonnet-5-5', 'reasoningEffort': ''}
json.dump(c, open(p1, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

p2 = '/srv/claude-qqbot/plugins-data/aurabot/sessions.json'
s = json.load(open(p2, encoding='utf-8'))
for k, v in (s.get('chats') or {}).items():
    m = v.get('model')
    if isinstance(m, str) and '::low' in m:
        v['model'] = m.replace('::low', '')
json.dump(s, open(p2, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
```

---

## 四、验证

```bash
# 1. 服务活着
systemctl is-active claude-qqbot

# 2. 网关连上
curl -s http://127.0.0.1:63483/aurabot/api/state | grep -o '"state":"[a-z]*"'

# 3. 直连 1pkapi（确认 key 和协议对）
curl -s -X POST https://1pkapi.com/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $CLAUDE_PROXY_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-5-5","max_tokens":30,
       "messages":[{"role":"user","content":"只回四个字：通了"}]}'
```

成功的样子：

```json
{"content":[{"text":"通了","type":"text"}],"model":"claude-sonnet-5-5"}
```

---

## 五、排查方法论

这次四轮排查，可复用的思路：

1. **看会话文件拿真实错误**（不是 DSH 日志，那里常是空的）
   ```bash
   F=/srv/claude-qqbot/sessions/*/session.v4.jsonl.zstd
   zstd -dc "$F" | grep -oE '"message":"[^"]{0,300}"' | tail -3
   ```

2. **用抓包定位 URL 拼接问题**
   ```bash
   # 起一个假服务器
   node -e 'require("http").createServer((q,s)=>{console.log(q.url);s.end("{}")}).listen(8899)'
   # 把 baseURL 指过去，发条消息，看它请求什么路径
   ```

3. **顺手验证每个假设**
   - 怀疑 404 是 `?beta=true` → 直接 curl 测，200，排除
   - 怀疑是 header 问题 → 模拟完整 header，200，排除
   - 怀疑 `/v1` 重复 → 测 `/v1/v1/messages`，404，确认

**不要猜，每个假设都用 curl 打一遍。**

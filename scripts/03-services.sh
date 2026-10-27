#!/bin/bash
# 装 systemd 服务并启动
set -e
PKG="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== WorkBuddy 代理（国际 8377 / 国服 8378）==="
mkdir -p /opt/llm-gateway/auth /opt/llm-gateway/logs
mkdir -p /opt/llm-gateway
if [ ! -f /opt/llm-gateway/wb-proxy.mjs ]; then
  cp "$PKG/gateway/wb-proxy.mjs" /opt/llm-gateway/wb-proxy.mjs
fi
if [ ! -f /opt/llm-gateway/wb-proxy.mjs ]; then
  echo "⚠ 缺 /opt/llm-gateway/wb-proxy.mjs —— 这个文件不在包里，需要你自己从原来的机器拷过来"
  echo "  它是个单文件脚本，负责把 WorkBuddy 转成 OpenAI 兼容接口"
  exit 1
fi

cp "$PKG/services/wb-proxy.service" /etc/systemd/system/
cp "$PKG/services/wb-proxy-cn.service" /etc/systemd/system/

echo "=== DSH web ==="
mkdir -p /srv/dsh/logs
cp "$PKG/services/dsh-web.service" /etc/systemd/system/

# 补两个 key 的环境变量（wb-proxy 不校验，但要非空）
grep -q WB_PROXY_KEY /etc/systemd/system/dsh-web.service || \
  sed -i '/Environment=TZ=/i\Environment=WB_PROXY_KEY=local-no-auth\nEnvironment=WB_PROXY_CN_KEY=local-no-auth' \
  /etc/systemd/system/dsh-web.service

systemctl daemon-reload
systemctl enable --now wb-proxy 2>/dev/null || systemctl restart wb-proxy
systemctl enable --now dsh-web 2>/dev/null || systemctl restart dsh-web

sleep 20
echo "=== 状态 ==="
systemctl is-active wb-proxy dsh-web
ss -tlnp | grep -E '8377|8378|63482'
echo
echo "⚠ 还没登录 WorkBuddy，模型调不通。跑登录："
echo "   cd /opt/llm-gateway"
echo "   WB_ENDPOINT=https://www.workbuddy.ai node wb-proxy.mjs login --as intl"
echo "   WB_ENDPOINT=https://www.workbuddy.cn node wb-proxy.mjs login --as cn"
echo "   国服的 token 会存到 ~/.wb-proxy/auth-cn.json，要移到 /opt/llm-gateway/auth/"

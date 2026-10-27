#!/bin/bash
# NapCat：QQ 网关
set -e
DIR=/srv/dsh/napcat
mkdir -p "$DIR"/data/{qq,config,plugins}
cd "$DIR"

TOKEN=$(openssl rand -hex 24)

cat > docker-compose.yml <<EOF
services:
  napcat:
    image: mlikiowa/napcat-docker:latest
    container_name: napcat
    restart: unless-stopped
    environment:
      - TZ=Asia/Shanghai
      - MODE=ws
      - WEBUI_TOKEN=$TOKEN
    ports:
      - "127.0.0.1:6099:6099"
      - "127.0.0.1:3000:3000"
      - "127.0.0.1:3001:3001"
    volumes:
      - ./data/qq:/app/.config/QQ
      - ./data/config:/app/napcat/config
      - ./data/plugins:/app/napcat/plugins
EOF

docker compose pull
docker compose up -d
sleep 30

echo "=== WEBUI_TOKEN ==="
echo "$TOKEN"
echo
echo "=== 二维码 ==="
docker cp napcat:/app/napcat/cache/qrcode.png /tmp/qq-qr.png 2>/dev/null && \
  echo "二维码在 /tmp/qq-qr.png，scp 下来扫" || echo "还没生成，等一会再看 docker logs napcat"
echo
echo "=== 登录后还要做的 ==="
echo "1. WebUI (SSH 隧道 ssh -L 6099:127.0.0.1:6099) 里开 OneBot HTTP 3000 + WS 3001"
echo "2. Aurabot 面板填 httpUrl=http://127.0.0.1:3000 wsUrl=ws://127.0.0.1:3001"
echo "   autoStart / autoAttach 必须关！"

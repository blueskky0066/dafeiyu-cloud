#!/bin/bash
# 装基础依赖：Node 22 + pnpm + ffmpeg + docker
set -e

echo "=== 检查 Node ==="
if ! command -v node >/dev/null; then
  V=22.20.0
  cd /usr/local
  curl -fsSL --retry 3 -o /tmp/node22.tar.xz "https://npmmirror.com/mirrors/node/v$V/node-v$V-linux-x64.tar.xz" \
    || curl -fsSL --retry 3 -o /tmp/node22.tar.xz "https://nodejs.org/dist/v$V/node-v$V-linux-x64.tar.xz"
  tar -xJf /tmp/node22.tar.xz -C /usr/local
  mv /usr/local/node-v$V-linux-x64 /usr/local/nodejs22
  mkdir -p /usr/local/node22bin
  for b in node npm npx; do ln -sf /usr/local/nodejs22/bin/$b /usr/local/node22bin/$b; done
  echo 'export PATH=/usr/local/node22bin:$PATH' > /etc/profile.d/node22.sh
  echo "Node 22 装好了"
else
  echo "已有 node: $(node -v)"
fi

export PATH=/usr/local/node22bin:$PATH

echo "=== pnpm ==="
if [ ! -x /usr/local/nodejs22/lib/node_modules/pnpm/bin/pnpm.mjs ]; then
  npm i -g pnpm@11
fi
cat > /usr/local/bin/pnpm <<'EOF'
#!/bin/sh
exec /usr/local/nodejs22/bin/node /usr/local/nodejs22/lib/node_modules/pnpm/bin/pnpm.mjs "$@"
EOF
chmod +x /usr/local/bin/pnpm

echo "=== ffmpeg / unzip / curl ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg unzip curl git >/dev/null

echo "=== docker ==="
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

echo "=== swap（2G，防 OOM）==="
if ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "swap 加好了"
fi

echo "=== 时区 ==="
timedatectl set-timezone Asia/Shanghai 2>/dev/null || true

echo "=== 完成 ==="
node -v; pnpm -v; ffmpeg -version | head -1; docker --version

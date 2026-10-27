#!/bin/bash
# 装 DSH runtime：从本机 macOS App 拷贝，替换原生模块为 linux-x64
# 注意：这个脚本要在【你本机】跑，把 runtime 传上去
set -e

SERVER="${1:?用法: 01-runtime.sh user@server}"
LOCAL_APP="/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh"

echo "=== 本机打包 runtime ==="
cd "$LOCAL_APP"
COPYFILE_DISABLE=1 tar czf /tmp/dsh-full.tgz \
  --exclude='*darwin*' \
  --exclude='*/prebuilds/darwin*' \
  --exclude='*.node' \
  node_modules 2>/dev/null
ls -lh /tmp/dsh-full.tgz

echo "=== 传上去 ==="
scp /tmp/dsh-full.tgz "$SERVER:/tmp/"

echo "=== 服务器上解包 ==="
ssh "$SERVER" 'set -e
  mkdir -p /opt/dsh-runtime
  cd /opt/dsh-runtime
  tar xzf /tmp/dsh-full.tgz 2>/dev/null
  echo "解包完成: $(ls node_modules | wc -l) 个包"
'

echo "=== 装 linux 原生模块 ==="
ssh "$SERVER" 'set -e
  export PATH=/usr/local/node22bin:/usr/local/bin:$PATH
  cd /opt/dsh-runtime
  mkdir -p /tmp/nativepkg
  for p in "@img/sharp-linux-x64" "@img/sharp-libvips-linux-x64" "@koromix/koffi-linux-x64" \
           "@deepseek-ai/node-addon-system-linux-x64" "node-addon-require-builtin-linux-x64-gnu"; do
    echo "--- $p"
    npm pack "$p" --pack-destination /tmp/nativepkg >/dev/null 2>&1 || { echo "跳过 $p"; continue; }
  done
  cd /tmp/nativepkg
  for f in *.tgz; do
    rm -rf stage; mkdir -p stage
    tar xzf "$f" -C stage
    NAME=$(node -p "require(\"/tmp/nativepkg/stage/package/package.json\").name")
    DEST="/opt/dsh-runtime/node_modules/$NAME"
    mkdir -p "$(dirname "$DEST")"
    rm -rf "$DEST"; cp -r stage/package "$DEST"
    echo "装好 $NAME"
  done
'

echo "=== 建启动器 ==="
ssh "$SERVER" 'cat > /usr/local/bin/dsh <<"EOF"
#!/bin/sh
export PATH=/usr/local/node22bin:$PATH
exec /usr/local/nodejs22/bin/node /opt/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
EOF
chmod +x /usr/local/bin/dsh
dsh --version'

echo "完成"

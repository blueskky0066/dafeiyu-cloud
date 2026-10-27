#!/bin/bash
# 在服务器上装三个插件 + 建 profile
set -e
export PATH=/usr/local/node22bin:/usr/local/bin:$PATH
PKG="$(cd "$(dirname "$0")/.." && pwd)"

mkdir -p /srv/dsh/plugins
cd /srv/dsh/plugins

echo "=== 拉插件源码 ==="
for r in "ssamurias/dsh-fish:dsh-fish" "fbbDirge/dsh-xiaoheihe:heybox" "accomplish07zrh-eng/dsh-aurabot-qq:aurabot"; do
  repo="${r%%:*}"; dir="${r##*:}"
  if [ -d "$dir/.git" ]; then git -C "$dir" pull --ff-only 2>/dev/null || true
  else git clone --depth 1 "https://github.com/$repo.git" "$dir"; fi
done

echo "=== 打进修补 ==="
cp "$PKG/plugins/aurabot-src/hub.js"     aurabot/src/chat/hub.js
cp "$PKG/plugins/aurabot-src/config.js"  aurabot/src/core/config.js
cp "$PKG/plugins/aurabot-src/cordis.patch.yml" aurabot/cordis.patch.yml
node --check aurabot/src/chat/hub.js && node --check aurabot/src/core/config.js
echo "修补已应用"

echo "=== 建 profile ==="
mkdir -p /srv/dsh/profiles/web
cd /srv/dsh/profiles/web
cp "$PKG/profile/package.json" "$PKG/profile/pnpm-workspace.yaml" .
cp "$PKG/profile/cordis.patch.yml" .
mkdir -p /srv/dsh/profiles/headless
cp "$PKG/profile/cordis.patch.headless.yml" /srv/dsh/profiles/headless/cordis.patch.yml 2>/dev/null || true

CI=true pnpm install

echo "=== 装表情库 ==="
export PATH=/usr/local/bin:$PATH
pnpm add dsh-nekowhale-stickers 2>&1 | tail -3
node -e "
const fs=require('fs');const p='package.json';const d=JSON.parse(fs.readFileSync(p));
const b=d.dsh.profile.bundles;
if(!b.includes('dsh-nekowhale-stickers')) b.push('dsh-nekowhale-stickers');
fs.writeFileSync(p, JSON.stringify(d,null,2)+'\n');
console.log('bundles:', b.join(', '));
"

echo "=== 自定义模块 ==="
mkdir -p /srv/dsh/plugins-data/aurabot/modules
cp -r "$PKG/modules/heybox-share" /srv/dsh/plugins-data/aurabot/modules/

echo "=== 配置 ==="
mkdir -p /srv/dsh/plugins-data/aurabot/personas
cp "$PKG/conf/aurabot-config.json" /srv/dsh/plugins-data/aurabot/config.json
cp "$PKG/conf/persona-dafeiyu.md" /srv/dsh/plugins-data/aurabot/personas/dafeiyu.md 2>/dev/null || true
cp "$PKG/data/aurabot-sessions.json" /srv/dsh/plugins-data/aurabot/sessions.json 2>/dev/null || true

echo "完成"

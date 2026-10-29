#!/bin/bash
set -euo pipefail
if [ "$(id -u)" != 0 ]; then echo 'Run as root on the project server.' >&2; exit 1; fi
release="${1:?Pass the absolute unpacked release directory}"
case "$release" in /opt/cohabit-console/releases/*) ;; *) echo 'Unexpected release path' >&2; exit 1;; esac
[ -f "$release/server.mjs" ] && [ -f "$release/deploy/cohabit-console.service" ]
export PATH=/usr/local/node22bin:/usr/local/nodejs22/bin:/usr/local/bin:/usr/bin:/bin
if [ ! -d "$release/node_modules/qrcode" ]; then
  (cd "$release" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
fi
/usr/local/node22bin/node --check "$release/server.mjs"
if ! id cohabit-console >/dev/null 2>&1; then useradd --system --no-create-home --home-dir /var/lib/cohabit-console --shell /usr/sbin/nologin cohabit-console; fi
install -d -m 700 -o cohabit-console -g cohabit-console /var/lib/cohabit-console
if [ -L /opt/cohabit-console/current ]; then readlink /opt/cohabit-console/current > /var/lib/cohabit-console/previous-release; fi
ln -sfn "$release" /opt/cohabit-console/current
install -m 644 "$release/deploy/cohabit-console.service" /etc/systemd/system/cohabit-console.service
systemctl daemon-reload
systemctl enable --now cohabit-console
systemctl restart cohabit-console

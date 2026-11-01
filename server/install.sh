#!/bin/bash
# Установка сервера «Мастерская 3D» + «WB Аналитика» на Ubuntu 24.04.
# Запуск (от root):  curl -fsSL https://happybeetlevova-ux.github.io/sklad/server/install.sh | bash
# Повторный запуск безопасен: данные в /opt/master3d/data не трогаются, обновляется только программа.
set -e
BUNDLE="${BUNDLE:-https://happybeetlevova-ux.github.io/sklad/server/bundle.tar.gz}"
DIR="${DIR:-/opt/master3d}"
say(){ echo; echo "==> $*"; }

if [ -z "$DRYRUN" ]; then
  [ "$(id -u)" = 0 ] || { echo "Запустите от пользователя root."; exit 1; }
  say "Устанавливаю нужные программы (1–3 минуты)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y -q
  apt-get install -y -q curl ca-certificates tar nodejs
  if ! apt-get install -y -q caddy; then
    apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https gnupg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y -q && apt-get install -y -q caddy
  fi
fi
NV=$(node -e 'console.log(process.versions.node.split(".")[0])')
[ "$NV" -ge 18 ] || { echo "Нужен Node.js 18 или новее. Пересоздайте сервер с системой Ubuntu 24.04."; exit 1; }

IP="${IP:-$(curl -4 -fsS --max-time 10 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')}"
HOST="${HOST:-$(echo "$IP" | tr . -).sslip.io}"

say "Скачиваю программу сервера"
[ -n "$DRYRUN" ] || id master3d >/dev/null 2>&1 || useradd -r -m -d "$DIR" -s /usr/sbin/nologin master3d
mkdir -p "$DIR/data"
TMP=$(mktemp -d)
curl -fsSL "$BUNDLE" -o "$TMP/b.tar.gz"
tar -xzf "$TMP/b.tar.gz" -C "$TMP"
for d in app projects www; do rm -rf "$DIR/$d"; mv "$TMP/$d" "$DIR/$d"; done
rm -rf "$TMP"

if [ ! -f "$DIR/data/config.json" ]; then
  PASS=$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 12)
  cat > "$DIR/data/config.json" <<EOF
{
  "adminPass": "$PASS",
  "port": 8080,
  "publicUrl": "https://$HOST",
  "tg": {},
  "updateUrl": "$BUNDLE"
}
EOF
fi

if [ -z "$DRYRUN" ]; then
  chown -R master3d:master3d "$DIR"
  say "Настраиваю автозапуск"
  cat > /etc/systemd/system/master3d.service <<EOF
[Unit]
Description=Мастерская 3D — сервер
After=network-online.target
Wants=network-online.target

[Service]
User=master3d
WorkingDirectory=$DIR
ExecStart=$(command -v node) $DIR/app/server.js
Restart=always
RestartSec=3
Environment=TZ=Europe/Moscow

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/caddy/Caddyfile <<EOF
$HOST {
	encode gzip
	reverse_proxy 127.0.0.1:8080
}
EOF
  if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; ufw allow OpenSSH; fi
  systemctl daemon-reload
  systemctl enable master3d >/dev/null 2>&1
  systemctl restart master3d
  systemctl enable caddy >/dev/null 2>&1
  systemctl restart caddy
  sleep 4
  systemctl is-active --quiet master3d || { echo "Сервер не запустился. Покажите мне вывод: journalctl -u master3d -n 50"; exit 1; }
fi

PASS=$(node -e "console.log(require('$DIR/data/config.json').adminPass)")
echo
echo "================================================================"
echo " Готово! Сервер работает."
echo
echo " Мастерская 3D:       https://$HOST/"
echo " WB Аналитика:        https://$HOST/wb/"
echo " Страница управления: https://$HOST/admin/"
echo "   логин:  admin"
echo "   пароль: $PASS"
echo
echo " Сохраните пароль. Посмотреть его снова: cat $DIR/data/config.json"
echo " Защищённый адрес (https) появляется в течение 1–2 минут после установки."
echo "================================================================"

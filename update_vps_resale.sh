#!/bin/bash
# Update an existing VPS Resale API install on a remote host.
#
# This is the "patch deploy" companion to deploy_vps_resale.sh: it assumes the
# app is already installed at /opt/vps-resale/api (with a working .env) and just
# swaps in a new tarball, reinstalls deps, rebuilds, and restarts PM2 + nginx.
#
# USAGE (on the target host):
#   1) Upload vps-resale-api-update.tgz to /tmp
#   2) Edit the JEEPAY_* values below (or export them in the environment first)
#   3) bash update_vps_resale.sh
#
# All JEEPAY_* values default to empty; they are only written into .env if set.
# APP_BASE_URL / JEEPAY_NOTIFY_URL / JEEPAY_RETURN_URL should point at YOUR
# public domain or IP.
set -e
echo START
cp -a /opt/vps-resale/api/.env /tmp/vps-resale.env.bak
rm -rf /tmp/api-new
mkdir -p /tmp/api-new
tar -xzf /tmp/vps-resale-api-update.tgz -C /tmp/api-new
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude .env /tmp/api-new/api/ /opt/vps-resale/api/
else
  find /opt/vps-resale/api -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .env -exec rm -rf {} +
  cp -a /tmp/api-new/api/. /opt/vps-resale/api/
fi
cp /tmp/vps-resale.env.bak /opt/vps-resale/api/.env
cd /opt/vps-resale/api

# --- Merge overrides into .env. Set these in the environment before running. ---
# Example:
#   APP_BASE_URL=https://your-domain.com \
#   JEEPAY_GATEWAY_URL=https://pay.example.com \
#   JEEPAY_MCH_NO=Mxxxxx JEEPAY_APP_ID=xxxxx JEEPAY_APP_SECRET=xxxxx \
#   JEEPAY_WAY_CODE_CNY=ABA_KHQR JEEPAY_WAY_CODE_USD=PP_PC \
#   JEEPAY_NOTIFY_URL=https://your-domain.com/api/payments/jeepay/notify \
#   JEEPAY_RETURN_URL=https://your-domain.com/pay/result.html \
#   bash update_vps_resale.sh
python3 - <<'PY'
from pathlib import Path
import os
p = Path('.env')
text = p.read_text()
repl = {
    'APP_BASE_URL=':          os.environ.get('APP_BASE_URL', ''),
    'JEEPAY_GATEWAY_URL=':    os.environ.get('JEEPAY_GATEWAY_URL', ''),
    'JEEPAY_MCH_NO=':         os.environ.get('JEEPAY_MCH_NO', ''),
    'JEEPAY_APP_ID=':         os.environ.get('JEEPAY_APP_ID', ''),
    'JEEPAY_APP_SECRET=':     os.environ.get('JEEPAY_APP_SECRET', ''),
    'JEEPAY_WAY_CODE_CNY=':   os.environ.get('JEEPAY_WAY_CODE_CNY', ''),
    'JEEPAY_WAY_CODE_USD=':   os.environ.get('JEEPAY_WAY_CODE_USD', ''),
    'JEEPAY_NOTIFY_URL=':     os.environ.get('JEEPAY_NOTIFY_URL', ''),
    'JEEPAY_RETURN_URL=':     os.environ.get('JEEPAY_RETURN_URL', ''),
}
lines = []
seen = set()
for line in text.splitlines():
    hit = None
    for k, v in repl.items():
        if line.startswith(k):
            hit = k
            break
    if hit and repl[hit]:
        lines.append(f'{hit}"{repl[hit]}"')
        seen.add(hit)
    else:
        lines.append(line)
for k, v in repl.items():
    if k not in seen and v:
        lines.append(f'{k}"{v}"')
p.write_text('\n'.join(lines) + '\n')
print('env ok (masked):')
for line in p.read_text().splitlines():
    if any(x in line for x in ['SECRET', 'PASSWORD', 'PASS=']):
        print(line.split('=', 1)[0] + '=***')
    else:
        print(line)
PY

npm install --no-fund --no-audit
npx prisma generate
npx nest build
pm2 restart vps-resale-api || pm2 start dist/main.js --name vps-resale-api --cwd /opt/vps-resale/api
pm2 save
sleep 2

# --- nginx: proxy everything to the NestJS app ---
# Edit SERVER_NAME below (or export SERVER_NAME) to match your domain/IP.
SERVER_NAME="${SERVER_NAME:-_}"
cat > /etc/nginx/sites-available/vps-resale <<NGX
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name ${SERVER_NAME};
    client_max_body_size 20m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }
}
NGX
ln -sfn /etc/nginx/sites-available/vps-resale /etc/nginx/sites-enabled/vps-resale
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo '== health =='
curl -sS http://127.0.0.1:3000/api/auth/login || true
echo
curl -sS -o /dev/null -w 'index:%{http_code}\n' http://127.0.0.1:3000/ || true
curl -sS -o /dev/null -w 'loginhtml:%{http_code}\n' http://127.0.0.1:3000/login.html || true
curl -sS -o /dev/null -w 'admin:%{http_code}\n' http://127.0.0.1:3000/admin.html || true
pm2 status || true
echo DONE

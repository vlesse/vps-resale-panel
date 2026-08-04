#!/bin/bash
# One-click deploy VPS Resale API on Baidu Ubuntu VPS
# Usage:
#   1) upload this script + vps-resale-api.tgz to /tmp
#   2) bash /tmp/deploy_vps_resale.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

TGZ=${1:-/tmp/vps-resale-api.tgz}
APP_ROOT=/opt/vps-resale
APP_DIR=$APP_ROOT/api

if [[ ! -f "$TGZ" ]]; then
  echo "Missing tarball: $TGZ"
  exit 1
fi

echo "== node =="
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE 'v20|v22|v24'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "== mysql =="
apt-get install -y mysql-server mysql-client >/dev/null 2>&1 || true
systemctl start mysql || true
systemctl enable mysql || true

DB_PASS=$(openssl rand -hex 12)
JWT_SECRET=$(openssl rand -hex 24)
CRED_SECRET=$(openssl rand -hex 24)
ADMIN_PASS="Admin@$(openssl rand -hex 6)"

mysql -u root <<SQL
CREATE DATABASE IF NOT EXISTS vps_resale DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'vps'@'localhost' IDENTIFIED BY '${DB_PASS}';
ALTER USER 'vps'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON vps_resale.* TO 'vps'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "== extract =="
rm -rf "$APP_ROOT"
mkdir -p "$APP_ROOT"
tar -xzf "$TGZ" -C "$APP_ROOT"
cd "$APP_DIR"

PUBLIC_IP=$(curl -s --max-time 5 ifconfig.me || echo 120.48.131.216)

cat > .env <<EOF
DATABASE_URL="mysql://vps:${DB_PASS}@127.0.0.1:3306/vps_resale"
JWT_SECRET="${JWT_SECRET}"
JWT_EXPIRES_IN="7d"
PORT=3000
APP_BASE_URL="http://${PUBLIC_IP}"
CREDENTIALS_SECRET="${CRED_SECRET}"
JEEPAY_GATEWAY_URL="https://pay.free--china.com"
JEEPAY_MCH_NO=""
JEEPAY_APP_ID=""
JEEPAY_APP_SECRET=""
JEEPAY_WAY_CODE_CNY="ABA_KHQR"
JEEPAY_WAY_CODE_USD="PP_PC"
JEEPAY_NOTIFY_URL="http://${PUBLIC_IP}/api/payments/jeepay/notify"
JEEPAY_RETURN_URL="http://${PUBLIC_IP}/pay/result"
BOOTSTRAP_ADMIN_EMAIL="admin@vps.local"
BOOTSTRAP_ADMIN_PASSWORD="${ADMIN_PASS}"
EOF
chmod 600 .env

echo "== npm install & build =="
npm install --no-fund --no-audit
npx prisma generate
npx prisma db push --accept-data-loss
npx nest build

echo "== pm2 =="
npm install -g pm2
pm2 delete vps-resale-api >/dev/null 2>&1 || true
pm2 start dist/main.js --name vps-resale-api --cwd "$APP_DIR"
pm2 save
pm2 startup systemd -u root --hp /root >/tmp/pm2-startup.txt 2>&1 || true
tail -n 1 /tmp/pm2-startup.txt | bash || true

echo "== nginx =="
apt-get install -y nginx >/dev/null 2>&1 || true
cat > /etc/nginx/sites-available/vps-resale <<'NGX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    client_max_body_size 20m;

    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGX
ln -sfn /etc/nginx/sites-available/vps-resale /etc/nginx/sites-enabled/vps-resale
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

ufw allow 80/tcp || true
ufw allow 443/tcp || true
# keep 3000 internal preferred; optional:
# ufw allow 3000/tcp || true

sleep 2
echo "== health =="
curl -s http://127.0.0.1:3000/ || true
echo
curl -s http://127.0.0.1/api/plans || true
echo
pm2 status || true

cat > /root/vps-resale-credentials.txt <<EOF
APP_DIR=${APP_DIR}
PUBLIC_IP=${PUBLIC_IP}
ADMIN_EMAIL=admin@vps.local
ADMIN_PASSWORD=${ADMIN_PASS}
DB_NAME=vps_resale
DB_USER=vps
DB_PASS=${DB_PASS}
API=http://${PUBLIC_IP}/api/plans
LOGIN=POST http://${PUBLIC_IP}/api/auth/login
ENV_FILE=${APP_DIR}/.env
NOTE=Fill JEEPAY_* in .env then: pm2 restart vps-resale-api
EOF
chmod 600 /root/vps-resale-credentials.txt

echo "======================================"
echo "DEPLOY OK"
echo "Admin: admin@vps.local / ${ADMIN_PASS}"
echo " creds file: /root/vps-resale-credentials.txt"
echo " API plans: http://${PUBLIC_IP}/api/plans"
echo "======================================"

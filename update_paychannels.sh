#!/bin/bash
set -e
cp -a /opt/vps-resale/api/.env /tmp/vps-resale.env.bak
rm -rf /tmp/api-flow
mkdir -p /tmp/api-flow
tar -xzf /tmp/vps-resale-api-flow.tgz -C /tmp/api-flow
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude .env /tmp/api-flow/api/ /opt/vps-resale/api/
else
  find /opt/vps-resale/api -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .env -exec rm -rf {} +
  cp -a /tmp/api-flow/api/. /opt/vps-resale/api/
fi
cp /tmp/vps-resale.env.bak /opt/vps-resale/api/.env
cd /opt/vps-resale/api

npm install --no-fund --no-audit
npx prisma generate
npx prisma db push --accept-data-loss
node prisma/seed-pay-channels.js
npx nest build
pm2 restart vps-resale-api --update-env
sleep 2
pm2 status
curl -sS http://127.0.0.1:3000/api/auth/login; echo
echo DONE

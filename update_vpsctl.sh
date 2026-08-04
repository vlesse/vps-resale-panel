#!/bin/bash
set -e
cp -a /opt/vps-resale/api/.env /tmp/vps-resale.env.bak
rm -rf /tmp/api-vpsctl
mkdir -p /tmp/api-vpsctl
tar -xzf /tmp/vps-resale-api-vpsctl.tgz -C /tmp/api-vpsctl
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete --exclude node_modules --exclude .env /tmp/api-vpsctl/api/ /opt/vps-resale/api/
else
  find /opt/vps-resale/api -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .env -exec rm -rf {} +
  cp -a /tmp/api-vpsctl/api/. /opt/vps-resale/api/
fi
cp /tmp/vps-resale.env.bak /opt/vps-resale/api/.env
cd /opt/vps-resale/api
npm install --no-fund --no-audit
npx prisma generate
npx prisma db push --accept-data-loss
npx nest build
pm2 restart vps-resale-api --update-env
sleep 2
curl -sS http://127.0.0.1:3000/api/auth/login; echo
pm2 status
echo DONE

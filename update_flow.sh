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

python3 - <<'PY'
from pathlib import Path
p=Path('.env')
lines=p.read_text().splitlines()
want={
 'PUBLIC_BASE_URL=':'PUBLIC_BASE_URL="http://120.48.131.216"',
 'APP_BASE_URL=':'APP_BASE_URL="http://120.48.131.216"',
 'JEEPAY_NOTIFY_URL=':'JEEPAY_NOTIFY_URL="http://120.48.131.216/api/payments/jeepay/notify"',
 'JEEPAY_RETURN_URL=':'JEEPAY_RETURN_URL="http://120.48.131.216/pay/result.html"',
 'JEEPAY_CNY_TO_KHR_RATE=':'JEEPAY_CNY_TO_KHR_RATE="560"',
 'JEEPAY_USD_TO_CNY_RATE=':'JEEPAY_USD_TO_CNY_RATE="7.2"',
 'JEEPAY_WAY_CODE_CNY=':'JEEPAY_WAY_CODE_CNY="ABA_KHQR"',
 'JEEPAY_WAY_CODE_USD=':'JEEPAY_WAY_CODE_USD="ABA_KHQR"',
 'JEEPAY_WAY_CODE_ABA_PC=':'JEEPAY_WAY_CODE_ABA_PC="ABA_PC"',
 'PAY_METHODS_ENABLED=':'PAY_METHODS_ENABLED="aba_khqr,aba_pc,crypto"',
}
out=[]; seen=set()
for line in lines:
    hit=None
    for k in want:
        if line.startswith(k):
            hit=k; break
    if hit:
        out.append(want[hit]); seen.add(hit)
    else:
        out.append(line)
for k,v in want.items():
    if k not in seen: out.append(v)
p.write_text('\n'.join(out)+'\n')
print('env patched')
for line in p.read_text().splitlines():
    if any(x in line for x in ['SECRET','PASSWORD','PASS=']):
        print(line.split('=',1)[0]+'=***')
    else:
        print(line)
PY

npm install --no-fund --no-audit
npx prisma generate
npx nest build
pm2 restart vps-resale-api --update-env
sleep 2
pm2 status
curl -sS http://127.0.0.1:3000/api/auth/login; echo
echo DONE

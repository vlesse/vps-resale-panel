#!/bin/bash
# End-to-end flow test for VPS Resale Panel.
#
# Walks: admin login -> ensure ready stock -> register buyer -> create order
#        -> pay -> simulate Jeepay notify (signed) -> verify allocation.
#
# USAGE:
#   - Set ADMIN_EMAIL / ADMIN_PASSWORD env vars (or edit defaults below).
#   - Run on the API host (or against API_BASE):
#       ADMIN_EMAIL=admin@vps.local ADMIN_PASSWORD=... bash flow_test.sh
#   - Requires: curl, python3, node, mysql client (optional, for DB check).
set -e

API_BASE="${API_BASE:-http://127.0.0.1:3000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@vps.local}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?set ADMIN_PASSWORD}"
DB_USER="${DB_USER:-vps}"
DB_PASS="${DB_PASS:-}"   # optional, for the final DB sanity check
DB_NAME="${DB_NAME:-vps_resale}"

echo "== admin login =="
TOK=$(curl -sS -X POST "$API_BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"captchaId\":\"\",\"captchaCode\":\"\"}" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("accessToken") or d)')
echo "TOKEN_OK"

echo "== ensure ready stock =="
INV=$(curl -sS "$API_BASE/api/admin/inventory?status=ready" -H "Authorization: Bearer $TOK")
READY=$(echo "$INV" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)')
echo "READY_COUNT=$READY"
if [ "$READY" = "0" ]; then
  curl -sS -X POST "$API_BASE/api/admin/inventory" \
    -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
    -d '{"code":"CC-FLOW-002","provider":"cloudcone","ip":"203.0.113.10","username":"root","password":"testpass","cpu":2,"memoryMb":2048,"diskGb":40,"region":"us-west","optimizeTags":["bbr"],"status":"ready"}'
  echo
fi

echo "== register buyer =="
EMAIL="flow$(date +%s)@test.local"
curl -sS -X POST "$API_BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"secret123\",\"captchaId\":\"\",\"captchaCode\":\"\"}" > /tmp/u.json
UTOK=$(python3 -c 'import json; print(json.load(open("/tmp/u.json"))["accessToken"])')
echo "USER=$EMAIL"

echo "== create order =="
ORDER_JSON=$(curl -sS -X POST "$API_BASE/api/orders" -H "Authorization: Bearer $UTOK" \
  -H 'Content-Type: application/json' -d '{"planId":"1","currency":"CNY"}')
echo "ORDER=$ORDER_JSON"
ONO=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["orderNo"])' "$ORDER_JSON")
echo "ONO=$ONO"

echo "== pay =="
PAY_JSON=$(curl -sS -X POST "$API_BASE/api/orders/$ONO/pay" -H "Authorization: Bearer $UTOK")
echo "PAY=$PAY_JSON"

echo "== status before notify =="
curl -sS "$API_BASE/api/orders/$ONO/payment-status" -H "Authorization: Bearer $UTOK"
echo

# --- Simulate Jeepay notify (signed with JEEPAY_APP_SECRET) ---
# Reads /opt/vps-resale/api/.env on the API host. If running remotely, set
# JEEPAY_APP_SECRET in the environment instead.
export ONO
node - <<'NODE'
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const envSecret = process.env.JEEPAY_APP_SECRET;
let secret = envSecret;
if (!secret) {
  try {
    const env = fs.readFileSync('/opt/vps-resale/api/.env', 'utf8');
    secret = (env.match(/JEEPAY_APP_SECRET="?([^"\n]+)"?/) || [])[1];
  } catch (_) {}
}
if (!secret) { console.error('JEEPAY_APP_SECRET not found; aborting notify'); process.exit(1); }
function sign(params, key) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (k === 'sign' || v === null || v === undefined || v === '') continue;
    parts.push(`${k}=${v}&`);
  }
  parts.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return crypto.createHash('md5').update(parts.join('') + 'key=' + key).digest('hex').toUpperCase();
}
const body = {
  mchOrderNo: process.env.ONO,
  payOrderId: 'TESTPAY' + Date.now(),
  state: '2',
  amount: '1',
  reqTime: String(Date.now()),
};
body.sign = sign(body, secret);
const data = JSON.stringify(body);
const base = process.env.API_BASE || 'http://127.0.0.1:3000';
const u = new URL(base);
const req = http.request(
  { hostname: u.hostname, port: u.port || 80, path: '/api/payments/jeepay/notify', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
  (res) => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>console.log('NOTIFY_RESP', res.statusCode, d)); },
);
req.write(data); req.end();
NODE

sleep 1
echo "== status after notify =="
curl -sS "$API_BASE/api/orders/$ONO/payment-status" -H "Authorization: Bearer $UTOK"
echo

if [ -n "$DB_PASS" ]; then
  mysql -u"$DB_USER" -p"$DB_PASS" "$DB_NAME" -e \
    "SELECT order_no,status FROM orders ORDER BY id DESC LIMIT 5; \
     SELECT service_no,user_id,status FROM services ORDER BY id DESC LIMIT 5; \
     SELECT code,status FROM inventory_servers;"
fi
echo "FLOW_TEST_DONE"

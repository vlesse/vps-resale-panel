# Baidu VPS deployment notes

## Live

- Host: `120.48.131.216`
- App dir: `/opt/vps-resale/api`
- Process: `pm2 list` → `vps-resale-api`
- Nginx: port 80 reverse proxy → `127.0.0.1:3000`
- Public:
  - `http://120.48.131.216/`
  - `http://120.48.131.216/api/plans`
  - `POST http://120.48.131.216/api/auth/login`

## Credentials

See local file `deploy-baidu-live.txt` and server `/root/vps-resale-credentials.txt`.

## Jeepay (configured)

- Gateway: `https://pay.free--china.com`
- wayCode: `ABA_KHQR`
- CNY list price converted to **KHR** with `JEEPAY_CNY_TO_KHR_RATE=560` (same idea as Xboard plugin)
- Notify URL (use IP because unregistered domain may be blocked in CN):
  - `http://120.48.131.216/api/payments/jeepay/notify`
- Return URL:
  - `http://120.48.131.216/pay/result.html`

### Flow verified on server

1. create order (blocks if no ready stock)
2. `POST /pay` -> Jeepay unifiedOrder success, returns `codeUrl` payData
3. async notify `state=2` -> payment success -> allocate inventory -> service active
4. admin `POST /api/admin/orders/:id/mark-paid` for manual complement
5. `GET /api/orders/:orderNo/payment-status` for polling

## Useful commands

```bash
pm2 status
pm2 logs vps-resale-api
pm2 restart vps-resale-api
curl -s http://127.0.0.1/api/plans
```

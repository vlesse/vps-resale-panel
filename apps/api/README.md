# VPS Resale Panel API

NestJS + Prisma + MySQL inventory-based VPS resale backend.

## Features (v0.1)

- Auth register/login (JWT), bootstrap admin on boot
- Plans with **CNY + USD monthly** prices
- Inventory CRUD + status machine
- **No stock => cannot create order**
- Order -> Jeepay `unifiedOrder` -> notify verify -> lock inventory -> deliver
- Renew orders (`RN*`) extend `expireAt`
- Services list, admin suspend/recycle, expire task endpoint

## Quick start

```bash
cd apps/api
# edit .env : DATABASE_URL + Jeepay fields

# MySQL:
# CREATE DATABASE vps_resale DEFAULT CHARSET utf8mb4;
# CREATE USER 'vps'@'localhost' IDENTIFIED BY 'vps_pass';
# GRANT ALL ON vps_resale.* TO 'vps'@'localhost';

npm install
npx prisma db push
npm run start:dev
```

Default admin (from env): `admin@example.com` / `ChangeMe123!`

## Main APIs

| Method | Path | Desc |
|--------|------|------|
| POST | /api/auth/register | Register |
| POST | /api/auth/login | Login |
| GET | /api/auth/me | Profile |
| GET | /api/plans | Public plans |
| POST | /api/orders | `{ planId, currency: CNY\|USD }` |
| POST | /api/orders/:orderNo/pay | Jeepay pay |
| POST | /api/payments/jeepay/notify | Jeepay callback |
| GET | /api/services | My services |
| POST | /api/services/:id/renew | Create renew order |
| POST | /api/admin/plans | Create plan |
| POST | /api/admin/inventory | Add server |
| POST | /api/admin/inventory/:id/status | `{ status: ready }` |
| GET | /api/admin/orders | Admin orders |
| POST | /api/admin/orders/:id/retry-allocate | Retry provision |
| POST | /api/admin/tasks/expire-services | Suspend expired |

## Jeepay

Same as your Xboard plugins:

- Gateway `POST /api/pay/unifiedOrder`
- MD5 sign (sorted `k=v&` + `key=appSecret`, upper hex)
- Notify success when `state=2`, respond plain `success`
- Amount unit: **cents**; currency `CNY` or `USD`
- wayCode from env: `JEEPAY_WAY_CODE_CNY` / `JEEPAY_WAY_CODE_USD`

## Flow

```text
Admin: inventory sourcing -> optimizing -> ready
User:  choose plan+currency -> create order (stock check) -> pay Jeepay
Notify: paid -> reserve ready server -> service active + deliver payload
Renew:  RN order pay -> expireAt +1 month
Expire: admin task or cron -> suspended
```

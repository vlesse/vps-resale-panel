/**
 * Seed pay_channels table from existing .env values (idempotent).
 * Run on the server after `prisma migrate`: node prisma/seed-pay-channels.js
 *
 * Reads these env vars (already in /opt/vps-resale/api/.env):
 *   JEEPAY_GATEWAY_URL, JEEPAY_MCH_NO, JEEPAY_APP_ID, JEEPAY_APP_SECRET
 *   JEEPAY_CNY_TO_KHR_RATE, JEEPAY_USD_TO_CNY_RATE
 *   JEEPAY_ABA_PC_CURRENCY, JEEPAY_ABA_PC_CNY_RATE (optional)
 *
 * Creates 3 channels: aba_khqr, aba_pc, crypto(TRX_USDT).
 * Credentials encrypted with CREDENTIALS_SECRET (AES-256-GCM) using the same
 * scheme as inventory auth blobs (crypto.util.encryptJson).
 */
const { PrismaClient } = require('@prisma/client');
const crypto = require('crypto');

function keyFromSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}
function encryptJson(secret, data) {
  const iv = crypto.randomBytes(12);
  const key = keyFromSecret(secret);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

async function main() {
  require('dotenv').config();
  const prisma = new PrismaClient();
  const secret = process.env.CREDENTIALS_SECRET || 'dev-secret';

  const gateway = process.env.JEEPAY_GATEWAY_URL || '';
  const mchNo = process.env.JEEPAY_MCH_NO || '';
  const appId = process.env.JEEPAY_APP_ID || '';
  const appSecret = process.env.JEEPAY_APP_SECRET || '';
  const cnyToKhr = Number(process.env.JEEPAY_CNY_TO_KHR_RATE || 560);
  const usdToCny = Number(process.env.JEEPAY_USD_TO_CNY_RATE || 7.2);
  const abaPcCurrency = (process.env.JEEPAY_ABA_PC_CURRENCY || 'USD').toUpperCase();
  const abaPcRate = Number(
    process.env.JEEPAY_ABA_PC_CNY_RATE || (abaPcCurrency === 'KHR' ? 560 : 0.14),
  );

  const jeepayCreds = encryptJson(secret, { mchNo, appId, appSecret });

  const channels = [
    {
      code: 'aba_khqr',
      name: 'ABA KHQR 扫码',
      icon: 'aba-khqr',
      channel: 'jeepay',
      wayCode: 'ABA_KHQR',
      settleCurrency: 'KHR',
      gatewayUrl: gateway,
      credentialsEncrypted: jeepayCreds,
      rate: cnyToKhr,
      usdToCnyRate: usdToCny,
      isEnabled: !!appSecret,
      sortOrder: 10,
      descText: '支付宝扫 ABA 个人码，按瑞尔金额付款（自动换算）',
      notes: 'seeded from .env',
    },
    {
      code: 'aba_pc',
      name: 'ABA PayWay',
      icon: 'aba-payway',
      channel: 'jeepay',
      wayCode: 'ABA_PC',
      settleCurrency: abaPcCurrency,
      gatewayUrl: gateway,
      credentialsEncrypted: jeepayCreds,
      rate: abaPcRate,
      usdToCnyRate: usdToCny,
      isEnabled: !!appSecret,
      sortOrder: 20,
      descText: '跳转 ABA 官方收银台（银行卡 / ABA 账户）',
      notes: 'seeded from .env',
    },
    {
      code: 'crypto',
      name: '虚拟货币 USDT',
      icon: 'crypto-usdt',
      channel: 'jeepay',
      wayCode: 'TRX_USDT',
      settleCurrency: 'USDT',
      gatewayUrl: gateway,
      credentialsEncrypted: jeepayCreds,
      rate: null,
      usdToCnyRate: usdToCny,
      isEnabled: !!appSecret,
      sortOrder: 30,
      descText: '波场链 USDT 支付（TRX_USDT）',
      notes: 'Jeepay USDT channel; wayCode editable in admin',
    },
  ];

  for (const c of channels) {
    const exists = await prisma.payChannel.findUnique({ where: { code: c.code } });
    if (exists) {
      await prisma.payChannel.update({ where: { code: c.code }, data: c });
      console.log('updated', c.code);
    } else {
      await prisma.payChannel.create({ data: c });
      console.log('created', c.code);
    }
  }
  await prisma.$disconnect();
  console.log('seed done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

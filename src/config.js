require('dotenv').config();
const { parseBookmakers } = require('./mobcashConfig');

function getFreeSpinUrl() {
  const configured = process.env.FREESPIN_URL || process.env.RENDER_EXTERNAL_URL ||
    (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '');
  if (!configured) return '';
  try {
    const url = new URL(configured);
    if (!url.pathname.replace(/\/+$/, '').endsWith('/freespin')) {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/freespin/`;
    } else {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    }
    return url.toString();
  } catch (_) {
    return configured;
  }
}

function positiveIntegerEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntegerEnv(name, fallback = 0) {
  const value = Number.parseInt(process.env[name] || '', 10);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

module.exports = {
  bot: {
    token: process.env.BOT_TOKEN || '',
    enabled: process.env.BOT_ENABLED !== '0',
    channels: {
      topup: process.env.CHANNEL_TOPUP_ID || '',
      withdraw: process.env.CHANNEL_WITHDRAW_ID || '',
    },
    requiredSubscriptions: [
      {
        id: process.env.REQUIRED_SUBSCRIPTION_CHANNEL_ID || '',
        title: 'FLASH | ИНФО',
        url: 'https://t.me/+5puxKpw0Du4zZGRi',
      },
    ],
    bannerPhotoId: process.env.BANNER_PHOTO_ID || null,
    freeSpinUrl: getFreeSpinUrl(),
  },
  admin: {
    telegramIds: (process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n)),
  },
  database: {
    path: process.env.DB_PATH || './data/gkassa.db',
  },
  paymentAutomation: {
    deviceToken: process.env.PAYMENT_DEVICE_TOKEN || '',
    optimaPackageName: process.env.OPTIMA_PACKAGE_NAME || 'kz.optimabank.optima24',
    orderTtlMinutes: positiveIntegerEnv('ORDER_TTL_MINUTES', 10),
    reservationGraceMinutes: positiveIntegerEnv('ORDER_GRACE_MINUTES', 30),
    // Fail closed until the operator explicitly chooses an amount threshold.
    autoConfirmMaxSom: positiveIntegerEnv('AUTO_CONFIRM_MAX_SOM', 0),
    operatorManualMaxSom: nonNegativeIntegerEnv('OPERATOR_MANUAL_MAX_SOM', 0),
    operatorDailyLimitSom: nonNegativeIntegerEnv('OPERATOR_DAILY_LIMIT_SOM', 0),
  },
  mobcash: {
    enabled: process.env.MOBCASH_ENABLED === '1',
    dryRun: process.env.MOBCASH_DRY_RUN === '1',
    bookmakers: parseBookmakers(process.env),
  },
  isDevelopment: process.env.NODE_ENV !== 'production',
};

require('dotenv').config();

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
      {
        id: process.env.REQUIRED_SUBSCRIPTION_GROUP_ID || '',
        title: 'FLASH | CHAT',
        url: 'https://t.me/+XhHTZNjx7JkzNzUy',
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
  isDevelopment: process.env.NODE_ENV !== 'production',
};

const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { Markup } = require('telegraf');
const config = require('./config');
const { BotSettings, Users } = require('./models');
const Spins = require('./spins');
const { tgEmoji } = require('./bot/emoji');

const PARTY_EMOJI = tgEmoji('5461151367559141950', '🎉');

function validateInitData(initData) {
  if (!config.bot.token || typeof initData !== 'string' || initData.length > 16384) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const authDate = Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(authDate)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (authDate > now + 60 || now - authDate > 3600) return null;

  const dataCheckString = [...params.entries()]
    // Bot-token HMAC validation excludes only `hash`; `signature` remains
    // part of the signed data when Telegram includes it in initData.
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.bot.token).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest();
  const actual = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;

  let user;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (_) {
    return null;
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || user.is_bot) return null;
  return user;
}

function initDataUser(req, res, next) {
  if (BotSettings.get('bot_paused', '0') === '1') {
    return res.status(503).json({ error: 'Бот на паузе ⛔' });
  }
  const initData = req.get('x-telegram-init-data') || '';
  const user = validateInitData(initData);
  if (!user) return res.status(401).json({ error: 'Откройте фриспин из Telegram.' });
  req.telegramUser = user;
  return next();
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

async function notifyPrize(bot, result) {
  if (!result.amount || !bot) return;
  const winner = Spins.getPrizeWinner(result.id);
  if (!winner) return;
  const name = escapeHtml(winner.first_name || winner.username || winner.telegram_id);
  const username = winner.username ? `@${escapeHtml(winner.username.replace(/^@/, ''))}` : 'не указан';
  await bot.telegram.sendMessage(
    winner.telegram_id,
    `${PARTY_EMOJI} Поздравляем! Вы выиграли <b>${result.amount} сом</b> во фриспине. Администратор свяжется с вами для выдачи приза.`,
    { parse_mode: 'HTML' }
  ).catch((err) => console.error('[FreeSpin] Failed to notify winner:', err.message));

  const adminMessage =
    `🎰 <b>Выигрыш во фриспине</b>\nПользователь: ${name}\nUsername: ${username}\n` +
    `Telegram ID: <code>${winner.telegram_id}</code>\nПриз: <b>${result.amount} сом</b>\nНужно выдать приз вручную.`;
  const contactKeyboard = Markup.inlineKeyboard([[
    Markup.button.url('💬 Связаться с победителем', `tg://user?id=${winner.telegram_id}`),
  ]]);

  if (config.bot.channels.topup) {
    try {
      await bot.telegram.sendMessage(config.bot.channels.topup, adminMessage, {
        parse_mode: 'HTML',
        ...contactKeyboard,
      });
      return;
    } catch (err) {
      console.error('[FreeSpin] Failed to post prize to top-up channel:', err.message);
    }
  }

  // If the top-up channel is not configured or is unavailable, keep the
  // existing admin notifications as a fallback so the prize is not missed.
  for (const adminId of Spins.listActiveAdminTelegramIds(config.admin.telegramIds)) {
    await bot.telegram.sendMessage(adminId, adminMessage, {
      parse_mode: 'HTML',
      ...contactKeyboard,
    }).catch((err) => console.error(`[FreeSpin] Failed to notify admin ${adminId}:`, err.message));
  }
}

function startFreeSpinServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '16kb' }));
  app.use(express.static(path.resolve(__dirname, '../public'), {
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (path.extname(filePath).toLowerCase() === '.html') {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
  app.get('/', (_req, res) => res.redirect(302, '/freespin/'));
  app.get('/health', (_req, res) => res.status(200).send('ok'));

  app.get('/api/spins', initDataUser, async (req, res) => {
    const user = Users.getByTelegramId(req.telegramUser.id);
    if (!user) return res.status(403).json({ error: 'Сначала откройте бота и нажмите /start.' });
    let botUsername = BotSettings.get('bot_username', '');
    if (!botUsername) {
      try {
        const { getBot } = require('./bots');
        const bot = getBot();
        if (bot) {
          botUsername = (await bot.telegram.getMe()).username || '';
          if (botUsername) BotSettings.set('bot_username', botUsername);
        }
      } catch (err) {
        console.error('[FreeSpin] Could not resolve bot username:', err.message);
      }
    }
    const status = Spins.getSpinStatus(req.telegramUser.id, botUsername);
    res.set('Cache-Control', 'no-store').json(status);
  });

  app.post('/api/spin', initDataUser, async (req, res) => {
    const user = Users.getByTelegramId(req.telegramUser.id);
    if (!user) return res.status(403).json({ error: 'Сначала откройте бота и нажмите /start.' });
    let result;
    try {
      result = Spins.spin(req.telegramUser.id);
    } catch (err) {
      if (err.message === 'DAILY_COOLDOWN') {
        return res.status(409).json({ error: 'Бесплатный спин появится через 24 часа.', nextDailyAt: err.nextDailyAt });
      }
      if (err.message === 'USER_NOT_FOUND') return res.status(403).json({ error: 'Пользователь не найден.' });
      console.error('[FreeSpin] Failed to create spin:', err);
      return res.status(500).json({ error: 'Не удалось выполнить спин. Попробуйте позже.' });
    }

    res.set('Cache-Control', 'no-store').json(result);
    if (result.amount > 0) {
      const { getBot } = require('./bots');
      await notifyPrize(getBot(), result);
    }
  });

  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => console.log(`[Web] FreeSpin Mini App listening on ${port}`));
  server.on('error', (err) => console.error('[Web] FreeSpin server error:', err.message));
  return server;
}

module.exports = { startFreeSpinServer, validateInitData };

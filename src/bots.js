const { Telegraf } = require('telegraf');
const config = require('./config');
const { Users, BotSettings } = require('./models');
const { isAdmin } = require('./bot/adminAuth');
const { clearUserState } = require('./bot/state');
const { setupStartHandlers } = require('./bot/handlers/start');
const { setupTopupHandlers } = require('./bot/handlers/topup');
const { setupWithdrawHandlers } = require('./bot/handlers/withdraw');
const { setupAdminCallbacks } = require('./bot/handlers/adminCallbacks');
const { setupAdminBotHandlers } = require('./bot/handlers/botAdmin');
const { setupSupportHandlers } = require('./bot/handlers/support');
const { setupReferralHandlers } = require('./bot/handlers/referrals');
const { isSubscriptionConfigured, isUserSubscribed, sendSubscriptionPrompt } = require('./bot/subscription');

const BAN_MESSAGE = '🚫 Вы забанены. Смена ника не поможет — бан привязан к вашему Telegram ID.\nОбратитесь в поддержку: @Flash_admin_kg';

let bot = null;

function setupBot() {
  if (!config.bot.token) {
    console.error('[Bot] BOT_TOKEN is not set in environment variables!');
    return null;
  }

  bot = new Telegraf(config.bot.token);

  bot.catch((err, ctx) => {
    console.error(`[Bot] Error for ${ctx?.update?.update_id}:`, err.message);
  });

  bot.use(async (ctx, next) => {
    if (!ctx.from) return next();

    Users.createOrUpdate(ctx.from.id, {
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
    });

    if (isAdmin(ctx.from.id)) return next();

    if (BotSettings.get('bot_paused', '0') === '1') {
      clearUserState(ctx.from.id);
      const pauseMessage = 'Бот на паузе <tg-emoji emoji-id="6269223265001017592">⛔</tg-emoji>';
      if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});
      await ctx.reply(pauseMessage, { parse_mode: 'HTML' }).catch(() => {});
      return;
    }

    if (Users.isBanned(ctx.from.id)) {
      clearUserState(ctx.from.id);
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery('🚫 Вы забанены', { show_alert: true }).catch(() => {});
      } else if (ctx.message) {
        await ctx.reply(BAN_MESSAGE).catch(() => {});
      }
      return;
    }

    // Let /start render the subscription gate and preserve referral payloads there.
    const isStartCommand = ctx.message?.text?.split(/\s+/, 1)[0] === '/start';
    if (!isAdmin(ctx.from.id) && isSubscriptionConfigured() && !isStartCommand &&
        !ctx.callbackQuery?.data?.startsWith('subscription_check')) {
      const subscribed = await isUserSubscribed(ctx);
      if (!subscribed) {
        if (ctx.callbackQuery) {
          await ctx.answerCbQuery('Сначала подпишитесь на канал').catch(() => {});
        }
        await sendSubscriptionPrompt(ctx);
        return;
      }
    }

    return next();
  });

  setupTopupHandlers(bot);
  setupWithdrawHandlers(bot);
  setupReferralHandlers(bot);
  setupAdminCallbacks(bot);
  setupAdminBotHandlers(bot);
  setupSupportHandlers(bot);
  // Menu hears last so topup/withdraw text handlers can next() menu buttons
  setupStartHandlers(bot);

  bot.launch().then(() => {
    console.log('[Bot] Telegram bot started successfully');
    bot.telegram.getMe().then((me) => {
      if (me.username) BotSettings.set('bot_username', me.username);
    }).catch((err) => console.error('[Bot] Failed to read bot username:', err.message));
    if (!config.bot.channels.topup || !config.bot.channels.withdraw) {
      console.warn('[Bot] CHANNEL_TOPUP_ID / CHANNEL_WITHDRAW_ID are not set');
    }
    if (!isSubscriptionConfigured()) {
      console.warn('[Bot] REQUIRED_SUBSCRIPTION_CHANNEL_ID is not set; subscription gate is disabled');
    }
    if (config.admin.telegramIds.length === 0) {
      console.warn('[Bot] ADMIN_TELEGRAM_IDS is empty');
    }
  }).catch((err) => {
    console.error('[Bot] Failed to start:', err.message);
  });

  const shutdown = async (signal) => {
    console.log(`[App] Shutting down (${signal})...`);
    if (bot) await bot.stop(signal);
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  return bot;
}

function getBot() {
  return bot;
}

module.exports = { setupBot, getBot };

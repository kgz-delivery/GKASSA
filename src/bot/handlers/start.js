const { Markup } = require('telegraf');
const config = require('../../config');
const { Users } = require('../../models');
const { mainMenuWithReply, clientKeyboard, isBackButtonText } = require('../keyboards/mainMenu');
const { askBookmaker } = require('./topup');
const { adminMenu } = require('../keyboards/adminKeyboard');
const { isAdmin } = require('../adminAuth');
const { clearUserState } = require('../state');
const { welcomeHtml, tgEmoji } = require('../emoji');
const { dropQrMessage, cancelQrCountdown } = require('../qrTimer');
const { startWithdraw } = require('./withdraw');
const { attributeReferralAndGrantSpin } = require('../../spins');
const {
  isSubscriptionConfigured,
  isUserSubscribed,
  sendSubscriptionPrompt,
  rememberStartPayload,
  takeStartPayload,
  invalidateMembership,
} = require('../subscription');
const PARTY_EMOJI = tgEmoji('5461151367559141950', '🎉');

async function replyHome(ctx, text) {
  if (isAdmin(ctx.from.id)) {
    await ctx.reply(text, Markup.removeKeyboard());
    await ctx.reply('🔐 Админ панель\n\nВыберите действие:', adminMenu());
    return;
  }
  await ctx.reply(text, mainMenuWithReply(false));
}

async function sendWelcome(ctx, user) {
  const inlineKeyboard = config.bot.freeSpinUrl
    ? Markup.inlineKeyboard([[Markup.button.webApp('Free Spin⚡', config.bot.freeSpinUrl)]])
    : undefined;
  await ctx.replyWithHTML(welcomeHtml(user), inlineKeyboard);
  await ctx.replyWithHTML('<tg-emoji emoji-id="5258203794772085854">⚡️</tg-emoji>', mainMenuWithReply(false));
}

async function startHandler(ctx, explicitPayload = '') {
  const from = ctx.from;
  const payload = explicitPayload || ctx.startPayload || String(ctx.message?.text || '').trim().split(/\s+/)[1] || '';
  if (!isAdmin(from.id) && isSubscriptionConfigured() && !await isUserSubscribed(ctx)) {
    rememberStartPayload(from.id, payload);
    await sendSubscriptionPrompt(ctx);
    return;
  }

  await dropQrMessage(from.id);
  clearUserState(from.id);
  Users.createOrUpdate(from.id, {
    username: from.username,
    first_name: from.first_name,
    last_name: from.last_name,
  });
  // A global middleware creates/updates users before this handler runs.
  // Attribute the invite and grant one signup spin only once.
  const match = String(payload).match(/^ref_(\d{5,})$/);
  if (match) {
    const reward = attributeReferralAndGrantSpin(from.id, Number(match[1]));
    if (reward.referralGranted && reward.referrerTelegramId) {
      await ctx.telegram.sendMessage(
        reward.referrerTelegramId,
        `${PARTY_EMOJI} Ваш друг присоединился по ссылке. Вам начислен 1 спин! Ещё 1 спин получите после 100 сом подтверждённых пополнений друга.`,
        { parse_mode: 'HTML' }
      ).catch((err) => console.error('[Referral] Failed to notify inviter:', err.message));
    }
  }

  if (isAdmin(from.id)) {
    await ctx.reply('🔐 Админ панель', Markup.removeKeyboard());
    await ctx.reply('Выберите действие:', adminMenu());
    return;
  }

  if (config.bot.bannerPhotoId) {
    await ctx.replyWithPhoto(config.bot.bannerPhotoId);
  }

  await sendWelcome(ctx, from);
}

async function sendFreeSpinButton(ctx) {
  if (!config.bot.freeSpinUrl) {
    await ctx.reply('🎰 Фриспин временно не настроен.');
    return;
  }
  await ctx.reply('🎰 Открой колесо и проверь, доступен ли тебе спин:', Markup.inlineKeyboard([
    [Markup.button.webApp('🎰 Открыть фриспин', config.bot.freeSpinUrl)],
  ]));
}

function setupStartHandlers(bot) {
  bot.start((ctx) => startHandler(ctx));

  bot.action('subscription_check', async (ctx) => {
    invalidateMembership(ctx.from.id);
    if (!await isUserSubscribed(ctx, { force: true })) {
      await ctx.answerCbQuery('Подписка пока не найдена', { show_alert: true }).catch(() => {});
      await sendSubscriptionPrompt(ctx, true);
      return;
    }
    await ctx.answerCbQuery('Подписка подтверждена').catch(() => {});
    await startHandler(ctx, takeStartPayload(ctx.from.id));
  });

  bot.action('btn_back_to_menu', async (ctx) => {
    await ctx.answerCbQuery();
    await dropQrMessage(ctx.from.id);
    clearUserState(ctx.from.id);
    if (isAdmin(ctx.from.id)) {
      await ctx.reply('🔐 Админ панель\n\nВыберите действие:', adminMenu());
      return;
    }
    await sendWelcome(ctx, ctx.from);
  });

  bot.action('btn_cancel', async (ctx) => {
    await ctx.answerCbQuery();
    const expired = await cancelQrCountdown(ctx.from.id, ctx.telegram);
    clearUserState(ctx.from.id);
    if (expired) return;
    await replyHome(ctx, 'Отменено.');
  });

  bot.hears('Пополнить', async (ctx) => {
    if (isAdmin(ctx.from.id)) return;
    await dropQrMessage(ctx.from.id);
    clearUserState(ctx.from.id);
    await askBookmaker(ctx);
  });

  bot.hears('🎰 Фриспин', sendFreeSpinButton);
  bot.command('freespin', sendFreeSpinButton);

  bot.hears(isBackButtonText, async (ctx) => {
    if (isAdmin(ctx.from.id)) return;
    await dropQrMessage(ctx.from.id);
    clearUserState(ctx.from.id);
    await sendWelcome(ctx, ctx.from);
  });

  bot.hears('Поддержка', async (ctx) => {
    await dropQrMessage(ctx.from.id);
    clearUserState(ctx.from.id);
    await ctx.reply(
      `${tgEmoji('5224615432530461449', '💬')} <b>Поддержка</b>\n\n` +
        'Администратор: @Flash_admin_kg\n' +
        'Поддержка: @Flash_support_kg\n\n' +
        'Мы ответим в ближайшее время.',
      {
        parse_mode: 'HTML',
        ...clientKeyboard(),
      }
    );
  });

  bot.hears('Вывести', async (ctx) => {
    if (isAdmin(ctx.from.id)) return;
    await dropQrMessage(ctx.from.id);
    clearUserState(ctx.from.id);
    const user = Users.getByTelegramId(ctx.from.id);
    if (!user) return;
    await startWithdraw(ctx);
  });
}

module.exports = { setupStartHandlers, startHandler };

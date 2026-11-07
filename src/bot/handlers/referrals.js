const { Markup } = require('telegraf');
const path = require('path');
const config = require('../../config');
const { Users, BotSettings, PlayerIds } = require('../../models');
const { getUserState, setUserState, clearUserState } = require('../state');
const {
  siteSelectKeyboard,
  playerIdKeyboard,
  mainMenuWithReply,
  BACK_BUTTON_TEXT,
  isBackButtonText,
  isMenuButtonText,
  isSiteButtonText,
  siteIdFromButton,
} = require('../keyboards/mainMenu');
const { SITE_PROVIDERS, getSiteLabel } = require('../../providers');
const { tgEmoji } = require('../emoji');
const { createPayoutRequest, getReferralBalance, MINIMUM_REFERRAL_PAYOUT, resolvePayoutRequest } = require('../../referrals');
const { isAdmin } = require('../adminAuth');

const GIFT_EMOJI = tgEmoji('5203996991054432397', '🎁');
const WARNING_EMOJI = tgEmoji('6271786398404055377', '⚠️');
const DIAMOND_EMOJI = tgEmoji('5462902520215002477', '💎');
const PERCENT_EMOJI = tgEmoji('5224295096689651881', '💯');
const LIGHTNING_EMOJI = tgEmoji('5136685228504384954', '⚡️');
const INVITED_EMOJI = tgEmoji('5377336227533969892', '💱');
const BANK_EMOJI = tgEmoji('5375055672914246269', '🏦');
const PARTNER_EMOJI = tgEmoji('5381975814415866082', '🪙');
const REFERRAL_PROMO_IMAGE = path.resolve(__dirname, '../../../uploads/referral-promo.png');
const REFERRAL_AD_BUTTON_TEXT = 'Чотр 5 адам';
const REFERRAL_WITHDRAW_BUTTON = 'Вывести бонусы';
const REFERRAL_TOPUP_BUTTON = 'Пополнить бонусами';
const MINIMUM_BONUS_TOPUP = 10;

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatSom(value) {
  return Number(value || 0).toFixed(2);
}

function referralActionsKeyboard() {
  return Markup.keyboard([
    [{ text: REFERRAL_WITHDRAW_BUTTON, style: 'primary' }],
    [{ text: REFERRAL_TOPUP_BUTTON, style: 'primary' }],
    [{ text: BACK_BUTTON_TEXT, style: 'danger' }],
  ]).resize();
}

function referralTopupAdminKeyboard(requestId) {
  return Markup.inlineKeyboard([[
    Markup.button.callback('✅ Пополнено', `ref_topup_paid:${requestId}`),
    Markup.button.callback('❌ Отклонить', `ref_topup_reject:${requestId}`),
  ]]);
}

async function getReferralLink(ctx, telegramId) {
  let username = BotSettings.get('bot_username', '');
  if (!username) {
    const me = await ctx.telegram.getMe();
    username = me.username || '';
    if (username) BotSettings.set('bot_username', username);
  }
  return username ? `https://t.me/${username}?start=ref_${telegramId}` : null;
}

async function showInviteLink(ctx) {
  clearUserState(ctx.from.id);
  setUserState(ctx.from.id, { step: 'referral_menu' });
  const user = Users.getByTelegramId(ctx.from.id);
  if (!user) return;
  const link = await getReferralLink(ctx, ctx.from.id);
  if (!link) {
    await ctx.reply('Не удалось получить ссылку. Попробуйте позже.', referralActionsKeyboard());
    return;
  }
  const balance = getReferralBalance(user.id);
  await ctx.replyWithHTML(
    `${DIAMOND_EMOJI} Пригласи друга\n\n` +
      `Ваша персональная ссылка:\n<code>${escapeHtml(link)}</code>\n\n` +
      `Получай с каждого пополнения твоего друга 3${PERCENT_EMOJI}\n\n` +
      `${INVITED_EMOJI} Приглашено друзей: ${balance.invitedCount}\n` +
      `${LIGHTNING_EMOJI} Пополнений друзей: ${balance.depositCount}\n` +
      `${BANK_EMOJI} Сумма пополнений друзей: ${formatSom(balance.depositTotal)} KGS\n` +
      `${GIFT_EMOJI} Общий реферальный баланс: ${formatSom(balance.earned)} KGS\n\n` +
      `Минимальная сумма пополнения или вывода: ${MINIMUM_REFERRAL_PAYOUT} KGS.`,
    {
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🎁 Взять ссылку', 'referral_take_link')],
      ]),
    }
  );
  await ctx.reply('Выберите действие с реферальным балансом:', referralActionsKeyboard());
}

async function startReferralAd(ctx) {
  const userId = ctx.from.id;
  const user = Users.getByTelegramId(userId);
  if (!user) return;
  const link = await getReferralLink(ctx, userId);
  if (!link) {
    await ctx.answerCbQuery('Не удалось получить ссылку. Попробуйте позже.', { show_alert: true });
    return;
  }

  await ctx.answerCbQuery();
  await ctx.deleteMessage().catch(() => {});
  await publishReferralAd(ctx, REFERRAL_AD_BUTTON_TEXT, link);
}

async function publishReferralAd(ctx, buttonText, link) {
  await ctx.replyWithPhoto(
    { source: REFERRAL_PROMO_IMAGE },
    {
      caption: `${PARTNER_EMOJI} Пригласи друга и получай 3% с каждого пополнения!`,
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.url(buttonText, link)]]),
    }
  );
  clearUserState(ctx.from.id);
  setUserState(ctx.from.id, { step: 'referral_menu' });
}

async function askReferralBookmaker(ctx) {
  const enabledSites = SITE_PROVIDERS.filter((site) => BotSettings.isEnabled(`site:${site}`));
  if (!enabledSites.length) {
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply('Сейчас нет доступных букмекеров для вывода. Попробуйте позже.', referralActionsKeyboard());
    return;
  }
  setUserState(ctx.from.id, { step: 'referral_payout_choose_site' });
  await ctx.replyWithHTML(
    '<tg-emoji emoji-id="5796168957064912286">⭐️</tg-emoji> Выберите букмекера для вывода:',
    siteSelectKeyboard()
  );
}

async function askReferralBonusTopupBookmaker(ctx) {
  const user = Users.getByTelegramId(ctx.from.id);
  if (!user) return;
  const balance = getReferralBalance(user.id).available;
  if (balance < MINIMUM_BONUS_TOPUP) {
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply(
      `${WARNING_EMOJI} Для пополнения бонусами нужно минимум ${MINIMUM_BONUS_TOPUP} сом. Сейчас доступно ${formatSom(balance)} сом.`,
      { parse_mode: 'HTML', ...referralActionsKeyboard() }
    );
    return;
  }
  const enabledSites = SITE_PROVIDERS.filter((site) => BotSettings.isEnabled(`site:${site}`));
  if (!enabledSites.length) {
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply('Сейчас нет доступных букмекеров для пополнения. Попробуйте позже.', referralActionsKeyboard());
    return;
  }
  setUserState(ctx.from.id, { step: 'referral_bonus_topup_choose_site' });
  await ctx.replyWithHTML(
    '<tg-emoji emoji-id="5796168957064912286">⭐️</tg-emoji> Выберите букмекера для пополнения бонусами:',
    siteSelectKeyboard()
  );
}

async function askReferralBookmakerId(ctx, siteId) {
  if (!SITE_PROVIDERS.includes(siteId) || !BotSettings.isEnabled(`site:${siteId}`)) {
    await ctx.reply('Этот букмекер сейчас недоступен. Выберите другого.', siteSelectKeyboard());
    return;
  }
  setUserState(ctx.from.id, { step: 'referral_payout_ask_site_id', referral_site: siteId });
  const siteName = getSiteLabel(siteId);
  const prompt =
    `<b>${siteName}</b>\n\n` +
    `${WARNING_EMOJI} Проверьте ID ещё раз.\n` +
    `Отправьте ваш ID ${siteName} для получения выплаты:`;
  await ctx.replyWithHTML(prompt, playerIdKeyboard(PlayerIds.lastTwo(ctx.from.id, siteId)));
}

async function askReferralWithdrawCode(ctx, state, siteId) {
  setUserState(ctx.from.id, { ...state, step: 'referral_payout_ask_code', referral_site: siteId });
  await ctx.reply(
    'Введите код получения:',
    Markup.keyboard([[{ text: BACK_BUTTON_TEXT, style: 'danger' }]]).resize()
  );
}

async function askReferralWithdrawQr(ctx, state, code) {
  setUserState(ctx.from.id, { ...state, step: 'referral_payout_ask_qr', referral_withdraw_code: code });
  await ctx.replyWithHTML(
    `${tgEmoji('5381975814415866082', '🪙')}Отправьте QR-код Mbank, Bakai, Optima, Obank...`,
    Markup.keyboard([[{ text: BACK_BUTTON_TEXT, style: 'danger' }]]).resize()
  );
}

function formatCreatedAt(value) {
  return new Date(`${String(value || '').replace(' ', 'T')}Z`).toLocaleString('ru-RU');
}

async function submitReferralWithdrawal(ctx, state, photoId) {
  const user = Users.getByTelegramId(ctx.from.id);
  if (!user) return;
  if (!config.bot.channels.withdraw) {
    clearUserState(ctx.from.id);
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply('Канал выводов пока не настроен. Обратитесь к администратору.', referralActionsKeyboard());
    return;
  }
  const siteName = getSiteLabel(state.referral_site);
  const paymentDetails = `${siteName} | ID: ${state.referral_site_id} | Код: ${state.referral_withdraw_code}`;
  let request;
  try {
    request = createPayoutRequest(user.id, paymentDetails, {
      bookmaker: state.referral_site,
      bookmakerId: state.referral_site_id,
      withdrawCode: state.referral_withdraw_code,
      receiptPhotoId: photoId,
    });
  } catch (error) {
    if (error.message === 'REFERRAL_PAYOUT_MINIMUM') {
      setUserState(ctx.from.id, { step: 'referral_menu' });
      await ctx.reply(
        `${WARNING_EMOJI} Для вывода нужно минимум ${MINIMUM_REFERRAL_PAYOUT} сом. Сейчас доступно ${formatSom(error.available)} сом.`,
        { parse_mode: 'HTML', ...referralActionsKeyboard() }
      );
      return;
    }
    console.error('[Referral] Could not create payout request:', error.message);
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply('Не удалось создать заявку. Попробуйте позже.', referralActionsKeyboard());
    return;
  }

  const userName = escapeHtml(user.first_name || user.username || 'Пользователь');
  const channelMessage =
    `🔔 <b>Запрос реферального вывода ${request.request_id}</b>\n\n` +
    `👤 Пользователь: ${userName}\n` +
    `🆔 Telegram ID: <code>${user.telegram_id}</code>\n` +
    `💰 Сумма: <b>${formatSom(request.amount)} сом</b>\n` +
    `🎰 Букмекер: <b>${escapeHtml(siteName)}</b>\n` +
    `🆔 ID букмекера: <code>${escapeHtml(state.referral_site_id)}</code>\n` +
    `🔐 Код получения: <code>${escapeHtml(state.referral_withdraw_code)}</code>\n` +
    '📄 QR-код для выплаты прикреплён к сообщению\n' +
    `🕐 Создано: ${formatCreatedAt(request.created_at)}`;
  try {
    await ctx.telegram.sendPhoto(config.bot.channels.withdraw, photoId, {
      caption: channelMessage,
      parse_mode: 'HTML',
      ...referralPayoutKeyboard(request.request_id),
    });
  } catch (error) {
    console.error('[Referral] Could not send payout request to withdraw channel:', error.message);
    resolvePayoutRequest(request.request_id, 'rejected', null, 'withdraw');
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply('Не удалось отправить заявку администраторам. Баланс восстановлен; попробуйте позже.', referralActionsKeyboard());
    return;
  }

  PlayerIds.remember(ctx.from.id, state.referral_site_id, state.referral_site);
  clearUserState(ctx.from.id);
  setUserState(ctx.from.id, { step: 'referral_menu' });
  await ctx.reply(
    `✅ Заявка ${request.request_id} на ${formatSom(request.amount)} сом отправлена администраторам.`,
    referralActionsKeyboard()
  );
}

async function submitReferralBonusTopup(ctx, state, playerId) {
  const user = Users.getByTelegramId(ctx.from.id);
  if (!user) return;
  if (!config.bot.channels.topup) {
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply('Канал пополнений пока не настроен. Обратитесь к администратору.', referralActionsKeyboard());
    return;
  }
  const siteName = getSiteLabel(state.referral_site);
  let request;
  try {
    request = createPayoutRequest(user.id, `${siteName} | ID: ${playerId}`, {
      requestType: 'topup',
      minimum: MINIMUM_BONUS_TOPUP,
      bookmaker: state.referral_site,
      bookmakerId: playerId,
    });
  } catch (error) {
    if (error.message === 'REFERRAL_PAYOUT_MINIMUM') {
      setUserState(ctx.from.id, { step: 'referral_menu' });
      await ctx.reply(
        `${WARNING_EMOJI} Для пополнения бонусами нужно минимум ${MINIMUM_BONUS_TOPUP} сом. Сейчас доступно ${formatSom(error.available)} сом.`,
        { parse_mode: 'HTML', ...referralActionsKeyboard() }
      );
      return;
    }
    console.error('[Referral] Could not create bonus top-up request:', error.message);
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply('Не удалось создать заявку. Попробуйте позже.', referralActionsKeyboard());
    return;
  }

  const channelMessage =
    `🔔 <b>Запрос пополнения бонусами ${request.request_id}</b>\n\n` +
    `👤 Пользователь: ${escapeHtml(user.first_name || user.username || 'Пользователь')}\n` +
    `🆔 Telegram ID: <code>${user.telegram_id}</code>\n` +
    `💰 Сумма: <b>${formatSom(request.amount)} сом</b>\n` +
    `🎰 Букмекер: <b>${escapeHtml(siteName)}</b>\n` +
    `🆔 ID букмекера: <code>${escapeHtml(playerId)}</code>\n` +
    `🕐 Создано: ${formatCreatedAt(request.created_at)}`;
  try {
    await ctx.telegram.sendMessage(config.bot.channels.topup, channelMessage, {
      parse_mode: 'HTML',
      ...referralTopupAdminKeyboard(request.request_id),
    });
  } catch (error) {
    console.error('[Referral] Could not send bonus top-up request to channel:', error.message);
    resolvePayoutRequest(request.request_id, 'rejected', null, 'topup');
    setUserState(ctx.from.id, { step: 'referral_menu' });
    await ctx.reply('Не удалось отправить заявку администраторам. Баланс восстановлен; попробуйте позже.', referralActionsKeyboard());
    return;
  }
  PlayerIds.remember(ctx.from.id, playerId, state.referral_site);
  clearUserState(ctx.from.id);
  setUserState(ctx.from.id, { step: 'referral_menu' });
  await ctx.reply(
    `✅ Заявка ${request.request_id} на ${formatSom(request.amount)} сом отправлена администраторам.`,
    referralActionsKeyboard()
  );
}

function referralPayoutKeyboard(requestId) {
  return Markup.inlineKeyboard([[
    Markup.button.callback('✅ Выплачено', `ref_payout_paid:${requestId}`),
    Markup.button.callback('❌ Отклонить', `ref_payout_reject:${requestId}`),
  ]]);
}

function setupReferralHandlers(bot) {
  bot.hears('Пригласить друга 🎁', showInviteLink);

  bot.action('referral_take_link', startReferralAd);
  bot.hears('Запросить вывод', async (ctx) => {
    clearUserState(ctx.from.id);
    const user = Users.getByTelegramId(ctx.from.id);
    if (!user) return;
    const balance = getReferralBalance(user.id);
    if (balance.available < MINIMUM_REFERRAL_PAYOUT) {
      setUserState(ctx.from.id, { step: 'referral_menu' });
      await ctx.reply(
        `${WARNING_EMOJI} Для вывода нужно минимум ${MINIMUM_REFERRAL_PAYOUT} сом. Сейчас доступно ${formatSom(balance.available)} сом.`,
        { parse_mode: 'HTML', ...referralActionsKeyboard() }
      );
      return;
    }
    await askReferralBookmaker(ctx);
  });

  bot.on('text', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    const text = String(ctx.message.text || '').trim();
    if (text.startsWith('/')) return next();

    if (state.step === 'referral_button_text') {
      if (isMenuButtonText(text)) {
        clearUserState(ctx.from.id);
        return next();
      }
      if (!text || [...text].length > 64) {
        await ctx.reply('Текст кнопки должен содержать от 1 до 64 символов. Введите его ещё раз.');
        return;
      }
      await publishReferralAd(ctx, text, state.referral_link);
      return;
    }

    if (state.step === 'referral_menu') {
      if (isBackButtonText(text)) {
        clearUserState(ctx.from.id);
        await ctx.reply('Возврат в меню.', mainMenuWithReply(isAdmin(ctx.from.id)));
        return;
      }
      if (text === REFERRAL_WITHDRAW_BUTTON || text === 'Запросить вывод') {
        const user = Users.getByTelegramId(ctx.from.id);
        if (!user) return;
        const balance = getReferralBalance(user.id);
        if (balance.available < MINIMUM_REFERRAL_PAYOUT) {
          await ctx.reply(
            `${WARNING_EMOJI} Для вывода нужно минимум ${MINIMUM_REFERRAL_PAYOUT} сом. Сейчас доступно ${formatSom(balance.available)} сом.`,
            { parse_mode: 'HTML', ...referralActionsKeyboard() }
          );
          return;
        }
        await askReferralBookmaker(ctx);
        return;
      }
      if (text === REFERRAL_TOPUP_BUTTON) {
        await askReferralBonusTopupBookmaker(ctx);
        return;
      }
      if (isMenuButtonText(text)) {
        clearUserState(ctx.from.id);
        return next();
      }
      await ctx.reply('Выберите действие с реферальным балансом:', referralActionsKeyboard());
      return;
    }

    if (state.step === 'referral_payout_choose_site') {
      if (isBackButtonText(text)) {
        setUserState(ctx.from.id, { step: 'referral_menu' });
        await ctx.reply('Выберите действие с реферальным балансом:', referralActionsKeyboard());
        return;
      }
      if (isSiteButtonText(text)) {
        await askReferralBookmakerId(ctx, siteIdFromButton(text));
        return;
      }
      await ctx.reply('Выберите букмекера кнопкой ниже.', siteSelectKeyboard());
      return;
    }

    if (state.step === 'referral_payout_ask_site_id') {
      if (isBackButtonText(text)) {
        await askReferralBookmaker(ctx);
        return;
      }
      if (text.startsWith('/') || isMenuButtonText(text)) {
        clearUserState(ctx.from.id);
        return next();
      }
      if (!text) {
        await ctx.reply('Отправьте ID букмекера:', playerIdKeyboard(PlayerIds.lastTwo(ctx.from.id, state.referral_site)));
        return;
      }
      if (state.referral_site === '1xbet' && !/^\d{10}$/.test(text)) {
        await ctx.reply(
          `${WARNING_EMOJI} ID 1XBET должен состоять ровно из 10 цифр. Введите ID ещё раз.`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      await askReferralWithdrawCode(ctx, { ...state, referral_site_id: text }, state.referral_site);
      return;
    }

    if (state.step === 'referral_payout_ask_code') {
      if (isBackButtonText(text)) {
        await askReferralBookmakerId(ctx, state.referral_site);
        return;
      }
      if (text.startsWith('/') || isMenuButtonText(text)) {
        clearUserState(ctx.from.id);
        return next();
      }
      if (!text) {
        await ctx.reply('Введите код получения:');
        return;
      }
      await askReferralWithdrawQr(ctx, state, text);
      return;
    }

    if (state.step === 'referral_payout_ask_qr') {
      if (isBackButtonText(text)) {
        await askReferralWithdrawCode(ctx, state, state.referral_site);
        return;
      }
      if (text.startsWith('/') || isMenuButtonText(text)) {
        clearUserState(ctx.from.id);
        return next();
      }
      await ctx.reply('Отправьте QR-код именно фотографией.');
      return;
    }

    if (state.step === 'referral_bonus_topup_choose_site') {
      if (isBackButtonText(text)) {
        setUserState(ctx.from.id, { step: 'referral_menu' });
        await ctx.reply('Выберите действие с реферальным балансом:', referralActionsKeyboard());
        return;
      }
      if (isSiteButtonText(text)) {
        const siteId = siteIdFromButton(text);
        if (!SITE_PROVIDERS.includes(siteId) || !BotSettings.isEnabled(`site:${siteId}`)) {
          await ctx.reply('Этот букмекер сейчас недоступен. Выберите другого.', siteSelectKeyboard());
          return;
        }
        setUserState(ctx.from.id, { step: 'referral_bonus_topup_ask_site_id', referral_site: siteId });
        await ctx.reply(`Введите ID букмекера ${getSiteLabel(siteId)}:`, playerIdKeyboard(PlayerIds.lastTwo(ctx.from.id, siteId)));
        return;
      }
      await ctx.reply('Выберите букмекера кнопкой ниже.', siteSelectKeyboard());
      return;
    }

    if (state.step === 'referral_bonus_topup_ask_site_id') {
      if (isBackButtonText(text)) {
        await askReferralBonusTopupBookmaker(ctx);
        return;
      }
      if (text.startsWith('/') || isMenuButtonText(text)) {
        clearUserState(ctx.from.id);
        return next();
      }
      if (!text) {
        await ctx.reply('Отправьте ID букмекера:', playerIdKeyboard(PlayerIds.lastTwo(ctx.from.id, state.referral_site)));
        return;
      }
      if (state.referral_site === '1xbet' && !/^\d{10}$/.test(text)) {
        await ctx.reply(
          `${WARNING_EMOJI} ID 1XBET должен состоять ровно из 10 цифр. Введите ID ещё раз.`,
          { parse_mode: 'HTML' }
        );
        return;
      }
      await submitReferralBonusTopup(ctx, state, text);
      return;
    }

    return next();
  });

  bot.on('photo', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (state.step !== 'referral_payout_ask_qr') return next();
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    await submitReferralWithdrawal(ctx, state, photo.file_id);
  });
}

module.exports = { setupReferralHandlers };

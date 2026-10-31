const { Markup } = require('telegraf');
const path = require('path');
const fs = require('fs');
const { Users, Requisites, Transactions, PlayerIds, BotSettings } = require('../../models');
const { setUserState, getUserState, clearUserState } = require('../state');
const config = require('../../config');
const { confirmTopupKeyboard } = require('../keyboards/adminKeyboard');
const {
  mainMenuWithReply,
  qrAmountKeyboard,
  clientKeyboard,
  siteSelectKeyboard,
  SITE_EMOJI_IDS,
  playerIdKeyboard,
  isMenuButtonText,
  isBackButtonText,
  isSiteButtonText,
  siteIdFromButton,
} = require('../keyboards/mainMenu');
const { isAdmin } = require('../adminAuth');
const { SITE_PROVIDERS, providerLabel, getSiteLabel } = require('../../providers');
const { qrAmountHtml, tgEmoji } = require('../emoji');
const { QR_TTL_MS, qrCaption, startQrCountdown, stopQrCountdown, dropQrMessage } = require('../qrTimer');
const { readPaymentLinkFragmentFromTelegramPhoto } = require('../qrRequisites');

const HOURGLASS_EMOJI = tgEmoji('5386367538735104399', '⌛');
const BANK_PAYMENT_LINKS = [
  ['Mbank', 'https://app.mbank.kg/qr/'],
  ['O! Банк', 'https://api.dengi.o.kg/ru/qr/'],
  ['BAKAI', 'https://bakai24.app/'],
  ['MegaPay', 'https://megapay.kg/get'],
];

function bankPaymentKeyboard(paymentLinkFragment) {
  if (!paymentLinkFragment?.startsWith('#')) return undefined;
  const buttons = BANK_PAYMENT_LINKS.map(([label, baseUrl]) =>
    Markup.button.url(label, `${baseUrl}${paymentLinkFragment}`)
  );
  return Markup.inlineKeyboard([buttons.slice(0, 2), buttons.slice(2)]);
}

function siteGuidePath(siteId) {
  return path.join(process.cwd(), 'img', `${siteId}.jpg`);
}

async function askBookmaker(ctx) {
  setUserState(ctx.from.id, { step: 'topup_choose_site' });
  await ctx.reply(
    '<tg-emoji emoji-id="5796168957064912286">⭐️</tg-emoji> Выберите сайт для пополнения:',
    { parse_mode: 'HTML', ...siteSelectKeyboard() }
  );
}

async function askSitePaymentId(ctx, siteId) {
  if (!SITE_PROVIDERS.includes(siteId) || !BotSettings.isEnabled(`site:${siteId}`)) {
    await ctx.reply(`⚠️ ${getSiteLabel(siteId)} временно не работает. Выберите другого букмекера.`);
    await askBookmaker(ctx);
    return;
  }
  const siteName = getSiteLabel(siteId);
  const siteEmojiId = SITE_EMOJI_IDS[siteId];
  setUserState(ctx.from.id, { step: 'topup_ask_site_id', kind: 'bank_qr', provider: 'qr_bank', site: siteId });
  const prompt =
    `<tg-emoji emoji-id="${siteEmojiId}">😎</tg-emoji> <b>${siteName}</b>\n\n` +
    `<tg-emoji emoji-id="6271786398404055377">⚠️</tg-emoji> Проверьте ваш ID еще раз\n` +
    `<tg-emoji emoji-id="5366254421636298770">🚫</tg-emoji> Отменить пополнение нельзя!!\n\n` +
    `<tg-emoji emoji-id="5796515062709493586">💻</tg-emoji> Отправьте ваш ID ${siteName}`;
  const imgPath = siteGuidePath(siteId);
  const recentIds = PlayerIds.lastTwo(ctx.from.id, siteId);
  const extra = { parse_mode: 'HTML', ...playerIdKeyboard(recentIds) };
  if (fs.existsSync(imgPath)) {
    await ctx.replyWithPhoto({ source: imgPath }, { caption: prompt, ...extra });
    return;
  }
  await ctx.reply(prompt, extra);
}

async function askQrAmount(ctx) {
  await ctx.replyWithHTML(qrAmountHtml(), qrAmountKeyboard());
}

async function beginQrAmount(ctx, state) {
  const requisite = Requisites.getActiveByProvider('qr_bank');
  if (!requisite) {
    await ctx.reply(
      '⚠️ Реквизиты QR BANK пока не загружены.',
      mainMenuWithReply(isAdmin(ctx.from.id))
    );
    clearUserState(ctx.from.id);
    return;
  }
  setUserState(ctx.from.id, {
    ...state,
    step: 'topup_ask_amount',
    kind: 'bank_qr',
    provider: 'qr_bank',
    requisite_id: requisite.id,
  });
  await askQrAmount(ctx);
}

async function sendQrInvoice(ctx, state, requisite) {
  const caption = qrCaption(state.payment_id, state.amount, QR_TTL_MS);
  let paymentLinkFragment = requisite.provider === 'qr_bank'
    ? requisite.payment_link_fragment
    : null;
  if (!paymentLinkFragment && requisite.provider === 'qr_bank' && requisite.qr_code_photo_id) {
    try {
      paymentLinkFragment = await readPaymentLinkFragmentFromTelegramPhoto(
        ctx.telegram,
        requisite.qr_code_photo_id
      );
      Requisites.setPaymentLinkFragment(requisite.id, paymentLinkFragment);
    } catch (error) {
      console.error('[Topup] Could not extract bank payment links from saved QR:', error.message);
    }
  }
  const paymentKeyboard = bankPaymentKeyboard(paymentLinkFragment);
  const extra = { caption, parse_mode: 'HTML', ...(paymentKeyboard || {}) };
  let sent = null;
  let hasPhoto = false;

  if (requisite.qr_code_photo_id) {
    sent = await ctx.replyWithPhoto(requisite.qr_code_photo_id, extra);
    hasPhoto = true;
  } else if (requisite.qr_code_file) {
    const filePath = path.join(process.cwd(), requisite.qr_code_file);
    if (fs.existsSync(filePath)) {
      sent = await ctx.replyWithPhoto({ source: filePath }, extra);
      hasPhoto = true;
    }
  }

  if (!sent) {
    sent = await ctx.reply(caption, { parse_mode: 'HTML' });
  }

  startQrCountdown(ctx.telegram, {
    userId: ctx.from.id,
    chatId: ctx.chat.id,
    messageId: sent.message_id,
    paymentId: state.payment_id,
    amount: state.amount,
    hasPhoto,
    requisiteId: requisite.id,
    replyMarkup: paymentKeyboard?.reply_markup,
  });
}

async function showRequisites(ctx, state) {
  const requisite = Requisites.getActiveByProvider(state.provider || 'qr_bank');
  if (!requisite) {
    await ctx.reply(
      '⚠️ Реквизиты временно недоступны. Попробуйте позже.',
      mainMenuWithReply(isAdmin(ctx.from.id))
    );
    clearUserState(ctx.from.id);
    return;
  }

  setUserState(ctx.from.id, {
    ...state,
    step: 'topup_ask_receipt',
    requisite_id: requisite.id,
  });
  await sendQrInvoice(ctx, state, requisite);
}

async function sendToTopupChannel(ctx, { user, fileId, fileType, txn, amount, paymentId, provider, siteName }) {
  const userLink = user.username
    ? `<a href="https://t.me/${user.username}">${user.first_name || user.username}</a>`
    : `${user.first_name || user.telegram_id}`;

  const methodLabel = SITE_PROVIDERS.includes(provider) ? getSiteLabel(provider) : providerLabel(provider);

  const channelText = `
🔔 <b>Запрос пополнения #${txn.transaction_id}</b>

👤 Пользователь: ${userLink}
🆔 Telegram ID: <code>${user.telegram_id}</code>
${siteName ? `🎰 Сайт: <b>${siteName}</b>\n` : ''}🏦 Способ: <b>${methodLabel}</b>
💰 Сумма: <b>${Number(amount).toFixed(2)} сом</b>
🧾 ID: <code>${paymentId}</code>
🕐 Создано: ${new Date(txn.created_at).toLocaleString('ru-RU')}

📎 Подтверждение оплаты:
  `.trim();

  const sendOptions = {
    caption: channelText,
    parse_mode: 'HTML',
    ...confirmTopupKeyboard(txn.transaction_id),
  };

  if (fileType === 'photo') {
    await ctx.telegram.sendPhoto(config.bot.channels.topup, fileId, sendOptions);
  } else {
    await ctx.telegram.sendDocument(config.bot.channels.topup, fileId, sendOptions);
  }
}

function setupTopupHandlers(bot) {
  bot.action('btn_topup', async (ctx) => {
    await ctx.answerCbQuery();
    if (isAdmin(ctx.from.id)) return;
    await dropQrMessage(ctx.from.id);
    clearUserState(ctx.from.id);
    await askBookmaker(ctx);
  });

  bot.action('btn_back_to_sites', async (ctx) => {
    await ctx.answerCbQuery();
    if (isAdmin(ctx.from.id)) return;
    await askBookmaker(ctx);
  });

  bot.action(/^btn_site_topup:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (isAdmin(ctx.from.id)) return;
    await askSitePaymentId(ctx, ctx.match[1]);
  });

  bot.action('topup_confirm_pay', async (ctx) => {
    await ctx.answerCbQuery();
    const state = getUserState(ctx.from.id);
    if (state.step !== 'topup_confirm_receipt' || !state.receipt_file_id) {
      await ctx.reply('⚠️ Сначала отправьте чек.');
      return;
    }

    const user = Users.getByTelegramId(ctx.from.id);
    if (!user) return;

    const { transaction_id } = Transactions.create({
      user_id: user.id,
      type: 'topup',
      amount: state.amount,
      requisite_id: state.requisite_id,
      provider: state.provider,
      receipt_photo_id: state.receipt_file_type === 'photo' ? state.receipt_file_id : null,
      receipt_file: state.receipt_file_type === 'document' ? state.receipt_file_id : null,
      payment_id: state.payment_id,
      site: state.site,
    });

    const txn = Transactions.getByTransactionId(transaction_id);

    try {
      await sendToTopupChannel(ctx, {
        user,
        fileId: state.receipt_file_id,
        fileType: state.receipt_file_type,
        txn,
        amount: state.amount,
        paymentId: state.payment_id,
        provider: state.provider,
        siteName: state.site_name,
      });
    } catch (e) {
      console.error('[Bot] Failed to send to topup channel:', e.message);
      await ctx.reply('⚠️ Не удалось отправить запрос в канал. Обратитесь к администратору.');
      return;
    }

    stopQrCountdown(ctx.from.id);
    clearUserState(ctx.from.id);
    await ctx.reply(
      `${HOURGLASS_EMOJI} Запрос пополнения <b>${transaction_id}</b> отправлен.\n\nОжидайте подтверждения.`,
      { parse_mode: 'HTML', ...mainMenuWithReply(isAdmin(ctx.from.id)) }
    );
  });

  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/') || isMenuButtonText(text)) return next();

    const state = getUserState(ctx.from.id);

    if (isBackButtonText(text)) {
      if (state.step === 'topup_choose_site') {
        return next();
      }
      if (state.step === 'topup_ask_site_id') {
        await askBookmaker(ctx);
        return;
      }
      if (state.step === 'topup_ask_amount' && state.site) {
        await askSitePaymentId(ctx, state.site);
        return;
      }
      return next();
    }

    if (state.step === 'topup_choose_site' && isSiteButtonText(text)) {
      await askSitePaymentId(ctx, siteIdFromButton(text));
      return;
    }

    if (state.step === 'topup_ask_site_id') {
      const userSiteId = ctx.message.text.trim();
      if (!userSiteId) {
        await ctx.reply('Введите ваш ID:');
        return;
      }
      if (state.site === '1xbet' && !/^\d{10}$/.test(userSiteId)) {
        await ctx.reply(
          '<tg-emoji emoji-id="6271786398404055377">⚠️</tg-emoji> ID 1XBET должен состоять ровно из 10 цифр. Введите ID ещё раз:',
          { parse_mode: 'HTML' }
        );
        return;
      }
      const siteName = getSiteLabel(state.site);
      PlayerIds.remember(ctx.from.id, userSiteId, state.site);
      await beginQrAmount(ctx, {
        ...state,
        payment_id: userSiteId,
        site_name: siteName,
      });
      return;
    }

    if (state.step === 'topup_ask_amount') {
      const amount = parseFloat(String(ctx.message.text).replace(',', '.'));
      if (Number.isNaN(amount) || amount <= 0) {
        await ctx.reply('⚠️ Введите корректную сумму:');
        return;
      }
      if (amount < 10 || amount > 10000) {
        await ctx.reply('⚠️ Минимум 10 сом — максимум 10 000 сом.');
        return;
      }
      await showRequisites(ctx, { ...state, amount });
      return;
    }

    await next();
  });

  bot.on('photo', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (state.step !== 'topup_ask_receipt' && state.step !== 'topup_confirm_receipt') {
      return next();
    }

    const user = Users.getByTelegramId(ctx.from.id);
    if (!user) return;

    const photo = ctx.message.photo;
    const fileId = photo[photo.length - 1].file_id;
    setUserState(ctx.from.id, {
      ...state,
      step: 'topup_confirm_receipt',
      receipt_file_id: fileId,
      receipt_file_type: 'photo',
    });

    await ctx.reply(
      'Чек получен. Нажмите «Подтвердить оплату», чтобы отправить заявку.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Подтвердить оплату', 'topup_confirm_pay')],
        [Markup.button.callback('❌ Отмена', 'btn_cancel')],
      ])
    );
  });

  bot.on('document', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (state.step !== 'topup_ask_receipt' && state.step !== 'topup_confirm_receipt') {
      return next();
    }

    const user = Users.getByTelegramId(ctx.from.id);
    if (!user) return;

    const document = ctx.message.document;
    setUserState(ctx.from.id, {
      ...state,
      step: 'topup_confirm_receipt',
      receipt_file_id: document.file_id,
      receipt_file_type: 'document',
    });

    await ctx.reply(
      'Файл получен. Нажмите «Подтвердить оплату», чтобы отправить заявку.',
      Markup.inlineKeyboard([
        [Markup.button.callback('✅ Подтвердить оплату', 'topup_confirm_pay')],
        [Markup.button.callback('❌ Отмена', 'btn_cancel')],
      ])
    );
  });
}

module.exports = { setupTopupHandlers, askBookmaker };

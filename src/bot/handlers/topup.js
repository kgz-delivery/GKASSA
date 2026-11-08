const { Markup } = require('telegraf');
const crypto = require('crypto');
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
const {
  addAmountBanner,
  createAmountBannerFromTelegramPhoto,
  readPaymentLinkFragmentFromTelegramPhoto,
} = require('../qrRequisites');
const { parseTopupAmount, isWholeTopupAmountInput } = require('../../money');
const { isMobcashEnabledFor } = require('../../mobcashConfig');
const { reservePaymentOrder } = require('../../paymentOrders');
const {
  verifyBookmakerAccount,
  isBookmakerAccountNotFound,
  BookmakerAccountCheckConfigError,
} = require('../../bookmakerAccounts');

const HOURGLASS_EMOJI = tgEmoji('5386367538735104399', '⌛');
const SITE_CUSTOM_EMOJI = {
  '1xbet': tgEmoji('5240186449915039482', '😎'),
  '1win': tgEmoji('5240296285113701836', '😎'),
  melbet: tgEmoji('5411499973659356732', '🆗'),
  mostbet: tgEmoji('5796168957064912286', '⭐️'),
};
const BANK_PAYMENT_LINKS = [
  ['Mbank', 'https://app.mbank.kg/qr/'],
  ['O! Банк', 'https://api.dengi.o.kg/ru/qr/'],
  ['BAKAI', 'https://bakai24.app/'],
  ['MegaPay', 'https://megapay.kg/get'],
];

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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

function usesMobcash(siteId) {
  return isMobcashEnabledFor(siteId);
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
  const ttlMs = state.paymentOrderId
    ? config.paymentAutomation.orderTtlMinutes * 60 * 1000
    : QR_TTL_MS;
  const caption = qrCaption(state.payment_id, state.amount, ttlMs, state.amountUnique);
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
  let qrImageWithAmount = null;

  if (state.amountUnique) {
    try {
      if (requisite.qr_code_photo_id) {
        qrImageWithAmount = await createAmountBannerFromTelegramPhoto(
          ctx.telegram,
          requisite.qr_code_photo_id,
          state.amountUnique
        );
      } else if (requisite.qr_code_file) {
        const filePath = path.join(process.cwd(), requisite.qr_code_file);
        if (fs.existsSync(filePath)) {
          qrImageWithAmount = await addAmountBanner(fs.readFileSync(filePath), state.amountUnique);
        }
      }
    } catch (error) {
      console.error('[Topup] Could not add unique amount to QR image:', error.message);
    }
  }

  if (qrImageWithAmount) {
    sent = await ctx.replyWithPhoto({ source: qrImageWithAmount, filename: 'payment-qr.png' }, extra);
    hasPhoto = true;
  } else if (requisite.qr_code_photo_id) {
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
    amountUnique: state.amountUnique,
    ttlMs,
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

  let invoiceState = state;
  if (config.paymentAutomation.deviceToken && config.paymentAutomation.optimaPackageName) {
    if (!Number.isSafeInteger(Number(state.amount))) {
      await ctx.reply('⚠️ Для автоподтверждения введите целую сумму в сомах.');
      return;
    }
    const order = reservePaymentOrder({
      telegramUserId: ctx.from.id,
      bookmaker: state.site,
      playerId: state.payment_id,
      amountRequested: Number(state.amount),
    });
    if (!order.ok) {
      await ctx.reply('⚠️ Сейчас нет свободных сумм на активных реквизитах Optima. Попробуйте позже или обратитесь в поддержку.');
      return;
    }
    invoiceState = {
      ...state,
      paymentOrderId: order.orderId,
      amountUnique: order.amountUnique,
      amountUniqueCents: order.amountUniqueCents,
      paymentBankId: order.bankId,
    };
  }

  setUserState(ctx.from.id, {
    ...state,
    ...invoiceState,
    step: 'topup_ask_receipt',
    requisite_id: requisite.id,
  });
  await sendQrInvoice(ctx, invoiceState, requisite);
}

async function sendToTopupChannel(ctx, { user, fileId, fileType, txn, amount, paymentId, provider, siteName, autoConfirmed = false }) {
  const userLink = user.username
    ? `<a href="https://t.me/${user.username}">${escapeHtml(user.first_name || user.username)}</a>`
    : `${escapeHtml(user.first_name || user.telegram_id)}`;

  const methodLabel = SITE_PROVIDERS.includes(provider) ? getSiteLabel(provider) : providerLabel(provider);
  const bookmaker = String(txn.site || '').toLowerCase();
  const bookmakerLabel = escapeHtml(siteName || getSiteLabel(bookmaker));
  const bookmakerEmoji = SITE_CUSTOM_EMOJI[bookmaker] || '';

  const channelText = `
<blockquote><i>Пополнение | ${bookmakerLabel}</i> ${bookmakerEmoji}</blockquote>
<b>🧾 ID: ${escapeHtml(paymentId)}</b>
<b>💰 Сумма: ${Number(amount).toFixed(2)} сом</b>

👤 Пользователь: ${userLink}
🏦 Способ: ${escapeHtml(methodLabel)}
📎 Подтверждение оплаты:${autoConfirmed ? '\n\n<b>ПОДТВЕРЖДЁН ✅ (автоматически)</b>' : ''}
  `.trim();

  const contactDetails = {
    username: user.username,
    telegramId: user.telegram_id,
    payerId: paymentId,
  };
  const sendOptions = {
    caption: channelText,
    parse_mode: 'HTML',
    ...(!autoConfirmed ? confirmTopupKeyboard(txn.transaction_id, contactDetails) : {}),
  };

  const send = (options) => fileType === 'photo'
    ? ctx.telegram.sendPhoto(config.bot.channels.topup, fileId, options)
    : ctx.telegram.sendDocument(config.bot.channels.topup, fileId, options);

  let sent;
  try {
    sent = await send(sendOptions);
  } catch (error) {
    const description = error?.response?.description || error?.description || error?.message || '';
    if (!description.includes('BUTTON_USER_PRIVACY_RESTRICTED')) throw error;

    // Telegram rejected the tg://user link. Retry with a privacy-safe contact button when still pending.
    sent = await send({
      ...sendOptions,
      ...(!autoConfirmed
        ? confirmTopupKeyboard(txn.transaction_id, { ...contactDetails, privacyRestricted: true })
        : {}),
    });
  }
  Transactions.setChannelMessage(txn.transaction_id, config.bot.channels.topup, sent.message_id, channelText);
}

function setupTopupHandlers(bot) {
  bot.action('btn_topup', async (ctx) => {
    await ctx.answerCbQuery();
    await dropQrMessage(ctx.from.id);
    clearUserState(ctx.from.id);
    await askBookmaker(ctx);
  });

  bot.action('btn_back_to_sites', async (ctx) => {
    await ctx.answerCbQuery();
    await askBookmaker(ctx);
  });

  bot.action(/^btn_site_topup:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await askSitePaymentId(ctx, ctx.match[1]);
  });

  async function submitTopupReceipt(ctx, state) {
    if (state.step === 'topup_request_creating' || state.step === 'topup_request_created') {
      if (ctx.callbackQuery) await ctx.answerCbQuery('Заявка уже создаётся или отправлена', { show_alert: true });
      return;
    }
    if (state.step !== 'topup_confirm_receipt' || !state.receipt_file_id) {
      if (ctx.callbackQuery) await ctx.answerCbQuery();
      await ctx.reply('⚠️ Сначала отправьте чек.');
      return;
    }

    const user = Users.getByTelegramId(ctx.from.id);
    if (!user) return;

    const receiptHash = crypto.createHash('sha256')
      .update(`${user.id}:topup:${state.receipt_file_id}`)
      .digest('hex');
    setUserState(ctx.from.id, { ...state, step: 'topup_request_creating', receipt_hash: receiptHash });
    if (ctx.callbackQuery) await ctx.answerCbQuery().catch(() => {});

    let transaction_id;
    try {
      const existingOrderTxn = state.paymentOrderId
        ? Transactions.getByPaymentOrderId(state.paymentOrderId)
        : null;
      if (existingOrderTxn) {
        if (!['pending', 'confirmed'].includes(existingOrderTxn.status)) {
          setUserState(ctx.from.id, { step: 'topup_confirm_receipt', ...state });
          await ctx.reply('⚠️ Заявка уже обработана или требует проверки. Повторно чек не отправляйте; обратитесь к администратору.');
          return;
        }
        const autoConfirmed = existingOrderTxn.status === 'confirmed';
        try {
          const updated = Transactions.attachReceiptToTopup(existingOrderTxn.transaction_id, {
          receipt_file: state.receipt_file_type === 'document' ? state.receipt_file_id : null,
          receipt_photo_id: state.receipt_file_type === 'photo' ? state.receipt_file_id : null,
          receipt_hash: receiptHash,
          });
          if (updated.changes !== 1) throw new Error('Existing top-up transaction was not updated with receipt');
          const updatedTxn = Transactions.getByTransactionId(existingOrderTxn.transaction_id);
          await sendToTopupChannel(ctx, {
            user,
            fileId: state.receipt_file_id,
            fileType: state.receipt_file_type,
            txn: updatedTxn,
            amount: state.amount,
            paymentId: state.payment_id,
            provider: state.provider,
            siteName: state.site_name,
            autoConfirmed,
          });
          stopQrCountdown(ctx.from.id);
          clearUserState(ctx.from.id);
          await ctx.reply(
            autoConfirmed
              ? '✅ Оплата уже автоматически подтверждена. Чек передан в канал пополнений для отметки.'
              : `${HOURGLASS_EMOJI} Чек отправлен в канал пополнений. Ожидайте подтверждения.`,
            mainMenuWithReply(isAdmin(ctx.from.id))
          );
          return;
        } catch (error) {
          console.error('[Bot] Failed to attach receipt to existing top-up:', error.message);
          setUserState(ctx.from.id, { step: 'topup_confirm_receipt', ...state });
          await ctx.reply(autoConfirmed
            ? '⚠️ Оплата уже подтверждена автоматически, но чек не удалось отправить в канал. Обратитесь к администратору; повторное пополнение не создавалось.'
            : '⚠️ Не удалось отправить чек в канал. Попробуйте ещё раз или обратитесь к администратору.');
          return;
        }
      }

      ({ transaction_id } = Transactions.create({
        user_id: user.id,
        type: 'topup',
        amount: state.amount,
        amount_text: state.amount_text,
        requisite_id: state.requisite_id,
        provider: state.provider,
        receipt_file: state.receipt_file_type === 'document' ? state.receipt_file_id : null,
        receipt_photo_id: state.receipt_file_type === 'photo' ? state.receipt_file_id : null,
        receipt_hash: receiptHash,
        payment_id: state.payment_id,
        site: state.site,
        payment_order_id: state.paymentOrderId,
      }));
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        const existing = Transactions.getByReceiptHash(receiptHash);
        if (existing) {
          setUserState(ctx.from.id, { step: 'topup_request_created', transaction_id: existing.transaction_id });
          await ctx.reply(`Заявка ${existing.transaction_id} уже создана для этого чека.`);
          return;
        }
      }
      setUserState(ctx.from.id, { step: 'topup_confirm_receipt', ...state });
      throw error;
    }

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
      setUserState(ctx.from.id, { step: 'topup_request_created', transaction_id });
      await ctx.reply(`⚠️ Не удалось подтвердить отправку заявки ${transaction_id} в канал. Обратитесь к администратору; повторно чек не отправляйте.`);
      return;
    }

    stopQrCountdown(ctx.from.id);
    clearUserState(ctx.from.id);
    await ctx.reply(
      `${HOURGLASS_EMOJI} Запрос пополнения <b>${transaction_id}</b> отправлен.\n\nОжидайте подтверждения.`,
      { parse_mode: 'HTML', ...mainMenuWithReply(isAdmin(ctx.from.id)) }
    );
  }

  bot.action('topup_confirm_pay', async (ctx) => {
    await submitTopupReceipt(ctx, getUserState(ctx.from.id));
  });

  bot.action('topup_user_privacy_restricted', async (ctx) => {
    await ctx.answerCbQuery('У пользователя ограничения на связь по Telegram ID.', { show_alert: true });
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

    if (state.step === 'topup_checking_site_id') {
      await ctx.reply('⏳ Идёт проверка ID через API. Подождите немного.');
      return;
    }

    if (state.step === 'topup_ask_site_id') {
      const userSiteId = ctx.message.text.trim();
      if (!userSiteId || userSiteId.length > 128) {
        await ctx.reply('Введите ваш ID:');
        return;
      }
      if (state.site !== '1xbet' && usesMobcash(state.site) && !/^\d+$/.test(userSiteId)) {
        await ctx.reply('⚠️ ID игрока должен содержать только цифры. Введите ID ещё раз.');
        return;
      }

      if (state.site === '1xbet') {
        const checkToken = crypto.randomUUID();
        setUserState(ctx.from.id, { ...state, step: 'topup_checking_site_id', siteIdCheckToken: checkToken });
        await ctx.reply('<tg-emoji emoji-id="5427181942934088912">💬</tg-emoji>', { parse_mode: 'HTML' });
        try {
          await verifyBookmakerAccount('1xbet', userSiteId, { payerId: userSiteId });
        } catch (error) {
          const latest = getUserState(ctx.from.id);
          if (latest.step !== 'topup_checking_site_id' || latest.siteIdCheckToken !== checkToken) return;
          setUserState(ctx.from.id, { ...state, step: 'topup_ask_site_id' });
          if (error instanceof BookmakerAccountCheckConfigError) {
            await ctx.reply('⚠️ Проверка ID 1xBet сейчас не настроена на сервере. Обратитесь к администратору.');
          } else if (isBookmakerAccountNotFound(error)) {
            await ctx.reply(
              '<tg-emoji emoji-id="6271786398404055377">⚠️</tg-emoji> Неправильный ID, перепроверьте пожалуйста и отправьте снова<tg-emoji emoji-id="5796168957064912286">⭐️</tg-emoji>',
              { parse_mode: 'HTML' }
            );
          } else {
            console.error('[Topup] 1xBet account check failed:', error.message);
            await ctx.reply('⚠️ Не удалось проверить ID через API 1xBet. Попробуйте ещё раз чуть позже.');
          }
          return;
        }
        const latest = getUserState(ctx.from.id);
        if (latest.step !== 'topup_checking_site_id' || latest.siteIdCheckToken !== checkToken) return;
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
      const parsed = parseTopupAmount(ctx.message.text);
      if (!parsed) {
        await ctx.reply('⚠️ Введите сумму цифрами (до 2 знаков после точки или запятой), от 10 до 10 000 сом.');
        return;
      }
      if (usesMobcash(state.site) && !isWholeTopupAmountInput(ctx.message.text)) {
        await ctx.reply('⚠️ Для пополнения через Mob-Cash введите целое число без точки или запятой.');
        return;
      }
      await showRequisites(ctx, { ...state, amount: parsed.amount, amount_cents: parsed.cents.toString(), amount_text: parsed.amountText });
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
    const receiptState = {
      ...state,
      step: 'topup_confirm_receipt',
      receipt_file_id: fileId,
      receipt_file_type: 'photo',
    };
    setUserState(ctx.from.id, receiptState);
    await submitTopupReceipt(ctx, receiptState);
  });

  bot.on('document', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (state.step !== 'topup_ask_receipt' && state.step !== 'topup_confirm_receipt') {
      return next();
    }

    const user = Users.getByTelegramId(ctx.from.id);
    if (!user) return;

    const document = ctx.message.document;
    const receiptState = {
      ...state,
      step: 'topup_confirm_receipt',
      receipt_file_id: document.file_id,
      receipt_file_type: 'document',
    };
    setUserState(ctx.from.id, receiptState);
    await submitTopupReceipt(ctx, receiptState);
  });
}

module.exports = { setupTopupHandlers, askBookmaker };

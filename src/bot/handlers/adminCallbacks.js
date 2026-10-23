const { Users, Transactions } = require('../../models');
const { confirmTopupAndGrantSpins } = require('../../spins');
const { isAdmin, getAdminRecord } = require('../adminAuth');
const { clearUserState } = require('../state');
const { tgEmoji } = require('../emoji');
const {
  confirmTopupFinalKeyboard,
  confirmTopupKeyboard,
  confirmWithdrawKeyboard,
} = require('../keyboards/adminKeyboard');

const CHECK_EMOJI = tgEmoji('6269163801178804220', '✅');
const GIFT_EMOJI = tgEmoji('6283073379184415506', '🎁');
const PARTY_EMOJI = tgEmoji('5461151367559141950', '🎉');
const SAD_EMOJI = tgEmoji('6269245551586316810', '😢');

function callbackMessage(ctx) {
  return ctx.callbackQuery?.message;
}

function messageText(msg) {
  return msg?.caption || msg?.text || '';
}

async function updateChannelMessage(ctx, text, extra = {}) {
  const msg = callbackMessage(ctx);
  if (!msg) return;
  try {
    if (msg.photo || msg.document) {
      await ctx.editMessageCaption(text, extra);
    } else {
      await ctx.editMessageText(text, extra);
    }
  } catch (e) {
    console.error('[Admin] Failed to edit channel message:', e.message);
  }
}

async function applyTopupConfirm(ctx, transactionId) {
  const txn = Transactions.getByTransactionId(transactionId);
  if (!txn || txn.status !== 'pending' || txn.type !== 'topup') {
    await ctx.answerCbQuery('⚠️ Транзакция не найдена или уже обработана');
    return false;
  }

  const admin = getAdminRecord(ctx.from.id);
  const confirmation = confirmTopupAndGrantSpins(transactionId, admin?.id || null);
  if (!confirmation.confirmed) {
    await ctx.answerCbQuery('⚠️ Транзакция уже обработана');
    return false;
  }

  const user = Users.getById(txn.user_id);
  if (user) {
    await ctx.telegram.sendMessage(
      user.telegram_id,
      `${CHECK_EMOJI} <b>Пополнение подтверждено!</b>\n\n` +
      `Счет пополнен на <b>${Number(txn.amount).toFixed(2)} сом</b>\n` +
        (confirmation.spinsGranted
          ? `${GIFT_EMOJI} Начислено фриспинов: <b>${confirmation.spinsGranted}</b>\n`
          : '') +
        `Транзакция: <code>${transactionId}</code>`,
      { parse_mode: 'HTML' }
    ).catch((e) => console.error('[Bot] Failed to notify user:', e.message));
  }

  if (confirmation.referralGranted && confirmation.referrerId) {
    const referrer = Users.getById(confirmation.referrerId);
    if (referrer) {
      await ctx.telegram.sendMessage(
        referrer.telegram_id,
        `${PARTY_EMOJI} Ваш приглашённый пользователь сделал пополнение от 100 сом. Вам начислен 1 фриспин!`,
        { parse_mode: 'HTML' }
      ).catch((e) => console.error('[Bot] Failed to notify referrer:', e.message));
    }
  }

  Transactions.incrementStat('total_topups');
  Transactions.incrementStat('total_transactions');
  Transactions.incrementStat('total_volume', txn.amount);
  return true;
}

async function applyWithdrawConfirm(ctx, transactionId) {
  const txn = Transactions.getByTransactionId(transactionId);
  if (!txn || txn.status !== 'pending' || txn.type !== 'withdraw') {
    await ctx.answerCbQuery('⚠️ Транзакция не найдена или уже обработана');
    return false;
  }

  const admin = getAdminRecord(ctx.from.id);
  Transactions.updateStatus(txn.id, 'confirmed', admin?.id || null);

  const user = Users.getById(txn.user_id);
  if (user) {
    const payoutText = Number(txn.amount) > 0
      ? `Со счета списано <b>${Number(txn.amount).toFixed(2)} сом</b>\n`
      : 'Заявка обработана.\n';
    await ctx.telegram.sendMessage(
      user.telegram_id,
      `✅ <b>Вывод подтвержден!</b>\n\n` +
        payoutText +
        `Транзакция: <code>${transactionId}</code>`,
      { parse_mode: 'HTML' }
    ).catch((e) => console.error('[Bot] Failed to notify user:', e.message));
  }

  Transactions.incrementStat('total_withdrawals');
  Transactions.incrementStat('total_transactions');
  Transactions.incrementStat('total_volume', txn.amount);
  return true;
}

function setupAdminCallbacks(bot) {
  bot.action(/^topup_confirm:(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }

    const txn = Transactions.getByTransactionId(transactionId);
    if (!txn || txn.status !== 'pending' || txn.type !== 'topup') {
      await ctx.answerCbQuery('⚠️ Транзакция не найдена или уже обработана');
      return;
    }

    await ctx.answerCbQuery();
    const caption = messageText(callbackMessage(ctx));
    await ctx.editMessageReplyMarkup(confirmTopupFinalKeyboard(transactionId).reply_markup);
    await updateChannelMessage(ctx, caption + '\n\n🔐 <b>Ожидается финальное подтверждение…</b>', {
      parse_mode: 'HTML',
      ...confirmTopupFinalKeyboard(transactionId),
    });
  });

  bot.action(/^topup_undo_confirm:(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }
    await ctx.answerCbQuery();
    const caption = messageText(callbackMessage(ctx)).replace(
      '\n\n🔐 <b>Ожидается финальное подтверждение…</b>',
      ''
    );
    await updateChannelMessage(ctx, caption, {
      parse_mode: 'HTML',
      ...confirmTopupKeyboard(transactionId),
    });
  });

  bot.action(/^topup_final_confirm:(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }

    const ok = await applyTopupConfirm(ctx, transactionId);
    if (!ok) return;

    await ctx.answerCbQuery('✅ Подтверждено');
    const adminName = ctx.from.first_name || ctx.from.username || 'Admin';
    const caption = messageText(callbackMessage(ctx)).replace(
      '\n\n🔐 <b>Ожидается финальное подтверждение…</b>',
      ''
    );
    await updateChannelMessage(ctx, caption + `\n\n✅ <b>Подтверждено: ${adminName}</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  });

  bot.action(/^topup_reject:(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }

    const txn = Transactions.getByTransactionId(transactionId);
    if (!txn || txn.status !== 'pending' || txn.type !== 'topup') {
      await ctx.answerCbQuery('⚠️ Транзакция не найдена или уже обработана');
      return;
    }

    const admin = getAdminRecord(ctx.from.id);
    Transactions.updateStatus(txn.id, 'rejected', admin?.id || null);
    await ctx.answerCbQuery('❌ Отклонено');

    const user = Users.getById(txn.user_id);
    if (user) {
      await ctx.telegram.sendMessage(
        user.telegram_id,
        `${SAD_EMOJI} <b>Пополнение отклонено.</b>\n\nТранзакция: <code>${transactionId}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    const adminName = ctx.from.first_name || ctx.from.username || 'Admin';
    const caption = messageText(callbackMessage(ctx));
    await updateChannelMessage(ctx, caption + `\n\n❌ <b>Отклонено: ${adminName}</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  });

  bot.action(/^withdraw_confirm:(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }

    const ok = await applyWithdrawConfirm(ctx, transactionId);
    if (!ok) return;

    await ctx.answerCbQuery('✅ Подтверждено');
    const adminName = ctx.from.first_name || ctx.from.username || 'Admin';
    const caption = messageText(callbackMessage(ctx));
    await updateChannelMessage(ctx, caption + `\n\n✅ <b>Вывод подтвержден: ${adminName}</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  });

  bot.action(/^withdraw_reject:(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }

    const txn = Transactions.getByTransactionId(transactionId);
    if (!txn || txn.status !== 'pending' || txn.type !== 'withdraw') {
      await ctx.answerCbQuery('⚠️ Транзакция не найдена или уже обработана');
      return;
    }

    const admin = getAdminRecord(ctx.from.id);
    Transactions.updateStatus(txn.id, 'rejected', admin?.id || null);
    await ctx.answerCbQuery('❌ Отклонено');

    const user = Users.getById(txn.user_id);
    if (user) {
      await ctx.telegram.sendMessage(
        user.telegram_id,
        `❌ <b>Вывод отклонен.</b>\n\nТранзакция: <code>${transactionId}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    const adminName = ctx.from.first_name || ctx.from.username || 'Admin';
    const caption = messageText(callbackMessage(ctx));
    await updateChannelMessage(ctx, caption + `\n\n❌ <b>Отклонено: ${adminName}</b>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] },
    });
  });

  bot.action(/^channel_ban:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }

    const txn = Transactions.getByTransactionId(ctx.match[1]);
    const user = txn ? Users.getById(txn.user_id) : null;
    if (!user) {
      await ctx.answerCbQuery('Пользователь не найден', { show_alert: true });
      return;
    }
    if (isAdmin(user.telegram_id)) {
      await ctx.answerCbQuery('Нельзя банить администратора', { show_alert: true });
      return;
    }

    Users.banByTelegramId(user.telegram_id, {
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
    });
    clearUserState(user.telegram_id);
    await ctx.telegram.sendMessage(
      user.telegram_id,
      '🚫 Вы забанены. Смена ника не поможет — бан привязан к вашему Telegram ID.\nОбратитесь в поддержку: @Flash_admin_kg'
    ).catch(() => {});

    await ctx.answerCbQuery('🚫 Пользователь забанен', { show_alert: true });
    const caption = messageText(callbackMessage(ctx));
    if (!caption.includes('Пользователь забанен')) {
      await updateChannelMessage(ctx, caption + `\n\n🚫 <b>Пользователь забанен</b>`, {
        parse_mode: 'HTML',
      });
    }
  });
}

module.exports = { setupAdminCallbacks, applyTopupConfirm, applyWithdrawConfirm };

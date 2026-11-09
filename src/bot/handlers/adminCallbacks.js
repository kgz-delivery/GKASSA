const config = require('../../config');
const { Users, Transactions, MobcashOrders } = require('../../models');
const { confirmTopupAndGrantSpins, listActiveAdminTelegramIds } = require('../../spins');
const { isAdmin, getAdminRecord } = require('../adminAuth');
const { clearUserState } = require('../state');
const { tgEmoji } = require('../emoji');
const { getReferralBalance, resolvePayoutRequest } = require('../../referrals');
const {
  confirmTopupFinalKeyboard,
  confirmTopupKeyboard,
  confirmTopupRejectKeyboard,
  confirmWithdrawKeyboard,
  topupContactRows,
  withdrawContactRows,
} = require('../keyboards/adminKeyboard');
const { MobcashApiError, MobcashUnknownError } = require('../../mobcash');
const { MobcashPersistenceError, createMobcashTopupProcessor } = require('../../mobcashTopup');
const { parseTopupAmount } = require('../../money');
const { getMobcashClient } = require('../../mobcash');
const { isMobcashEnabledFor } = require('../../mobcashConfig');
const { getSiteLabel } = require('../../providers');
const { recoverSendingMobcashOrders } = require('../../mobcashRecovery');
const { db } = require('../../database');

const CHECK_EMOJI = tgEmoji('6269163801178804220', '✅');
const GIFT_EMOJI = tgEmoji('6283073379184415506', '🎁');
const SAD_EMOJI = tgEmoji('6269245551586316810', '😢');
const REFERRAL_COMMISSION_EMOJI = tgEmoji('5298614648138919107', '📈');

function callbackMessage(ctx) {
  return ctx.callbackQuery?.message;
}

function messageText(msg) {
  return msg?.caption || msg?.text || '';
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

async function applyTopupConfirm(ctx, transactionId, { silent = false } = {}) {
  const txn = Transactions.getByTransactionId(transactionId);
  if (!txn || txn.status !== 'pending' || txn.type !== 'topup') {
    if (!silent) await ctx.answerCbQuery('⚠️ Транзакция не найдена или уже обработана');
    return false;
  }

  const admin = getAdminRecord(ctx.from.id);
  const confirmation = confirmTopupAndGrantSpins(transactionId, admin?.id || null);
  if (!confirmation.confirmed) {
    if (!silent) await ctx.answerCbQuery('⚠️ Транзакция уже обработана');
    return false;
  }

  if (txn.payment_order_id) {
    db.prepare(`
      UPDATE orders SET status = 'completed', paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND status IN ('pending', 'paid')
    `).run(txn.payment_order_id);
    db.prepare(`
      INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'payment.order_completed', 'order', ?, ?)
    `).run(ctx.from?.id || null, String(txn.payment_order_id), JSON.stringify({ transaction_id: transactionId }));
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

  if (confirmation.referralCommission) {
    const commission = confirmation.referralCommission;
    const balance = getReferralBalance(commission.referrerUserId);
    if (commission.referrerTelegramId) {
      await ctx.telegram.sendMessage(
        commission.referrerTelegramId,
        `${REFERRAL_COMMISSION_EMOJI} Ваш приглашённый пользователь пополнил счет на ${commission.depositAmount.toFixed(2)} сом. ` +
          `Начислено 3%: ${commission.commissionAmount.toFixed(2)} сом. ` +
          `Доступно к выводу: ${balance.available.toFixed(2)} сом.`,
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

function usesMobcash(txn) {
  return isMobcashEnabledFor(txn.site);
}

async function notifyMobcashAdmins(ctx, text) {
  const adminIds = listActiveAdminTelegramIds(config.admin.telegramIds);
  await Promise.all(adminIds.map((adminId) =>
    ctx.telegram.sendMessage(adminId, text).catch((error) => {
      console.error('[Mob-Cash] Admin notification failed:', error.message);
    })
  ));
}

function topupContactDetails(txn) {
  const user = txn ? Users.getById(txn.user_id) : null;
  return { username: user?.username, telegramId: user?.telegram_id, payerId: txn?.payment_id };
}

async function recoverMobcashSending(bot) {
  await recoverSendingMobcashOrders({
    orders: MobcashOrders,
    formatBookmaker: getSiteLabel,
    logger: console,
  });
}

function cleanUnknownMarker(text) {
  return String(text || '')
    .replace(/\n\n⚠️ Результат неизвестен\. Проверьте кассу mob-cash вручную\.$/, '')
    .replace(/\n\n⚠️ Результат mob-cash неизвестен\.?$/i, '');
}

function cleanWaitingMarker(text) {
  return String(text || '').replace(
    /\n\n(?:<blockquote><i>)?🔐 (?:<b>)?Ожидается финальное подтверждение…(?:<\/b>)?(?:<\/i><\/blockquote>)?/g,
    ''
  );
}

function cleanRejectWaitMarker(text) {
  return String(text || '').replace(/\n\n<blockquote><i>🔐 Ожидается подтверждение отмены…<\/i><\/blockquote>/g, '');
}

function confirmedWithdrawContactRows(txn) {
  const user = txn ? Users.getById(txn.user_id) : null;
  const details = String(txn?.withdraw_details || '');
  const value = (label) => details.match(new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]+)`))?.[1] || '';
  return withdrawContactRows({
    bookmakerId: value('ID букмекера'),
    withdrawCode: value('Код получения'),
    userId: user?.telegram_id,
  });
}

async function finalizeConfirmedTopupMessage(ctx, transactionId, adminName) {
  const caption = cleanWaitingMarker(cleanUnknownMarker(messageText(callbackMessage(ctx))));
  await updateChannelMessage(ctx, caption + `\n\n<blockquote><i>✅ <b>Подтверждено: ${escapeHtml(adminName)}</b></i></blockquote>`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: topupContactRows(topupContactDetails(Transactions.getByTransactionId(transactionId))) },
  });
}

async function applyUnknownMobcashAsConfirmed(ctx, txn, amountText) {
  const applied = await applyTopupConfirm(ctx, txn.transaction_id, { silent: true });
  const current = Transactions.getByTransactionId(txn.transaction_id);
  if (!applied && current?.status !== 'confirmed') {
    await ctx.answerCbQuery('Не удалось подтвердить заявку. Проверьте её статус.', { show_alert: true });
    return false;
  }
  console.info('[Mob-Cash] Order result', JSON.stringify({
    transaction_id: txn.transaction_id,
    bookmaker: txn.site,
    payerId: String(txn.payment_id),
    amount: amountText,
    state: 'unknown',
    local_confirmation: 'success',
  }));
  await ctx.answerCbQuery('✅ Подтверждено');
  await finalizeConfirmedTopupMessage(ctx, txn.transaction_id, ctx.from.first_name || ctx.from.username || 'Admin');
  return true;
}

async function applyMobcashDepositSuccess(ctx, txn, amountText) {
  const failureText = 'Деньги отправлены через mob-cash, но заявка не подтверждена в боте. Нажмите финальную кнопку ещё раз';
  try {
    const ok = await applyTopupConfirm(ctx, txn.transaction_id, { silent: true });
    if (!ok) {
      const current = Transactions.getByTransactionId(txn.transaction_id);
      if (current?.status !== 'confirmed') {
        await notifyMobcashAdmins(ctx,
          `⚠️ ${failureText}\nЗаявка: ${txn.transaction_id}\nБукмекер: ${getSiteLabel(txn.site)}\nСумма: ${amountText} KGS`);
        await ctx.answerCbQuery(failureText, { show_alert: true });
      } else {
        await ctx.answerCbQuery('✅ Заявка уже подтверждена');
        await finalizeConfirmedTopupMessage(ctx, txn.transaction_id, ctx.from.first_name || ctx.from.username || 'Admin');
      }
      return false;
    }
    await ctx.answerCbQuery('✅ Подтверждено');
    await finalizeConfirmedTopupMessage(ctx, txn.transaction_id, ctx.from.first_name || ctx.from.username || 'Admin');
    return true;
  } catch (error) {
    await notifyMobcashAdmins(ctx,
      `⚠️ ${failureText}\nЗаявка: ${txn.transaction_id}\nБукмекер: ${getSiteLabel(txn.site)}\nСумма: ${amountText} KGS`);
    await ctx.answerCbQuery(failureText, { show_alert: true }).catch(() => {});
    console.error('[Mob-Cash] Local confirmation failed after successful deposit:', JSON.stringify({
      transaction_id: txn.transaction_id,
      payerId: String(txn.payment_id),
      amount: amountText,
      result: 'deposit_succeeded_local_confirmation_failed',
    }));
    return false;
  }
}

async function handleLegacyMobcashResolution(ctx, transactionId) {
  if (!isAdmin(ctx.from.id)) {
    await ctx.answerCbQuery('⛔ Доступ запрещен');
    return;
  }
  const txn = Transactions.getByTransactionId(transactionId);
  const order = MobcashOrders.getByTransactionId(transactionId);
  if (!txn || txn.type !== 'topup' || !order || order.state !== 'unknown') {
    await ctx.answerCbQuery('Заявка уже обработана или не найдена');
    return;
  }
  const caption = cleanUnknownMarker(messageText(callbackMessage(ctx)))
    .replace(/\n\n⚠️ Результат mob-cash неизвестен\.?/i, '');
  await updateChannelMessage(ctx, `${caption}\n\n<blockquote><i>⚠️ Результат mob-cash неизвестен</i></blockquote>`, {
    parse_mode: 'HTML',
    ...confirmTopupKeyboard(transactionId, topupContactDetails(txn)),
  });
  await ctx.answerCbQuery('Результат неизвестен. Проверьте кассу mob-cash вручную', { show_alert: true });
}

async function handleMobcashFinalConfirm(ctx, txn) {
  const bookmakerName = getSiteLabel(txn.site);
  const existing = MobcashOrders.getByTransactionId(txn.transaction_id);
  if (existing?.state === 'success') {
    await applyMobcashDepositSuccess(ctx, txn, existing.amount_text || txn.amount_text || String(txn.amount));
    return;
  }
  if (existing?.state === 'unknown') {
    await applyUnknownMobcashAsConfirmed(ctx, txn, existing.amount_text || txn.amount_text || String(txn.amount));
    return;
  }
  if (existing?.state === 'sending') {
    await ctx.answerCbQuery('Уже обрабатывается или обработано', { show_alert: true });
    return;
  }

  const parsedAmount = parseTopupAmount(txn.amount_text || String(txn.amount));
  if (!/^\d+$/.test(String(txn.payment_id || '')) || !parsedAmount) {
    await ctx.answerCbQuery(`${bookmakerName}: некорректный ID игрока или сумма в заявке. Проверьте вручную.`, { show_alert: true });
    await notifyMobcashAdmins(ctx,
      `⚠️ Некорректные данные заявки Mob-Cash. Автопополнение не запущено.\nБукмекер: ${bookmakerName}\nТранзакция: ${txn.transaction_id}\nПроверьте ID игрока и сумму.`);
    return;
  }
  const amountText = parsedAmount.amountText;
  if (parsedAmount.cents % 100n !== 0n) {
    await ctx.answerCbQuery(`${bookmakerName}: для пополнения через Mob-Cash нужна целая сумма.`, { show_alert: true });
    await notifyMobcashAdmins(ctx,
      `⚠️ Для Mob-Cash нужна целая сумма. Автопополнение не запущено.\nБукмекер: ${bookmakerName}\nЗаявка: ${txn.transaction_id}\nСумма: ${amountText} KGS`);
    return;
  }
  const base = { ...txn, amount_text: amountText };
  try {
    const processor = createMobcashTopupProcessor({
      getClient: getMobcashClient,
      orders: MobcashOrders,
      dryRun: config.mobcash.dryRun,
    });
    const result = await processor.process(base);
    if (result.state === 'dry_run') {
      const nickname = result.nickname || 'не указан';
      await ctx.answerCbQuery(`ТЕСТОВЫЙ РЕЖИМ: ${bookmakerName}. Проверка пройдена, ник: ${nickname}`.slice(0, 195), { show_alert: true });
      return;
    }
    if (result.state === 'already_processing') {
      await ctx.answerCbQuery('Уже обрабатывается или обработано', { show_alert: true });
      return;
    }
    if (result.state === 'failed') {
      const reason = String(result.error?.message || 'Mob-Cash отклонил пополнение').slice(0, 180);
      await notifyMobcashAdmins(ctx,
        `⚠️ Mob-Cash отклонил пополнение.\nБукмекер: ${bookmakerName}\nТранзакция: ${txn.transaction_id}\nID игрока: ${txn.payment_id}\nСумма: ${amountText} KGS\nПричина: ${reason}`);
      await ctx.answerCbQuery(`${bookmakerName}: ${reason}`, { show_alert: true });
      return;
    }
    if (result.state === 'unknown') {
      await applyUnknownMobcashAsConfirmed(ctx, txn, amountText);
      return;
    }

    await applyMobcashDepositSuccess(ctx, txn, amountText);
  } catch (error) {
    const reason = String(error.message || 'Неизвестная ошибка Mob-Cash').slice(0, 180);
    const needsAdminNotice = error instanceof MobcashPersistenceError ||
      error instanceof MobcashUnknownError || error.operation === 'login' || !(error instanceof MobcashApiError);
    if (needsAdminNotice) {
      const detail = error instanceof MobcashPersistenceError && error.depositSucceeded
        ? 'Пополнение могло пройти, но результат не записан в БД. Нужна ручная сверка.'
        : error instanceof MobcashPersistenceError
          ? 'Не удалось записать результат Mob-Cash в БД. Проверьте заявку вручную.'
          : 'Не удалось проверить аккаунт в Mob-Cash. Проверьте настройки и повторите попытку.';
      await notifyMobcashAdmins(ctx,
        `⚠️ ${detail}\nБукмекер: ${bookmakerName}\nТранзакция: ${txn.transaction_id}\nID игрока: ${txn.payment_id}\nСумма: ${amountText} KGS\nПричина: ${reason}`);
    }
    await ctx.answerCbQuery(`${bookmakerName}: ${reason}`, { show_alert: true });
    console.error('[Mob-Cash] API operation failed:', JSON.stringify({
      transaction_id: txn.transaction_id,
      payerId: String(txn.payment_id),
      amount: amountText,
      bookmaker: txn.site,
      state: error instanceof MobcashUnknownError ? 'unknown' : 'failed',
      result: error instanceof MobcashPersistenceError && error.depositSucceeded
        ? 'deposit_succeeded_but_db_write_failed'
        : error instanceof MobcashUnknownError ? 'unknown' : 'failed',
    }));
  }
}

async function resolveReferralPayout(ctx, requestId, resolution, expectedType = 'withdraw') {
  const request = resolvePayoutRequest(requestId, resolution, ctx.from.id, expectedType);
  if (!request) {
    await ctx.answerCbQuery('Заявка уже обработана или не найдена');
    return;
  }

  const paid = resolution === 'paid';
  const adminName = String(ctx.from.first_name || ctx.from.username || 'Admin')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const isBonusTopup = request.request_type === 'topup';
  await ctx.answerCbQuery(paid
    ? (isBonusTopup ? 'Пополнение отмечено как выполненное' : 'Выплата отмечена как выполненная')
    : 'Заявка отклонена');
  await ctx.telegram.sendMessage(
    request.telegram_id,
    isBonusTopup
      ? (paid
        ? `✅ <b>Пополнение бонусами выполнено.</b>\n\nСумма: <b>${Number(request.amount).toFixed(2)} сом</b>\nЗаявка: <code>${requestId}</code>`
        : `❌ <b>Пополнение бонусами отклонено.</b>\n\n${Number(request.amount).toFixed(2)} сом возвращены на реферальный баланс.`)
      : paid
      ? `✅ <b>Реферальная выплата выполнена.</b>\n\nСумма: <b>${Number(request.amount).toFixed(2)} сом</b>\nЗаявка: <code>${requestId}</code>`
      : `❌ <b>Заявка на реферальную выплату отклонена.</b>\n\n${Number(request.amount).toFixed(2)} сом возвращены на доступный баланс.`,
    { parse_mode: 'HTML' }
  ).catch((error) => console.error('[Referral] Failed to notify payout user:', error.message));

  const caption = messageText(callbackMessage(ctx));
  await updateChannelMessage(ctx, `${caption}\n\n${isBonusTopup ? (paid ? '✅ Пополнено' : '❌ Отклонено') : (paid ? '✅ Выплачено' : '❌ Отклонено')}: ${adminName}`, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  });
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
    const caption = cleanWaitingMarker(messageText(callbackMessage(ctx)));
    const contactDetails = topupContactDetails(txn);
    await ctx.editMessageReplyMarkup(confirmTopupFinalKeyboard(transactionId, contactDetails).reply_markup);
    await updateChannelMessage(ctx, caption + '\n\n<blockquote><i>🔐 Ожидается финальное подтверждение…</i></blockquote>', {
      parse_mode: 'HTML',
      ...confirmTopupFinalKeyboard(transactionId, contactDetails),
    });
  });

  bot.action(/^topup_undo_confirm:(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }
    await ctx.answerCbQuery();
    const caption = cleanWaitingMarker(messageText(callbackMessage(ctx)));
    await updateChannelMessage(ctx, caption, {
      parse_mode: 'HTML',
      ...confirmTopupKeyboard(transactionId, topupContactDetails(Transactions.getByTransactionId(transactionId))),
    });
  });

  bot.action(/^topup_final_confirm:(.+)$/, async (ctx) => {
    const transactionId = ctx.match[1];
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }

    const txn = Transactions.getByTransactionId(transactionId);
    if (!txn || txn.type !== 'topup' || txn.status !== 'pending') {
      await ctx.answerCbQuery('⚠️ Транзакция не найдена или уже обработана');
      return;
    }
    if (usesMobcash(txn)) {
      await handleMobcashFinalConfirm(ctx, txn);
      return;
    }

    const ok = await applyTopupConfirm(ctx, transactionId);
    if (!ok) return;

    await ctx.answerCbQuery('✅ Подтверждено');
    const adminName = ctx.from.first_name || ctx.from.username || 'Admin';
    const caption = cleanWaitingMarker(messageText(callbackMessage(ctx)));
    await updateChannelMessage(ctx, caption + `\n\n<blockquote><i>✅ <b>Подтверждено: ${escapeHtml(adminName)}</b></i></blockquote>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: topupContactRows(topupContactDetails(txn)) },
    });
  });

  bot.action(/^mobcash_paid:(.+)$/, async (ctx) => {
    await handleLegacyMobcashResolution(ctx, ctx.match[1]);
  });

  bot.action(/^mobcash_not_paid:(.+)$/, async (ctx) => {
    await handleLegacyMobcashResolution(ctx, ctx.match[1]);
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

    await ctx.answerCbQuery();
    const caption = cleanRejectWaitMarker(cleanWaitingMarker(messageText(callbackMessage(ctx))));
    await updateChannelMessage(ctx, caption + '\n\n<blockquote><i>🔐 Ожидается подтверждение отмены…</i></blockquote>', {
      parse_mode: 'HTML',
      ...confirmTopupRejectKeyboard(transactionId, topupContactDetails(txn)),
    });
  });

  bot.action(/^topup_undo_reject:(.+)$/, async (ctx) => {
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
    const caption = cleanRejectWaitMarker(messageText(callbackMessage(ctx)));
    await updateChannelMessage(ctx, caption, {
      parse_mode: 'HTML',
      ...confirmTopupKeyboard(transactionId, topupContactDetails(txn)),
    });
  });

  bot.action(/^topup_final_reject:(.+)$/, async (ctx) => {
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
    const caption = cleanRejectWaitMarker(cleanWaitingMarker(cleanUnknownMarker(messageText(callbackMessage(ctx)))));
    await updateChannelMessage(ctx, caption + `\n\n<blockquote><i>❌ <b>Отклонено: ${escapeHtml(adminName)}</b></i></blockquote>`, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: topupContactRows(topupContactDetails(txn)) },
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
      reply_markup: { inline_keyboard: confirmedWithdrawContactRows(Transactions.getByTransactionId(transactionId)) },
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

  bot.action(/^ref_payout_paid:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }
    await resolveReferralPayout(ctx, ctx.match[1], 'paid');
  });

  bot.action(/^ref_payout_reject:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }
    await resolveReferralPayout(ctx, ctx.match[1], 'rejected');
  });

  bot.action(/^ref_topup_paid:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }
    await resolveReferralPayout(ctx, ctx.match[1], 'paid', 'topup');
  });

  bot.action(/^ref_topup_reject:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }
    await resolveReferralPayout(ctx, ctx.match[1], 'rejected', 'topup');
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

module.exports = { setupAdminCallbacks, applyTopupConfirm, applyWithdrawConfirm, recoverMobcashSending };

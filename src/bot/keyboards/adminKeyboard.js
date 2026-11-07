const { Markup } = require('telegraf');
const { BotSettings } = require('../../models');

function adminMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📊 Статистика', 'admin_stats'),
      Markup.button.callback('💳 Реквизиты', 'admin_requisites'),
    ],
    [
      Markup.button.callback('📋 Транзакции', 'admin_transactions'),
      Markup.button.callback('👥 Пользователи', 'admin_users'),
    ],
    [Markup.button.callback('⚠️ Проверка оплат', 'admin_payment_review')],
    [Markup.button.callback('🏦 Optima: шаблон push', 'admin_optima_template')],
    [Markup.button.callback('👮 Роли и лимиты', 'admin_manual_roles')],
    [Markup.button.callback('Пополнить💎', 'admin_manual_topup')],
    [Markup.button.callback('📄 Массовое пополнение CSV', 'admin_manual_topup_bulk')],
    [
      Markup.button.callback('🚫 Забанить', 'admin_ban_user'),
      Markup.button.callback('✅ Разбан', 'admin_unban_user'),
    ],
    [
      Markup.button.callback('📢 Рассылка', 'admin_broadcast'),
      Markup.button.callback('🔙 Назад', 'admin_back'),
    ],
    [Markup.button.callback('🎰 Букмекеры', 'admin_bookmakers')],
    [Markup.button.callback('📄 Отчёт в PDF', 'admin_pdf_reports')],
    [Markup.button.callback(
      BotSettings.get('bot_paused', '0') === '1' ? '▶️ Возобновить бота' : '⏸️ Пауза бота',
      'admin_toggle_pause'
    )],
  ]);
}

function pdfReportsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📥 Пополнения', 'admin_pdf_report:topup'),
      Markup.button.callback('📤 Выводы', 'admin_pdf_report:withdraw'),
    ],
    [Markup.button.callback('🔙 Назад', 'admin_panel')],
  ]);
}

function topupContactRows({ username, telegramId, payerId, privacyRestricted = false } = {}) {
  const url = username
    ? `https://t.me/${String(username).replace(/^@/, '')}`
    : `tg://user?id=${telegramId}`;
  const rows = [];
  if (privacyRestricted) {
    rows.push([Markup.button.callback('⚠️ Ограничения TG ID', 'topup_user_privacy_restricted')]);
  } else if (url && url !== 'tg://user?id=undefined') {
    rows.push([Markup.button.url('✉️ Написать клиенту', url)]);
  }
  if (payerId !== undefined && payerId !== null && String(payerId)) {
    rows.push([{ text: 'copy id', copy_text: { text: String(payerId) } }]);
  }
  return rows;
}

function confirmTopupKeyboard(transactionId, contactDetails) {
  return Markup.inlineKeyboard([
    ...topupContactRows(contactDetails),
    [
      Markup.button.callback('✅ Подтвердить', `topup_confirm:${transactionId}`),
      Markup.button.callback('❌ Отклонить', `topup_reject:${transactionId}`),
    ],
  ]);
}

function confirmTopupFinalKeyboard(transactionId, contactDetails) {
  return Markup.inlineKeyboard([
    ...topupContactRows(contactDetails),
    [Markup.button.callback('🔒 Вы уверены? Перепроверьте и нажмите', `topup_final_confirm:${transactionId}`)],
    [Markup.button.callback('🔙 Назад', `topup_undo_confirm:${transactionId}`)],
  ]);
}

function confirmTopupRejectKeyboard(transactionId, contactDetails) {
  return Markup.inlineKeyboard([
    ...topupContactRows(contactDetails),
    [Markup.button.callback('❌ Подтвердить отмену', `topup_final_reject:${transactionId}`)],
    [Markup.button.callback('🔙 Назад', `topup_undo_reject:${transactionId}`)],
  ]);
}

function confirmWithdrawKeyboard(transactionId, contactDetails) {
  return Markup.inlineKeyboard([
    ...withdrawContactRows(contactDetails),
    [
      Markup.button.callback('✅ Подтвердить', `withdraw_confirm:${transactionId}`),
      Markup.button.callback('❌ Отклонить', `withdraw_reject:${transactionId}`),
    ],
  ]);
}

function withdrawContactRows(contactDetails) {
  const rows = [];
  if (contactDetails) {
    const copyButtons = [];
    if (contactDetails.bookmakerId) {
      copyButtons.push({ text: '📋 Копировать ID букмекера', copy_text: { text: String(contactDetails.bookmakerId) } });
    }
    if (contactDetails.withdrawCode) {
      copyButtons.push({ text: '🔐 Копировать код', copy_text: { text: String(contactDetails.withdrawCode) } });
    }
    if (copyButtons.length) rows.push(copyButtons);
    if (contactDetails.userId) {
      rows.push([Markup.button.url('👤 Связаться с пользователем', `tg://user?id=${contactDetails.userId}`)]);
    }
  }
  return rows;
}

module.exports = {
  adminMenu,
  pdfReportsKeyboard,
  confirmTopupKeyboard,
  confirmTopupFinalKeyboard,
  confirmTopupRejectKeyboard,
  topupContactRows,
  withdrawContactRows,
  confirmWithdrawKeyboard,
};

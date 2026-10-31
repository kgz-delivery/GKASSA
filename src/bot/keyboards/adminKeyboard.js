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

function confirmTopupKeyboard(transactionId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Подтвердить', `topup_confirm:${transactionId}`),
      Markup.button.callback('❌ Отклонить', `topup_reject:${transactionId}`),
    ],
  ]);
}

function confirmTopupFinalKeyboard(transactionId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🔒 Вы уверены? Перепроверьте и нажмите', `topup_final_confirm:${transactionId}`)],
    [Markup.button.callback('🔙 Назад', `topup_undo_confirm:${transactionId}`)],
  ]);
}

function confirmWithdrawKeyboard(transactionId, contactDetails) {
  const rows = [];
  if (contactDetails) {
    rows.push([
      { text: '📋 Копировать ID букмекера', copy_text: { text: String(contactDetails.bookmakerId) } },
      { text: '🔐 Копировать код', copy_text: { text: String(contactDetails.withdrawCode) } },
    ]);
    rows.push([Markup.button.url('👤 Связаться с пользователем', `tg://user?id=${contactDetails.userId}`)]);
  }
  rows.push([
      Markup.button.callback('✅ Подтвердить', `withdraw_confirm:${transactionId}`),
      Markup.button.callback('❌ Отклонить', `withdraw_reject:${transactionId}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

module.exports = {
  adminMenu,
  pdfReportsKeyboard,
  confirmTopupKeyboard,
  confirmTopupFinalKeyboard,
  confirmWithdrawKeyboard,
};

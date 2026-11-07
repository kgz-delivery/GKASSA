function tgEmoji(id, emoji) {
  return `<tg-emoji emoji-id="${id}">${emoji}</tg-emoji>`;
}

const ZAP = tgEmoji('5456140674028019486', '⚡️');
const OK = tgEmoji('6113685078825505075', '🟢');
const PERCENT = tgEmoji('5224295096689651881', '💯');
const SHIELD = tgEmoji('5226731159190269344', '🪐');
const TEST = tgEmoji('5285430309720966085', '👍');
const SUPPORT_EMOJI = tgEmoji('5224615432530461449', '💬');
const LIMIT_EMOJI = tgEmoji('5429651785352501917', '↗️');

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function welcomeHtml(from) {
  const name = escapeHtml(from.first_name || from.username || 'друг');
  return (
    `<b>${ZAP} Привет, ${name}!</b>\n\n` +
    `${OK}Пополнение | Вывод\n\n` +
    `${ZAP} Пополнение — 0 ${PERCENT}\n` +
    `${ZAP} Вывод — 0${PERCENT}\n` +
    `${ZAP} Работаем 24/7\n` +
    `<blockquote>Молниеносные выводы и пополнения ${ZAP}</blockquote>\n\n` +
    `${SUPPORT_EMOJI} Поддержка: @Flash_support_kg\n` +
    `${SHIELD} Финансовый контроль обеспечен личным отделом безопасности\n\n` +
    `${SUPPORT_EMOJI} Наш чат: <a href="https://t.me/flashkassa">https://t.me/flashkassa</a>`
  );
}

function qrAmountHtml() {
  return (
    `${ZAP} <b>Пополнение счета — QR Bank</b>\n` +
    `Напишите сумму, которую хотите внести:\n` +
    `${LIMIT_EMOJI} <b>Лимит:</b> от <code>10</code> до <code>10 000</code> сом`
  );
}

module.exports = { ZAP, OK, PERCENT, SHIELD, TEST, tgEmoji, welcomeHtml, qrAmountHtml };

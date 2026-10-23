const { Markup } = require('telegraf');
const { clearUserState } = require('./state');

const QR_TTL_MS = 10 * 60 * 1000;
const TICK_MS = 1000;
const CANCEL_TEXT =
  '<tg-emoji emoji-id="6269245551586316810">😢</tg-emoji> Пополнение отменено\n' +
  '<tg-emoji emoji-id="6271786398404055377">⚠️</tg-emoji> Не переводите по старым реквизитам. Создайте новую заявку нажав на пополнить.';

const sessions = new Map();
const deleteWaiters = new Map();

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatRemain(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function qrCaption(paymentId, amount, remainMs) {
  return (
    `<tg-emoji emoji-id="6269290077512274929">⏩</tg-emoji> ID: <code>${escapeHtml(paymentId)}</code>\n` +
    `<tg-emoji emoji-id="5312441427764989435">💱</tg-emoji> Сумма : ${Number(amount).toFixed(2)}\n` +
    `<tg-emoji emoji-id="6271786398404055377">⚠️</tg-emoji> Осталось времени: ${formatRemain(remainMs)}\n\n` +
    `<tg-emoji emoji-id="5201691993775818138">🛫</tg-emoji> После оплаты автоматически ваш счет пополниться\n` +
    `Отправьте чек, Фото либо PDF`
  );
}

function activeQrCountdownCount(requisiteId) {
  let count = 0;
  for (const session of sessions.values()) {
    if (String(session.requisiteId) === String(requisiteId)) count += 1;
  }
  return count;
}

function waitForQrCountdownsToFinish(telegram, requisiteId, adminId) {
  const count = activeQrCountdownCount(requisiteId);
  if (count === 0) return 0;

  const key = String(requisiteId);
  if (!deleteWaiters.has(key)) deleteWaiters.set(key, new Map());
  deleteWaiters.get(key).set(String(adminId), telegram);
  return count;
}

function clearQrDeleteWaiters(requisiteId) {
  deleteWaiters.delete(String(requisiteId));
}

async function notifyDeleteWaitersIfReady(requisiteId) {
  const key = String(requisiteId);
  if (activeQrCountdownCount(key) > 0) return;
  const waiters = deleteWaiters.get(key);
  if (!waiters) return;
  deleteWaiters.delete(key);

  await Promise.all([...waiters.entries()].map(async ([adminId, api]) => {
    try {
      await api.sendMessage(
        adminId,
        `✅ Отсчёт пополнения по реквизиту #${key} завершён. Теперь его можно удалить.`,
        Markup.inlineKeyboard([[
          Markup.button.callback('🗑 Удалить реквизит', `admin_req_delete:${key}`),
        ]])
      );
    } catch (_) {
      /* admin may have blocked the bot */
    }
  }));
}

function stopQrCountdown(userId, { notify = true } = {}) {
  const session = sessions.get(userId);
  if (!session) return null;
  clearInterval(session.intervalId);
  clearTimeout(session.timeoutId);
  sessions.delete(userId);
  if (notify && session.requisiteId != null) {
    void notifyDeleteWaitersIfReady(session.requisiteId);
  }
  return session;
}

async function dropQrMessage(userId) {
  const session = stopQrCountdown(userId);
  if (!session) return;
  try {
    await session.telegram.deleteMessage(session.chatId, session.messageId);
  } catch (_) {
    /* already deleted */
  }
}

async function expireQrSession(userId) {
  const session = stopQrCountdown(userId);
  if (!session) return;
  clearUserState(userId);
  try {
    await session.telegram.deleteMessage(session.chatId, session.messageId);
  } catch (_) {
    /* already deleted */
  }
  try {
    await session.telegram.sendMessage(session.chatId, CANCEL_TEXT, {
      parse_mode: 'HTML',
      ...Markup.removeKeyboard(),
    });
  } catch (_) {
    /* user blocked bot */
  }
}

function startQrCountdown(telegram, { userId, chatId, messageId, paymentId, amount, hasPhoto, requisiteId, replyMarkup }) {
  const previousSession = sessions.get(userId);
  const sameRequisite = previousSession && String(previousSession.requisiteId) === String(requisiteId);
  stopQrCountdown(userId, { notify: Boolean(previousSession && !sameRequisite) });
  const expiresAt = Date.now() + QR_TTL_MS;

  const tick = async () => {
    const session = sessions.get(userId);
    if (!session) return;
    const left = session.expiresAt - Date.now();
    if (left <= 0) return;
    const caption = qrCaption(session.paymentId, session.amount, left);
    try {
      const editOptions = {
        parse_mode: 'HTML',
        ...(session.replyMarkup ? { reply_markup: session.replyMarkup } : {}),
      };
      if (session.hasPhoto) {
        await session.telegram.editMessageCaption(session.chatId, session.messageId, undefined, caption, {
          ...editOptions,
        });
      } else {
        await session.telegram.editMessageText(session.chatId, session.messageId, undefined, caption, {
          ...editOptions,
        });
      }
    } catch (e) {
      console.error('qr edit failed:', e?.description || e?.message || e);
    }
  };

  const intervalId = setInterval(tick, TICK_MS);
  const timeoutId = setTimeout(() => {
    expireQrSession(userId).catch(() => {});
  }, QR_TTL_MS);

  sessions.set(userId, {
    telegram,
    chatId,
    messageId,
    paymentId,
    amount,
    requisiteId,
    hasPhoto: Boolean(hasPhoto),
    replyMarkup,
    expiresAt,
    intervalId,
    timeoutId,
  });

  void tick();
}

async function cancelQrCountdown(userId, telegram) {
  const session = stopQrCountdown(userId);
  if (!session) return false;
  const api = telegram || session.telegram;
  try {
    await api.deleteMessage(session.chatId, session.messageId);
  } catch (_) {
    /* already deleted */
  }
  try {
    await api.sendMessage(session.chatId, CANCEL_TEXT, {
      parse_mode: 'HTML',
      ...Markup.removeKeyboard(),
    });
  } catch (_) {
    /* ignore */
  }
  return true;
}

module.exports = {
  QR_TTL_MS,
  qrCaption,
  startQrCountdown,
  stopQrCountdown,
  dropQrMessage,
  cancelQrCountdown,
  activeQrCountdownCount,
  waitForQrCountdownsToFinish,
  clearQrDeleteWaiters,
  CANCEL_TEXT,
};

const path = require('path');
const { Users, Transactions, BotSettings } = require('../../models');
const { setUserState, getUserState, clearUserState } = require('../state');
const config = require('../../config');
const { confirmWithdrawKeyboard } = require('../keyboards/adminKeyboard');
const {
  cancelKeyboard,
  mainMenuWithReply,
  isMenuButtonText,
  siteSelectKeyboard,
  isSiteButtonText,
  siteIdFromButton,
  isBackButtonText,
} = require('../keyboards/mainMenu');
const { isAdmin } = require('../adminAuth');
const { tgEmoji } = require('../emoji');
const { SITE_PROVIDERS, getSiteLabel } = require('../../providers');

const WITHDRAW_EMOJI = tgEmoji('5312441427764989435', '💱');
const KEY_EMOJI = tgEmoji('6176966310920983412', '🔑');
const QR_EMOJI = tgEmoji('5381975814415866082', '🪙');

function isValidKgPhone(phone) {
  const digits = String(phone).replace(/\s/g, '');
  if (/^\+996\d{9}$/.test(digits)) return true;
  if (/^996\d{9}$/.test(digits)) return true;
  if (/^0\d{9}$/.test(digits)) return true;
  if (/^\d{9}$/.test(digits)) return true;
  return false;
}

const WITHDRAW_GUIDE_TEXT =
  '📍Заходим👇\n' +
  '📍1. Настройки!\n' +
  '📍2. Вывести со счета!\n' +
  '📍3. MobCash\n' +
  '📍4. Сумму для Вывода!\n' +
  'Город: Бишкек - Flash\n' +
  'или просто Flash\n' +
  '📍5. Подтвердить\n' +
  '📍6. Получить Код!\n' +
  '📍7. Отправить его в бота';

async function startWithdraw(ctx) {
  const availableSites = SITE_PROVIDERS.filter((site) => BotSettings.isEnabled(`site:${site}`));
  if (!availableSites.length) {
    await ctx.reply('Сейчас нет доступных букмекеров для вывода. Попробуйте позже.');
    return;
  }
  setUserState(ctx.from.id, { step: 'withdraw_choose_site' });
  await ctx.replyWithHTML(`${WITHDRAW_EMOJI} Выберите букмекера для вывода:`, siteSelectKeyboard());
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function submitWithdrawRequest(ctx, state, qrPhotoId) {
  const user = Users.getByTelegramId(ctx.from.id);
  if (!user) return;

  const withdrawDetails = `Букмекер: ${getSiteLabel(state.withdraw_site)}\nID букмекера: ${state.withdraw_site_id}\nКод получения: ${state.withdraw_code}\nРеквизиты для выплаты: QR-код приложен`;
  const { transaction_id } = Transactions.create({
    user_id: user.id,
    type: 'withdraw',
    amount: 0,
    withdraw_details: withdrawDetails,
    receipt_photo_id: qrPhotoId,
  });
  const txn = Transactions.getByTransactionId(transaction_id);
  const userLink = user.username
    ? `<a href="https://t.me/${user.username}">${user.first_name || user.username}</a>`
    : `${user.first_name || user.telegram_id}`;
  const channelText = `
🔔 <b>Запрос вывода #${transaction_id}</b>

👤 Пользователь: ${userLink}
🆔 Telegram ID: <code>${user.telegram_id}</code>
🎰 Букмекер: <b>${escapeHtml(getSiteLabel(state.withdraw_site))}</b>
🆔 ID букмекера: <code>${escapeHtml(state.withdraw_site_id)}</code>
🔐 Код получения: <code>${escapeHtml(state.withdraw_code)}</code>
📄 QR-код для выплаты прикреплён к сообщению
🕐 Создано: ${new Date(txn.created_at).toLocaleString('ru-RU')}
  `.trim();

  try {
    await ctx.telegram.sendPhoto(config.bot.channels.withdraw, qrPhotoId, {
      caption: channelText,
      parse_mode: 'HTML',
      ...confirmWithdrawKeyboard(transaction_id, {
        bookmakerId: state.withdraw_site_id,
        withdrawCode: state.withdraw_code,
        userId: user.telegram_id,
      }),
    });
  } catch (error) {
    console.error('[Bot] Failed to send to withdraw channel:', error.message);
    await ctx.reply('⚠️ Не удалось отправить запрос в канал. Обратитесь к администратору.');
    return;
  }

  clearUserState(ctx.from.id);
  await ctx.reply(
    `⏳ Запрос вывода *${transaction_id}* отправлен.\n\nОжидайте подтверждения.`,
    { parse_mode: 'Markdown', ...mainMenuWithReply(isAdmin(ctx.from.id)) }
  );
}

function setupWithdrawHandlers(bot) {
  bot.action('btn_withdraw', async (ctx) => {
    await ctx.answerCbQuery();
    if (isAdmin(ctx.from.id)) return;
    const user = Users.getByTelegramId(ctx.from.id);
    if (!user) return;

    await startWithdraw(ctx);
  });

  bot.on('text', async (ctx, next) => {
    const text = ctx.message.text || '';
    if (text.startsWith('/') || isMenuButtonText(text)) return next();

    const state = getUserState(ctx.from.id);

    if (state.step === 'withdraw_choose_site') {
      if (isBackButtonText(text)) {
        clearUserState(ctx.from.id);
        await ctx.reply('Возврат в меню.', mainMenuWithReply(isAdmin(ctx.from.id)));
        return;
      }
      if (!isSiteButtonText(text)) {
        await ctx.reply('Выберите букмекера кнопкой ниже.', siteSelectKeyboard());
        return;
      }
      const siteId = siteIdFromButton(text);
      if (!SITE_PROVIDERS.includes(siteId) || !BotSettings.isEnabled(`site:${siteId}`)) {
        await ctx.reply('Этот букмекер сейчас недоступен. Выберите другого.', siteSelectKeyboard());
        return;
      }
      setUserState(ctx.from.id, { step: 'withdraw_ask_site_id', withdraw_site: siteId });
      await ctx.reply(`Введите ID букмекера ${getSiteLabel(siteId)}:`, cancelKeyboard());
      return;
    }

    if (state.step === 'withdraw_ask_site_id') {
      const siteId = ctx.message.text.trim();
      if (!siteId) {
        await ctx.reply('⚠️ Введите ID букмекера:', cancelKeyboard());
        return;
      }
      setUserState(ctx.from.id, { ...state, step: 'withdraw_ask_code', withdraw_site_id: siteId });
      const guidePath = path.join(process.cwd(), 'img', 'withdraw-guide.png');
      try {
        await ctx.replyWithPhoto({ source: guidePath }, {
          caption: WITHDRAW_GUIDE_TEXT,
          ...cancelKeyboard(),
        });
      } catch (error) {
        console.error('[Bot] Failed to send withdraw guide image:', error.message);
        await ctx.reply(WITHDRAW_GUIDE_TEXT, cancelKeyboard());
      }
      await ctx.reply(`${KEY_EMOJI} После выполнения инструкции отправьте код получения:`, {
        parse_mode: 'HTML',
        ...cancelKeyboard(),
      });
      return;
    }

    if (state.step === 'withdraw_ask_code') {
      const code = ctx.message.text.trim();
      if (!code) {
        await ctx.reply('⚠️ Отправьте код получения:', cancelKeyboard());
        return;
      }
      setUserState(ctx.from.id, { ...state, withdraw_code: code, step: 'withdraw_ask_qr' });
      await ctx.replyWithHTML(`${QR_EMOJI}Отправьте QR-код Mbank, Bakai, Optima, Obank...`, cancelKeyboard());
      return;
    }

    if (state.step === 'withdraw_ask_qr') {
      await ctx.reply('Отправьте QR-код именно фотографией.', cancelKeyboard());
      return;
    }

    await next();
  });

  bot.on('photo', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (state.step !== 'withdraw_ask_qr') return next();
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    await submitWithdrawRequest(ctx, state, photo.file_id);
  });
}

module.exports = { setupWithdrawHandlers, startWithdraw, isValidKgPhone };

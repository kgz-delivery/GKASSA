const path = require('path');
const { Users, Transactions } = require('../../models');
const { setUserState, getUserState, clearUserState } = require('../state');
const config = require('../../config');
const { confirmWithdrawKeyboard } = require('../keyboards/adminKeyboard');
const { cancelKeyboard, mainMenuWithReply, isMenuButtonText } = require('../keyboards/mainMenu');
const { isAdmin } = require('../adminAuth');
const { tgEmoji } = require('../emoji');

const WITHDRAW_EMOJI = tgEmoji('5312441427764989435', '💱');
const KEY_EMOJI = tgEmoji('6176966310920983412', '🔑');

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
  '📍3. Наличные\n' +
  '📍4. Сумму для Вывода!\n' +
  'Город: Бишкек\n' +
  'Улица: Flash.kg\n' +
  '📍5. Подтвердить\n' +
  '📍6. Получить Код!\n' +
  '📍7. Отправить его в бота';

async function startWithdraw(ctx) {
  setUserState(ctx.from.id, { step: 'withdraw_ask_site_id' });
  await ctx.reply(`${WITHDRAW_EMOJI} Вывод средств\n\nВведите ID букмекера:`, {
    parse_mode: 'HTML',
    ...cancelKeyboard(),
  });
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

    if (state.step === 'withdraw_ask_site_id') {
      const siteId = ctx.message.text.trim();
      if (!siteId) {
        await ctx.reply('⚠️ Введите ID букмекера:', cancelKeyboard());
        return;
      }
      setUserState(ctx.from.id, { step: 'withdraw_ask_code', withdraw_site_id: siteId });
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
      setUserState(ctx.from.id, { ...state, withdraw_code: code, step: 'withdraw_ask_details' });
      await ctx.reply('💳 Теперь отправьте реквизиты, на которые перевести выплату (телефон, карта или кошелёк):', cancelKeyboard());
      return;
    }

    if (state.step === 'withdraw_ask_details') {
      const details = ctx.message.text.trim();
      const user = Users.getByTelegramId(ctx.from.id);
      if (!user) return;

      const isDigitOnly = /^[+\d\s]+$/.test(details);
      if (isDigitOnly && !isValidKgPhone(details)) {
        await ctx.reply(
          '⚠️ Неверный номер телефона Кыргызстана.\n\n' +
          'Примеры правильного формата:\n' +
          '+996777102030\n' +
          '996777102030\n' +
          '0777102030\n' +
          '777102030',
          cancelKeyboard()
        );
        return;
      }

      const withdrawDetails = `ID букмекера: ${state.withdraw_site_id}\nКод получения: ${state.withdraw_code}\nРеквизиты для выплаты: ${details}`;
      const { transaction_id } = Transactions.create({
        user_id: user.id,
        type: 'withdraw',
        amount: 0,
        withdraw_details: withdrawDetails,
      });

      const txn = Transactions.getByTransactionId(transaction_id);

      const userLink = user.username
        ? `<a href="https://t.me/${user.username}">${user.first_name || user.username}</a>`
        : `${user.first_name || user.telegram_id}`;

      const channelText = `
🔔 <b>Запрос вывода #${transaction_id}</b>

👤 Пользователь: ${userLink}
🆔 Telegram ID: <code>${user.telegram_id}</code>
🎰 ID букмекера: <code>${escapeHtml(state.withdraw_site_id)}</code>
🔐 Код получения: <code>${escapeHtml(state.withdraw_code)}</code>
📄 Реквизиты для выплаты: <code>${escapeHtml(details)}</code>
🕐 Создано: ${new Date(txn.created_at).toLocaleString('ru-RU')}
      `.trim();

      try {
        await ctx.telegram.sendMessage(config.bot.channels.withdraw, channelText, {
          parse_mode: 'HTML',
          ...confirmWithdrawKeyboard(transaction_id, {
            bookmakerId: state.withdraw_site_id,
            withdrawCode: state.withdraw_code,
            userId: user.telegram_id,
          }),
        });
      } catch (e) {
        console.error('[Bot] Failed to send to withdraw channel:', e.message);
        await ctx.reply('⚠️ Не удалось отправить запрос в канал. Обратитесь к администратору.');
        return;
      }

      clearUserState(ctx.from.id);
      await ctx.reply(
        `⏳ Запрос вывода *${transaction_id}* отправлен.\n\nОжидайте подтверждения.`,
        { parse_mode: 'Markdown', ...mainMenuWithReply(isAdmin(ctx.from.id)) }
      );
      return;
    }

    await next();
  });
}

module.exports = { setupWithdrawHandlers, startWithdraw, isValidKgPhone };

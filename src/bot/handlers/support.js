const { Markup } = require('telegraf');
const { tgEmoji } = require('../emoji');

function setupSupportHandlers(bot) {
  bot.action('btn_support', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `${tgEmoji('5224615432530461449', '💬')} <b>Поддержка</b>\n\n` +
        'Администратор: @Flash_admin_kg\n' +
        'Поддержка: @Flash_support_kg\n\n' +
        'Мы ответим в ближайшее время.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Меню', 'btn_back_to_menu')]]),
      }
    );
  });
}

module.exports = { setupSupportHandlers };

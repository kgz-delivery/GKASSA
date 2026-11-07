const { Markup } = require('telegraf');
const { adminMenu } = require('./adminKeyboard');
const { BotSettings } = require('../../models');
const { SITE_PROVIDERS, getSiteLabel } = require('../../providers');

function mainMenu(isAdminUser) {
  if (isAdminUser) {
    return adminMenu();
  }
  const buttons = [
    [Markup.button.callback('💎 Пополнить', 'btn_topup')],
    [Markup.button.callback('💵 Вывести', 'btn_withdraw')],
    [Markup.button.callback('💬 Поддержка', 'btn_support')],
  ];
  return Markup.inlineKeyboard(buttons);
}

const MENU_BUTTON_TEXTS = [
  'Пополнить', 'Вывести', 'Поддержка', 'Пригласить друга 🎁', 'Пригласить друга', 'Запросить вывод',
];
const BACK_BUTTON_TEXT = '🔙 Назад';
const MENU_EMOJI_IDS = {
  topup: '5462902520215002477',
  withdraw: '5201873447554145566',
  support: '5253742260054409879',
};
const SITE_BUTTON_MAP = {
  Melbet: 'melbet',
  '1X BET': '1xbet',
  '1WIN': '1win',
  MOSTBET: 'mostbet',
};
const SITE_EMOJI_IDS = {
  melbet: '5240122536506708778',
  '1xbet': '5240186449915039482',
  '1win': '5240296285113701836',
  mostbet: '5240222381611437182',
};

function clientKeyboard() {
  const rows = [
    [
      { text: 'Пополнить', icon_custom_emoji_id: MENU_EMOJI_IDS.topup, style: 'success' },
      { text: 'Вывести', icon_custom_emoji_id: MENU_EMOJI_IDS.withdraw, style: 'primary' },
    ],
    [{ text: 'Поддержка', icon_custom_emoji_id: MENU_EMOJI_IDS.support, style: 'danger' }],
    [{ text: 'Пригласить друга 🎁', icon_custom_emoji_id: '5203996991054432397', style: 'success' }],
  ];
  return Markup.keyboard(rows).resize();
}

function earnMenuKeyboard() {
  return Markup.keyboard([
    [{ text: 'Запросить вывод', style: 'success' }],
    [{ text: 'Пригласить друга 🎁', icon_custom_emoji_id: '5203996991054432397', style: 'primary' }],
    [{ text: BACK_BUTTON_TEXT, style: 'danger' }],
  ]).resize();
}

function siteSelectKeyboard() {
  const enabled = SITE_PROVIDERS.filter((id) => BotSettings.isEnabled(`site:${id}`));
  const rows = [];
  for (let i = 0; i < enabled.length; i += 2) {
    rows.push(enabled.slice(i, i + 2).map((id) => ({
      text: getSiteLabel(id), icon_custom_emoji_id: SITE_EMOJI_IDS[id], style: 'success',
    })));
  }
  rows.push([{ text: BACK_BUTTON_TEXT, style: 'danger' }]);
  return Markup.keyboard(rows).resize();
}

function isSiteButtonText(text) {
  return Object.prototype.hasOwnProperty.call(SITE_BUTTON_MAP, String(text || '').trim());
}

function siteIdFromButton(text) {
  return SITE_BUTTON_MAP[String(text || '').trim()] || null;
}

function playerIdKeyboard(ids) {
  const rows = (ids || []).slice(0, 2).map((id) => [String(id)]);
  rows.push([{ text: BACK_BUTTON_TEXT, style: 'danger' }]);
  return Markup.keyboard(rows).resize();
}

function isMenuButtonText(text) {
  return MENU_BUTTON_TEXTS.includes(String(text || '').trim());
}

function isBackButtonText(text) {
  return String(text || '').trim() === BACK_BUTTON_TEXT;
}

function qrAmountKeyboard() {
  return Markup.keyboard([
    ['10', '100', '200'],
    ['400', '500', '1000'],
    ['2000', '5000', '10000'],
    [{ text: BACK_BUTTON_TEXT, style: 'danger' }],
  ]).resize();
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'btn_cancel')]]);
}

function mainMenuWithReply(isAdminUser) {
  if (isAdminUser) {
    return adminMenu();
  }
  return clientKeyboard();
}

module.exports = {
  mainMenu,
  clientKeyboard,
  earnMenuKeyboard,
  siteSelectKeyboard,
  SITE_EMOJI_IDS,
  playerIdKeyboard,
  qrAmountKeyboard,
  cancelKeyboard,
  mainMenuWithReply,
  isMenuButtonText,
  isBackButtonText,
  isSiteButtonText,
  siteIdFromButton,
  BACK_BUTTON_TEXT,
};

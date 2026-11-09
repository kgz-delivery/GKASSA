const { Markup } = require('telegraf');
const crypto = require('crypto');
const { Requisites, Transactions, Users, BotSettings, PlayerIds } = require('../../models');
const { db } = require('../../database');
const { runManualTopup } = require('../../manualTopups');
const { isAdmin, getAdminRecord } = require('../adminAuth');
const { setUserState, getUserState, clearUserState } = require('../state');
const { applyTopupConfirm, applyWithdrawConfirm } = require('./adminCallbacks');
const { adminMenu, adminMoreMenu, pdfReportsKeyboard } = require('../keyboards/adminKeyboard');
const { createTransactionReport } = require('../reports/pdfReport');
const { markPrizePaid, getPrizeWinner, getPrizePayout, claimPrizePayout, finishPrizePayout, setPrizeWinnerAccount } = require('../../spins');
const { createStyledQrFromTelegramPhoto } = require('../qrRequisites');
const { waitForQrCountdownsToFinish, clearQrDeleteWaiters } = require('../qrTimer');
const config = require('../../config');
const { getPaymentMode, setPaymentMode } = require('../../paymentMode');
const { CRYPTO_PROVIDERS, SITE_PROVIDERS, getProvider, providerLabel, getSiteLabel } = require('../../providers');
const { verifyBookmakerAccount, isBookmakerAccountNotFound, BookmakerAccountCheckConfigError } = require('../../bookmakerAccounts');
const { isMobcashEnabledFor } = require('../../mobcashConfig');
const { playerIdKeyboard } = require('../keyboards/mainMenu');

let broadcastInProgress = false;

function parseCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(value.trim());
      value = '';
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error('Незакрытая кавычка в CSV.');
  fields.push(value.trim());
  return fields;
}

function parseManualTopupRows(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length && /^bookmaker\s*,/i.test(lines[0])) lines.shift();
  if (!lines.length || lines.length > 50) throw new Error('Добавьте от 1 до 50 строк.');
  return lines.map((line, index) => {
    const fields = parseCsvLine(line);
    if (fields.length < 4) throw new Error(`Строка ${index + 1}: формат bookmaker, player_id, amount, reason.`);
    const [bookmaker, playerId, amountText, ...reasonParts] = fields;
    const amount = Number(amountText);
    const reason = reasonParts.join(',').trim();
    if (!/^[a-z0-9]+$/i.test(bookmaker) || !playerId || !Number.isSafeInteger(amount) || amount <= 0 || !reason) {
      throw new Error(`Строка ${index + 1}: проверьте букмекера, ID, целую сумму и причину.`);
    }
    return { bookmaker: bookmaker.toLowerCase(), playerId, amount, reason };
  });
}

async function sendManualTopupPreview(ctx, rows) {
  setUserState(ctx.from.id, { step: 'admin_manual_topup_preview', rows });
  const preview = rows.map((row, index) => `${index + 1}. ${row.bookmaker} | ${row.playerId} | ${row.amount} сом | ${row.reason}`).join('\n');
  const header = `Предпросмотр (${rows.length} строк):\n`;
  for (let offset = 0; offset < preview.length; offset += 3500) {
    await ctx.reply(`${offset === 0 ? header : ''}${preview.slice(offset, offset + 3500)}`);
  }
  await ctx.reply('Подтвердить обработку всех строк?', Markup.inlineKeyboard([
    [Markup.button.callback('✅ Подтвердить все', 'admin_manual_topup_confirm')],
    [Markup.button.callback('❌ Отмена', 'admin_manual_topup_cancel')],
  ]));
}

async function executeAdminManualTopup(ctx, state, amount) {
  clearUserState(ctx.from.id);
  try {
    const result = await runManualTopup({
      adminTelegramId: ctx.from.id,
      bookmaker: state.bookmaker,
      playerId: state.playerId,
      amount,
      reason: 'Ручное пополнение из админки',
    });
    if (['success', 'unknown'].includes(result.state)) {
      await ctx.reply(`✅ Успешно\n${getSiteLabel(state.bookmaker)} | ID ${state.playerId} | ${amount} сом`, adminMenu());
    } else if (result.state === 'dry_run') {
      await ctx.reply('⚠️ Пополнение не отправлено: включён тестовый режим API.', adminMenu());
    } else {
      await ctx.reply(`❌ Не удалось пополнить: ${result.error || result.state}`, adminMenu());
    }
  } catch (error) {
    await ctx.reply(`❌ Не удалось пополнить: ${error.message}`, adminMenu());
  }
}

function escapeMarkdown(value) {
  return String(value || '').replace(/[\\_*`\[\]]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

async function waitForRequisiteCountdowns(ctx, requisiteId) {
  const activeCount = waitForQrCountdownsToFinish(ctx.telegram, requisiteId, ctx.from.id);
  if (activeCount === 0) return false;

  await ctx.answerCbQuery('⏳ Дождитесь завершения отсчётов');
  await ctx.reply(
    `⏳ Реквизит #${requisiteId} сейчас используется в ${activeCount} активн${activeCount === 1 ? 'ом отсчёте' : 'ых отсчётах'}. Подожду их завершения и сообщу, когда реквизит можно будет удалить.`
  );
  await renderRequisites(ctx, true);
  return true;
}

function userLabel(user) {
  const nick = user.username ? `@${user.username}` : 'без ника';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || '-';
  return `${name} (${nick})\n🆔 Telegram ID: \`${user.telegram_id}\``;
}

async function resolveUserFromQuery(ctx, raw) {
  const query = String(raw || '').trim();
  if (!query) return null;

  const found = Users.find(query);
  if (found) return found;

  const nick = query.replace(/^@/, '');
  try {
    const chat = /^\d+$/.test(nick)
      ? await ctx.telegram.getChat(Number(nick))
      : await ctx.telegram.getChat('@' + nick);
    if (chat?.id) {
      return Users.createOrUpdate(chat.id, {
        username: chat.username,
        first_name: chat.first_name,
        last_name: chat.last_name,
      });
    }
  } catch (_) {
    /* user may never have talked to the bot */
  }

  if (/^\d+$/.test(nick)) {
    return {
      telegram_id: Number(nick),
      username: null,
      first_name: null,
      last_name: null,
      active: 1,
    };
  }
  return null;
}

async function notifyBanned(ctx, telegramId) {
  await ctx.telegram.sendMessage(
    telegramId,
    '🚫 Вы забанены. Смена ника не поможет — бан привязан к вашему Telegram ID.\nОбратитесь в поддержку: @Flash_admin_kg'
  ).catch(() => {});
}

function isBanCommandText(text) {
  return /^\/ban(?:@\S+)?\s*$/i.test(String(text || '').trim());
}

function isUnbanCommandText(text) {
  return /^\/unban(?:@\S+)?\s*$/i.test(String(text || '').trim());
}

function isNotifyChannel(chatId) {
  const ids = [config.bot.channels.topup, config.bot.channels.withdraw].filter(Boolean);
  return ids.map(String).includes(String(chatId));
}

function userStub(telegramId) {
  return Users.getByTelegramIdAny(telegramId) || {
    telegram_id: telegramId,
    username: null,
    first_name: null,
    last_name: null,
    active: 1,
  };
}

function userFromNoticeMessage(msg) {
  if (!msg) return null;
  const text = msg.caption || msg.text || '';
  const tgMatch = text.match(/Telegram ID:\s*(?:<code>)?(\d{5,})/i);
  if (tgMatch) return userStub(Number(tgMatch[1]));

  const entities = msg.caption_entities || msg.entities || [];
  for (const ent of entities) {
    if (ent.type !== 'code' && ent.type !== 'pre') continue;
    const chunk = text.slice(ent.offset, ent.offset + ent.length);
    if (/^\d{5,}$/.test(chunk)) return userStub(Number(chunk));
  }

  const txnMatch = text.match(/#(TXN-[A-F0-9]+)/i);
  if (txnMatch) {
    const txn = Transactions.getByTransactionId(txnMatch[1].toUpperCase());
    if (txn) return Users.getById(txn.user_id) || null;
  }
  return null;
}

function canBanFromChat(ctx) {
  const chatId = ctx.chat?.id || ctx.channelPost?.chat?.id || ctx.message?.chat?.id;
  if (isNotifyChannel(chatId)) return true;
  return Boolean(ctx.from && isAdmin(ctx.from.id));
}

async function applyBan(ctx, user, options = {}) {
  if (ctx.from) clearUserState(ctx.from.id);
  if (isAdmin(user.telegram_id)) {
    await ctx.reply('⚠️ Нельзя забанить администратора.');
    return;
  }
  Users.banByTelegramId(user.telegram_id, {
    username: user.username,
    first_name: user.first_name,
    last_name: user.last_name,
  });
  clearUserState(user.telegram_id);
  await notifyBanned(ctx, user.telegram_id);
  const isInChannel = options.inChannel || isNotifyChannel(ctx.chat?.id || ctx.channelPost?.chat?.id || ctx.message?.chat?.id);
  const extra = isInChannel ? { parse_mode: 'Markdown' } : { parse_mode: 'Markdown', ...adminMenu() };
  await ctx.reply(
    `🚫 Пользователь забанен.\n\n${userLabel(user)}\n\n`,
    extra
  ).catch((e) => console.error('[Ban] Failed to reply:', e.message));
}

async function applyUnban(ctx, user, options = {}) {
  if (ctx.from) clearUserState(ctx.from.id);
  const isInChannel = options.inChannel || isNotifyChannel(ctx.chat?.id || ctx.channelPost?.chat?.id || ctx.message?.chat?.id);
  if (user.active === 1) {
    await ctx.reply(`✅ Пользователь уже не в бане.\n\n${userLabel(user)}`, {
      parse_mode: 'Markdown',
      ...(isInChannel ? {} : adminMenu()),
    });
    return;
  }
  Users.unbanByTelegramId(user.telegram_id);
  await ctx.telegram.sendMessage(
    user.telegram_id,
    '✅ Ваш бан снят. Вы снова можете пользоваться ботом.'
  ).catch(() => {});
  const extra = isInChannel ? { parse_mode: 'Markdown' } : { parse_mode: 'Markdown', ...adminMenu() };
  await ctx.reply(`✅ Пользователь разбанен.\n\n${userLabel(user)}`, extra);
}

async function handleBanReply(ctx) {
  const msg = ctx.channelPost || ctx.message;
  if (!msg || !isBanCommandText(msg.text || msg.caption)) return false;
  const reply = msg.reply_to_message;
  if (!reply) return false;
  if (!canBanFromChat(ctx)) {
    if (ctx.from) await ctx.reply('⛔ Доступ запрещен.');
    return true;
  }
  const user = userFromNoticeMessage(reply);
  if (!user) {
    await ctx.reply('⚠️ Не удалось определить пользователя из этого сообщения. Ответьте /ban на заявку бота.');
    return true;
  }
  const chatId = msg.chat?.id;
  await applyBan(ctx, user, { inChannel: ctx.channelPost || isNotifyChannel(chatId) });
  return true;
}

async function handleUnbanReply(ctx) {
  const msg = ctx.channelPost || ctx.message;
  if (!msg || !isUnbanCommandText(msg.text || msg.caption)) return false;
  const reply = msg.reply_to_message;
  if (!reply) return false;
  if (!canBanFromChat(ctx)) {
    if (ctx.from) await ctx.reply('⛔ Доступ запрещен.');
    return true;
  }
  const user = userFromNoticeMessage(reply);
  if (!user) {
    await ctx.reply('⚠️ Не удалось определить пользователя из этого сообщения. Ответьте /unban на заявку бота.');
    return true;
  }
  const chatId = msg.chat?.id;
  await applyUnban(ctx, user, { inChannel: ctx.channelPost || isNotifyChannel(chatId) });
  return true;
}

const UNBAN_PAGE_SIZE = 8;

function unbanSectionContent(page = 0) {
  const banned = Users.getBanned();
  if (banned.length === 0) {
    return {
      text: '✅ *Разбан*\n\nСейчас никто не забанен.',
      extra: adminMenu(),
    };
  }
  const maxPage = Math.max(0, Math.ceil(banned.length / UNBAN_PAGE_SIZE) - 1);
  const safePage = Math.min(Math.max(0, page), maxPage);
  const slice = banned.slice(safePage * UNBAN_PAGE_SIZE, (safePage + 1) * UNBAN_PAGE_SIZE);

  let text = `✅ *Разбан*\n\nНажмите на пользователя, чтобы снять бан.\nИли отправьте Telegram ID / @username.\n\nВсего в бане: *${banned.length}*`;
  if (maxPage > 0) text += ` · стр. ${safePage + 1}/${maxPage + 1}`;
  text += '\n';

  const rows = slice.map((u) => {
    const nick = u.username ? `@${u.username}` : String(u.telegram_id);
    const name = u.first_name || nick;
    return [Markup.button.callback(`✅ ${name} · ${nick}`, `admin_unban_by_id:${u.id}`)];
  });

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback('⬅️', `admin_unban_page:${safePage - 1}`));
  if (safePage < maxPage) nav.push(Markup.button.callback('➡️', `admin_unban_page:${safePage + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('🔙 Админ меню', 'admin_back')]);

  return { text, extra: Markup.inlineKeyboard(rows) };
}

async function renderUnbanSection(ctx, page = 0, edit = true) {
  setUserState(ctx.from.id, { step: 'admin_unban_user' });
  const { text, extra } = unbanSectionContent(page);
  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...extra });
      return;
    } catch (_) {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', ...extra });
}

function addRequisiteKindKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💳 QR BANK', 'admin_req_kind:bank_qr')],
    [Markup.button.callback('🪙 Крипта', 'admin_req_kind:crypto')],
    [Markup.button.callback('🎰 Сайты', 'admin_site_add')],
    [Markup.button.callback('🔙 Назад', 'admin_requisites')],
  ]);
}

function addRequisiteProviderKeyboard(kind) {
  const ids = kind === 'crypto' ? CRYPTO_PROVIDERS : [];
  const rows = ids.map((id) => [Markup.button.callback(providerLabel(id), `admin_req_prov:${id}`)]);
  rows.push([Markup.button.callback('🔙 Назад', 'admin_req_add')]);
  return Markup.inlineKeyboard(rows);
}

function addSiteKeyboard() {
  const rows = SITE_PROVIDERS.map((id) => [
    Markup.button.callback(getSiteLabel(id), `admin_site_req:${id}`),
  ]);
  rows.push([Markup.button.callback('🔙 Назад', 'admin_req_add')]);
  return Markup.inlineKeyboard(rows);
}

async function renderSiteRequisites(ctx, edit = true) {
  const siteRequisites = SITE_PROVIDERS
    .map((id) => ({ id, requisite: Requisites.getActiveBySite(id) }))
    .filter((item) => item.requisite);

  let text = '🎰 *Сайты для пополнения*\n\nАктивный реквизит на каждый сайт.\n\n';
  if (siteRequisites.length === 0) {
    text += 'Пока ничего не загружено.';
  } else {
    siteRequisites.forEach(({ id, requisite }) => {
      text += `✅ #${requisite.id} ${getSiteLabel(id)}\n`;
    });
  }

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить / заменить сайт', 'admin_site_add')],
    ...siteRequisites.map(({ id, requisite }) => [
      Markup.button.callback(`✅ ${getSiteLabel(id)} #${requisite.id}`, `admin_site_setactive:${requisite.id}`),
      Markup.button.callback('🗑', `admin_req_delete:${requisite.id}`),
    ]),
    [Markup.button.callback('🔙 Админ меню', 'admin_back')],
  ]);

  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb });
      return;
    } catch (_) {}
  }
  await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
}

async function renderRequisites(ctx, edit = true) {
  const requisites = Requisites.getAll();
  let text = '💳 *Реквизиты*\n\nАктивен один QR на каждый способ. Новое фото заменяет текущее.\n\n';
  if (requisites.length === 0) {
    text += 'Пока ничего не загружено.';
  } else {
    requisites.slice(0, 15).forEach((r) => {
      const mark = r.is_active ? '✅' : '⏸';
      text += `${mark} #${r.id} ${providerLabel(r.provider)}`;
      if (r.wallet_address) text += ` | \`${r.wallet_address.slice(0, 12)}…\``;
      if (r.details) {
        const signature = String(r.details).replace(/\s+/g, ' ').trim().slice(0, 100);
        text += ` — ${escapeMarkdown(signature)}`;
      }
      text += '\n';
    });
  }

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить / заменить QR', 'admin_req_add')],
    ...requisites.slice(0, 6).map((r) => [
      Markup.button.callback(
        `${r.is_active ? '✅' : '▶️'} ${providerLabel(r.provider)} #${r.id}`,
        `admin_req_setactive:${r.id}`
      ),
      Markup.button.callback('🗑', `admin_req_delete:${r.id}`),
    ]),
    [Markup.button.callback('🔙 Админ меню', 'admin_back')],
  ]);

  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'Markdown', ...kb });
      return;
    } catch (_) {
      /* fall through */
    }
  }
  await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
}

async function executeSpinPrizeTopup(ctx, { resultId, bookmaker, playerId, noticeChatId, noticeMessageId }) {
  const claim = claimPrizePayout({ resultId, telegramAdminId: ctx.from.id, bookmaker, playerId });
  if (!claim.claimed) {
    const text = claim.reason === 'sending'
      ? 'Пополнение этого выигрыша уже выполняется.'
      : 'Этот выигрыш уже обработан.';
    await ctx.reply(text);
    return false;
  }

  clearUserState(ctx.from.id);
  const amount = claim.prize.prize_amount;
  try {
    const result = await runManualTopup({
      adminTelegramId: ctx.from.id,
      bookmaker,
      playerId,
      amount,
      reason: `Выигрыш фриспина #${resultId}`,
    });
    const settled = ['success', 'unknown'].includes(result.state);
    finishPrizePayout(resultId, ctx.from.id, settled ? result.state : 'failed', result.error || null);
    if (!settled) {
      await ctx.reply(result.state === 'dry_run'
        ? '⚠️ Пополнение не отправлено: включён тестовый режим API.'
        : `❌ Не удалось пополнить приз: ${result.error || result.state}`);
      return false;
    }

    await ctx.reply(`✅ Приз успешно пополнен\n${getSiteLabel(bookmaker)} | ID ${playerId} | ${amount} сом`);
    const winner = getPrizeWinner(resultId);
    if (winner) {
      await ctx.telegram.sendMessage(
        winner.telegram_id,
        `✅ Выигрыш ${amount} сом зачислен на ваш счёт в ${getSiteLabel(bookmaker)}.`
      ).catch(() => {});
      if (noticeChatId && noticeMessageId) {
        await ctx.telegram.editMessageReplyMarkup(
          noticeChatId,
          noticeMessageId,
          undefined,
          { inline_keyboard: [[Markup.button.url('💬 Связаться с победителем', `tg://user?id=${winner.telegram_id}`)]] }
        ).catch(() => {});
      }
    }
    return true;
  } catch (error) {
    finishPrizePayout(resultId, ctx.from.id, 'failed', error.message);
    await ctx.reply(`❌ Не удалось пополнить приз: ${error.message}`);
    return false;
  }
}

function setupAdminBotHandlers(bot) {
  bot.action('admin_manual_topup', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    await ctx.answerCbQuery();
    setUserState(ctx.from.id, { step: 'admin_manual_topup_choose_bookmaker' });
    await ctx.reply('Выберите букмекера:', Markup.inlineKeyboard([
      [Markup.button.callback('1xBet', 'admin_manual_bookmaker:1xbet'), Markup.button.callback('Melbet', 'admin_manual_bookmaker:melbet')],
      [Markup.button.callback('Mostbet', 'admin_manual_bookmaker:mostbet'), Markup.button.callback('1win', 'admin_manual_bookmaker:1win')],
      [Markup.button.callback('❌ Отмена', 'admin_manual_topup_cancel')],
    ]));
  });

  bot.action('admin_manual_topup_bulk', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    setUserState(ctx.from.id, { step: 'admin_manual_topup_input' });
    await ctx.answerCbQuery();
    await ctx.reply(
      'Отправьте строки CSV/текста: bookmaker, player_id, amount, reason.\n' +
      'Пример: 1xbet, 123456789, 500, розыгрыш\nМаксимум 50 строк. Для отмены: /cancel'
    );
  });

  bot.action(/^admin_manual_bookmaker:(1xbet|melbet|mostbet|1win)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const state = getUserState(ctx.from.id);
    if (state.step !== 'admin_manual_topup_choose_bookmaker') {
      return ctx.answerCbQuery('Начните пополнение заново.', { show_alert: true });
    }
    const bookmaker = ctx.match[1];
    setUserState(ctx.from.id, { step: 'admin_manual_topup_player_id', bookmaker });
    await ctx.answerCbQuery();
    await ctx.reply(`Букмекер: ${getSiteLabel(bookmaker)}\nВведите ID букмекера. Для отмены: /cancel`);
  });

  bot.action(/^admin_manual_amount:(35|50|100)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const state = getUserState(ctx.from.id);
    if (state.step !== 'admin_manual_topup_choose_amount' || !state.bookmaker || !state.playerId) {
      return ctx.answerCbQuery('Сначала выберите букмекера и введите ID.', { show_alert: true });
    }
    await ctx.answerCbQuery('Отправляю запрос…');
    await executeAdminManualTopup(ctx, state, Number(ctx.match[1]));
  });

  bot.action('admin_manual_amount_custom', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const state = getUserState(ctx.from.id);
    if (state.step !== 'admin_manual_topup_choose_amount' || !state.bookmaker || !state.playerId) {
      return ctx.answerCbQuery('Сначала выберите букмекера и введите ID.', { show_alert: true });
    }
    setUserState(ctx.from.id, { ...state, step: 'admin_manual_topup_custom_amount' });
    await ctx.answerCbQuery();
    await ctx.reply('Введите сумму целым числом в сомах. Для отмены: /cancel');
  });

  bot.action('admin_manual_topup_cancel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    clearUserState(ctx.from.id);
    await ctx.answerCbQuery('Отменено');
    await ctx.editMessageText('Ручное пополнение отменено.', adminMenu());
  });

  bot.action('admin_manual_topup_confirm', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const state = getUserState(ctx.from.id);
    if (state.step !== 'admin_manual_topup_preview' || !Array.isArray(state.rows)) {
      return ctx.answerCbQuery('Предпросмотр устарел. Начните заново.', { show_alert: true });
    }
    clearUserState(ctx.from.id);
    await ctx.answerCbQuery('Запускаю пополнения…');
    const results = [];
    for (const row of state.rows) {
      try {
        const result = await runManualTopup({ adminTelegramId: ctx.from.id, ...row });
        results.push({ row, status: result.state, details: result.error || '' });
      } catch (error) {
        results.push({ row, status: 'rejected', details: error.message });
      }
    }
    const lines = results.map(({ row, status, details }, index) =>
      `${index + 1}. ${row.bookmaker} | ${row.playerId} | ${row.amount} сом — ${status}${details ? ` (${details})` : ''}`
    );
    const report = `Отчёт по ручному пополнению:\n${lines.join('\n')}`;
    for (let offset = 0; offset < report.length; offset += 3500) {
      await ctx.reply(report.slice(offset, offset + 3500));
    }
  });

  bot.action('admin_manual_roles', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const actingAdmin = db.prepare('SELECT role FROM admins WHERE user_id = ? AND active = 1').get(ctx.from.id);
    if (!actingAdmin || !['admin', 'superadmin'].includes(String(actingAdmin.role).toLowerCase())) {
      return ctx.answerCbQuery('Эти настройки доступны только superadmin', { show_alert: true });
    }
    await ctx.answerCbQuery();
    const admins = db.prepare('SELECT * FROM admins WHERE active = 1 ORDER BY user_id').all();
    const rows = [];
    for (const admin of admins) {
      const role = ['admin', 'superadmin'].includes(String(admin.role).toLowerCase()) ? 'superadmin' : 'operator';
      rows.push([Markup.button.callback(
        `${admin.user_id}: ${role} | ${admin.manual_limit || 0}/${admin.daily_limit || 0} сом`,
        `admin_role_view:${admin.id}`
      )]);
    }
    rows.push([Markup.button.callback('🔙 Админ-панель', 'admin_panel')]);
    await ctx.editMessageText('👮 Роли и лимиты администраторов:', { reply_markup: { inline_keyboard: rows } });
  });

  bot.action(/^admin_role_view:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const actingAdmin = db.prepare('SELECT role FROM admins WHERE user_id = ? AND active = 1').get(ctx.from.id);
    if (!actingAdmin || !['admin', 'superadmin'].includes(String(actingAdmin.role).toLowerCase())) {
      return ctx.answerCbQuery('Эти настройки доступны только superadmin', { show_alert: true });
    }
    const target = db.prepare('SELECT * FROM admins WHERE id = ? AND active = 1').get(Number(ctx.match[1]));
    if (!target) return ctx.answerCbQuery('Администратор не найден');
    const role = ['admin', 'superadmin'].includes(String(target.role).toLowerCase()) ? 'superadmin' : 'operator';
    await ctx.answerCbQuery();
    await ctx.editMessageText(`Администратор ${target.user_id}\nРоль: ${role}\nЛимит на операцию: ${target.manual_limit || 0}\nДневной лимит: ${target.daily_limit || 0}`, {
      reply_markup: { inline_keyboard: [
        [Markup.button.callback(role === 'operator' ? 'Назначить superadmin' : 'Назначить operator', `admin_role_set:${target.id}:${role === 'operator' ? 'superadmin' : 'operator'}`)],
        [Markup.button.callback('⚙️ Настроить лимиты', `admin_role_limits:${target.id}`)],
        [Markup.button.callback('🔙 К списку', 'admin_manual_roles')],
      ] },
    });
  });

  bot.action(/^admin_role_set:(\d+):(operator|superadmin)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const actingAdmin = db.prepare('SELECT role FROM admins WHERE user_id = ? AND active = 1').get(ctx.from.id);
    if (!actingAdmin || !['admin', 'superadmin'].includes(String(actingAdmin.role).toLowerCase())) {
      return ctx.answerCbQuery('Эти настройки доступны только superadmin', { show_alert: true });
    }
    const target = db.prepare('SELECT * FROM admins WHERE id = ? AND active = 1').get(Number(ctx.match[1]));
    if (!target) return ctx.answerCbQuery('Администратор не найден');
    const targetIsSuperadmin = ['admin', 'superadmin'].includes(String(target.role).toLowerCase());
    if (targetIsSuperadmin && ctx.match[2] === 'operator') {
      const count = db.prepare("SELECT COUNT(*) AS count FROM admins WHERE active = 1 AND role IN ('admin', 'superadmin')").get().count;
      if (count <= 1) return ctx.answerCbQuery('Нельзя снять права у последнего superadmin', { show_alert: true });
    }
    db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(ctx.match[2], Number(ctx.match[1]));
    db.prepare(`INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'admin.role_updated', 'admin', ?, ?)`)
      .run(ctx.from.id, ctx.match[1], JSON.stringify({ role: ctx.match[2] }));
    await ctx.answerCbQuery('Роль обновлена');
    await ctx.editMessageText('Роль обновлена.', { reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 К списку', 'admin_manual_roles')]] } });
  });

  bot.action(/^admin_role_limits:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const actingAdmin = db.prepare('SELECT role FROM admins WHERE user_id = ? AND active = 1').get(ctx.from.id);
    if (!actingAdmin || !['admin', 'superadmin'].includes(String(actingAdmin.role).toLowerCase())) {
      return ctx.answerCbQuery('Эти настройки доступны только superadmin', { show_alert: true });
    }
    const target = db.prepare('SELECT * FROM admins WHERE id = ? AND active = 1').get(Number(ctx.match[1]));
    if (!target) return ctx.answerCbQuery('Администратор не найден');
    setUserState(ctx.from.id, { step: 'admin_operator_limit_per_operation', targetAdminId: target.id });
    await ctx.answerCbQuery();
    await ctx.reply(`Введите лимит на одну операцию для ${target.user_id} в сомах (целое число).`);
  });

  bot.action('admin_optima_template', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    await ctx.answerCbQuery();
    const bank = db.prepare("SELECT * FROM banks WHERE bank_code = 'optima'").get();
    const template = bank && db.prepare(`
      SELECT * FROM bank_templates WHERE bank_id = ? ORDER BY id DESC LIMIT 1
    `).get(bank.id);
    if (!bank) return ctx.editMessageText('Банк Optima не настроен.', adminMenu());
    const text = `🏦 Optima\nСтатус: ${bank.is_active ? 'включён' : 'выключен'}\nPackage name: ${bank.package_name || 'не задан'}\n` +
      `Regex суммы: ${template?.regex_amount || 'не задан'}\nRegex отправителя: ${template?.regex_sender || 'не задан'}`;
    await ctx.editMessageText(text, { reply_markup: { inline_keyboard: [
      [Markup.button.callback('✏️ Package name', 'optima_edit:package_name')],
      [Markup.button.callback('✏️ Regex суммы', 'optima_edit:regex_amount')],
      [Markup.button.callback('✏️ Regex отправителя', 'optima_edit:regex_sender')],
      [Markup.button.callback(bank.is_active ? '⏸ Отключить' : '▶️ Включить', 'optima_toggle')],
      [Markup.button.callback('🔙 Админ-панель', 'admin_panel')],
    ] } });
  });

  bot.action(/^optima_edit:(package_name|regex_amount|regex_sender)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const field = ctx.match[1];
    setUserState(ctx.from.id, { step: 'admin_optima_edit', field });
    await ctx.answerCbQuery();
    await ctx.reply(`Отправьте новое значение для ${field}. Для отмены нажмите /cancel.`);
  });

  bot.action('optima_toggle', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const bank = db.prepare("SELECT * FROM banks WHERE bank_code = 'optima'").get();
    const next = bank?.is_active ? 0 : 1;
    db.prepare("UPDATE banks SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE bank_code = 'optima'").run(next);
    await ctx.answerCbQuery(next ? 'Optima включён' : 'Optima отключён');
    await ctx.editMessageText(`Optima ${next ? 'включён' : 'отключён'}.`, {
      reply_markup: { inline_keyboard: [[Markup.button.callback('🔙 Настройки Optima', 'admin_optima_template')]] },
    });
  });

  bot.action('admin_payment_review', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    await ctx.answerCbQuery();
    const payments = db.prepare(`
      SELECT * FROM incoming_payments WHERE status = 'manual_review'
      ORDER BY received_at ASC LIMIT 20
    `).all();
    if (!payments.length) {
      await ctx.editMessageText('✅ Нет платежей на ручной проверке.', adminMenu());
      return;
    }
    const rows = [];
    let text = '⚠️ Платежи на ручной проверке\n\n';
    for (const payment of payments) {
      const candidates = db.prepare(`
        SELECT id FROM orders
        WHERE bank_id = ? AND amount_unique_cents = ?
          AND status IN ('pending', 'expired', 'manual_review')
        ORDER BY created_at DESC LIMIT 5
      `).all(payment.bank_id, payment.amount_unique_cents);
      text += `Платёж #${payment.id} | ${payment.bank_code} | ${(payment.amount_unique_cents / 100).toFixed(2)} сом\n` +
        `Отправитель: ${payment.sender || 'не распознан'}\nПричина: ${payment.review_note || 'нет совпадения'}\n` +
        `Push: ${payment.raw_text.slice(0, 350)}\n\n`;
      for (const candidate of candidates) {
        rows.push([Markup.button.callback(`✅ Платёж #${payment.id} → заявка #${candidate.id}`, `payreview_assign:${payment.id}:${candidate.id}`)]);
      }
      rows.push([Markup.button.callback(`❌ Отклонить платёж #${payment.id}`, `payreview_reject:${payment.id}`)]);
    }
    rows.push([Markup.button.callback('🔄 Обновить', 'admin_payment_review'), Markup.button.callback('🔙 Админ-панель', 'admin_panel')]);
    await ctx.editMessageText(text.slice(0, 3900), { reply_markup: { inline_keyboard: rows.slice(0, 50).map((row) => row.map((button) => button)) } });
  });

  bot.action(/^payreview_assign:(\d+):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    await ctx.answerCbQuery('Обрабатываю платёж…');
    const { assignIncomingPaymentToOrder } = require('../../paymentApi');
    const result = await assignIncomingPaymentToOrder(Number(ctx.match[1]), Number(ctx.match[2]), ctx.from.id);
    await ctx.reply(result.ok
      ? `✅ Платёж #${ctx.match[1]} привязан к заявке #${ctx.match[2]}. Результат зачисления: ${result.outcome}.`
      : '⚠️ Платёж или заявка уже обработаны либо суммы не совпадают.');
  });

  bot.action(/^payreview_reject:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    const { rejectIncomingPayment } = require('../../paymentApi');
    const rejected = rejectIncomingPayment(Number(ctx.match[1]), ctx.from.id);
    await ctx.answerCbQuery(rejected ? 'Платёж отклонён' : 'Платёж уже обработан');
    if (rejected) await ctx.reply(`❌ Платёж #${ctx.match[1]} отклонён. Возврат проводится вне бота.`);
  });

  bot.on('channel_post', async (ctx, next) => {
    if (await handleBanReply(ctx)) return;
    if (await handleUnbanReply(ctx)) return;
    return next();
  });

  bot.action('admin_panel', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ У вас нет доступа к админ-панели.');
      return;
    }
    await ctx.reply('🔐 *Админ панель*\n\nВыберите действие:', {
      parse_mode: 'Markdown',
      ...adminMenu(),
    });
  });

  bot.action('admin_more', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');
    clearUserState(ctx.from.id);
    await ctx.answerCbQuery();
    await ctx.editMessageText('➕ Ещё функции админки:', adminMoreMenu());
  });

  bot.action('admin_toggle_payment_mode', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён');

    const currentMode = getPaymentMode();
    const nextMode = currentMode === 'auto' ? 'manual' : 'auto';
    if (nextMode === 'auto' && config.paymentAutomation.autoConfirmMaxSom <= 0) {
      await ctx.answerCbQuery(
        'Автооплата не настроена: задайте AUTO_CONFIRM_MAX_SOM в Render.',
        { show_alert: true }
      );
      return;
    }

    setPaymentMode(nextMode);
    db.prepare(`
      INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
      VALUES (?, 'payment.mode_changed', 'setting', 'payment_mode', ?)
    `).run(ctx.from.id, JSON.stringify({ from: currentMode, to: nextMode }));

    await ctx.answerCbQuery(nextMode === 'auto' ? 'Автооплата включена' : 'Включена ручная проверка');
    await ctx.editMessageText('➕ Ещё функции админки:', adminMoreMenu());
  });

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ У вас нет доступа к админ-панели.');
      return;
    }
    await ctx.reply('🔐 *Админ панель*\n\nВыберите действие:', {
      parse_mode: 'Markdown',
      ...adminMenu(),
    });
  });

  bot.command('checkadmin', (ctx) => {
    if (isAdmin(ctx.from.id)) {
      ctx.reply('✅ Вы администратор.');
    } else {
      ctx.reply('❌ Вы не администратор.');
    }
  });

  bot.action('admin_stats', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const stats = Transactions.getStats();
    const userStats = Users.getStats();
    const byProvider = Transactions.getStatsByProvider();
    const today = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE auto_confirmed = 1 AND status = 'completed' AND date(paid_at, '+6 hours') = date('now', '+6 hours')) AS auto_count,
        (SELECT COALESCE(SUM(amount_requested), 0) FROM orders WHERE auto_confirmed = 1 AND status = 'completed' AND date(paid_at, '+6 hours') = date('now', '+6 hours')) AS auto_sum,
        (SELECT COUNT(*) FROM transactions WHERE type = 'topup' AND status = 'confirmed' AND payment_order_id IS NOT NULL
          AND payment_order_id IN (SELECT id FROM orders WHERE auto_confirmed = 0)
          AND date(confirmed_at, '+6 hours') = date('now', '+6 hours')) AS manual_order_count,
        (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'topup' AND status = 'confirmed' AND payment_order_id IS NOT NULL
          AND payment_order_id IN (SELECT id FROM orders WHERE auto_confirmed = 0)
          AND date(confirmed_at, '+6 hours') = date('now', '+6 hours')) AS manual_order_sum,
        (SELECT COUNT(*) FROM manual_topups WHERE status = 'completed' AND date(completed_at, '+6 hours') = date('now', '+6 hours')) AS manual_direct_count,
        (SELECT COALESCE(SUM(amount), 0) FROM manual_topups WHERE status = 'completed' AND date(completed_at, '+6 hours') = date('now', '+6 hours')) AS manual_direct_sum
    `).get();

    let text =
      '📊 *Статистика*\n\n' +
      `💰 Пополнений: *${stats.topups.count}* на *${Number(stats.topups.sum || 0).toFixed(2)}* сом\n` +
      `💸 Выводов: *${stats.withdrawals.count}* на *${Number(stats.withdrawals.sum || 0).toFixed(2)}* сом\n` +
      `\n*Сегодня:*\n` +
      `Автоподтверждено: *${today.auto_count}* / *${Number(today.auto_sum).toFixed(2)}* сом\n` +
      `Вручную: *${today.manual_order_count + today.manual_direct_count}* / *${Number(today.manual_order_sum + today.manual_direct_sum).toFixed(2)}* сом\n` +
      `⏳ Ожидают пополнения: *${stats.pending.topups}*\n` +
      `⏳ Ожидают вывода: *${stats.pending.withdrawals}*\n\n` +
      `👥 Пользователей: *${userStats.total}* (активных ${userStats.active}, в бане ${userStats.banned})\n`;

    if (byProvider.length) {
      text += '\n*По способам пополнения:*\n';
      byProvider.forEach((row) => {
        text += `• ${providerLabel(row.provider)}: ${row.c} / ${Number(row.sum).toFixed(2)} сом\n`;
      });
    }

    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...adminMenu() });
  });

  bot.action('admin_pdf_reports', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await ctx.editMessageText('📄 *Отчёт в PDF*\n\nВыберите тип успешных операций:', {
      parse_mode: 'Markdown',
      ...pdfReportsKeyboard(),
    });
  });

  bot.action(/^admin_pdf_report:(topup|withdraw)$/, async (ctx) => {
    await ctx.answerCbQuery('Готовлю PDF…');
    if (!isAdmin(ctx.from.id)) return;
    const type = ctx.match[1];
    const rows = Transactions.getConfirmedForReport(type);
    const pdf = await createTransactionReport({ type, rows });
    const date = new Date().toISOString().slice(0, 10);
    const label = type === 'topup' ? 'popolneniya' : 'vyvody';
    await ctx.replyWithDocument({ source: pdf, filename: `gkassa-${label}-${date}.pdf` }, {
      caption: type === 'topup'
        ? `📥 Успешные пополнения: ${rows.length}`
        : `📤 Успешные выводы: ${rows.length}`,
    });
  });

  bot.action(/^spin_winner_bookmaker:(\d+):(1xbet|melbet|mostbet|1win)$/, async (ctx) => {
    const resultId = Number(ctx.match[1]);
    const bookmaker = ctx.match[2];
    const winner = getPrizeWinner(resultId);
    if (!winner || Number(winner.telegram_id) !== Number(ctx.from.id)) {
      await ctx.answerCbQuery('Этот выбор не относится к вашему выигрышу.', { show_alert: true });
      return;
    }
    if (winner.payout_status !== 'pending') {
      await ctx.answerCbQuery('Выигрыш уже обработан.', { show_alert: true });
      return;
    }
    if (!BotSettings.isEnabled(`site:${bookmaker}`)) {
      await ctx.answerCbQuery('Этот букмекер сейчас отключён. Выберите другого.', { show_alert: true });
      return;
    }
    const payout = getPrizePayout(resultId);
    if (payout && payout.status !== 'failed') {
      await ctx.answerCbQuery('Зачисление этого выигрыша уже началось.', { show_alert: true });
      return;
    }

    setUserState(ctx.from.id, { step: 'spin_winner_player_id', resultId, bookmaker });
    await ctx.answerCbQuery();
    const recentIds = PlayerIds.lastTwo(ctx.from.id, bookmaker);
    await ctx.telegram.sendMessage(
      ctx.from.id,
      `Выигрыш: ${winner.prize_amount} сом\nБукмекер: ${getSiteLabel(bookmaker)}\n\nВведите ваш ID букмекера. Для отмены отправьте /cancel.`,
      playerIdKeyboard(recentIds)
    );
  });

  bot.action(/^spin_winner_cancel:(\d+)$/, async (ctx) => {
    const resultId = Number(ctx.match[1]);
    const winner = getPrizeWinner(resultId);
    if (!winner || Number(winner.telegram_id) !== Number(ctx.from.id)) {
      await ctx.answerCbQuery('Этот выбор не относится к вашему выигрышу.', { show_alert: true });
      return;
    }
    const state = getUserState(ctx.from.id);
    if (state.resultId === resultId && String(state.step || '').startsWith('spin_winner_')) {
      clearUserState(ctx.from.id);
    }
    await ctx.answerCbQuery('Отменено');
    await ctx.telegram.sendMessage(ctx.from.id, 'Выбор букмекера отменён. Чтобы указать ID позже, нажмите кнопку букмекера в сообщении о выигрыше.');
  });

  bot.action(/^spin_prize_paid:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещён', { show_alert: true });
      return;
    }
    const winner = markPrizePaid(Number(ctx.match[1]), ctx.from.id);
    if (!winner) {
      await ctx.answerCbQuery('Выигрыш уже обработан или не найден', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery('✅ Отмечено как выплаченное');
    await ctx.editMessageReplyMarkup({ inline_keyboard: [[Markup.button.url('💬 Связаться с победителем', `tg://user?id=${winner.telegram_id}`)]] }).catch(() => {});
    await ctx.telegram.sendMessage(
      winner.telegram_id,
      `✅ Администратор отметил приз ${winner.prize_amount} сом как выплаченный.`
    ).catch(() => {});
  });

  bot.action(/^spin_prize_topup:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён', { show_alert: true });
    const resultId = Number(ctx.match[1]);
    const winner = getPrizeWinner(resultId);
    if (!winner || winner.prize_amount <= 0) return ctx.answerCbQuery('Выигрыш не найден', { show_alert: true });
    if (winner.payout_status !== 'pending') return ctx.answerCbQuery('Этот выигрыш уже обработан', { show_alert: true });
    const payout = getPrizePayout(resultId);
    if (payout && payout.status !== 'failed') {
      const notice = payout.status === 'sending' ? 'Пополнение уже выполняется' : 'Выигрыш уже пополнен';
      return ctx.answerCbQuery(notice, { show_alert: true });
    }
    if (winner.bookmaker && winner.player_id) {
      if (!isMobcashEnabledFor(winner.bookmaker)) {
        return ctx.answerCbQuery(
          `API пополнения для ${getSiteLabel(winner.bookmaker)} пока не настроен. Приз можно выдать вручную.`,
          { show_alert: true }
        );
      }
      await ctx.answerCbQuery('Запускаю пополнение…');
      await executeSpinPrizeTopup(ctx, {
        resultId,
        bookmaker: winner.bookmaker,
        playerId: winner.player_id,
        noticeChatId: ctx.callbackQuery.message.chat.id,
        noticeMessageId: ctx.callbackQuery.message.message_id,
      });
      return;
    }
    setUserState(ctx.from.id, {
      step: 'spin_prize_choose_bookmaker',
      resultId,
      noticeChatId: ctx.callbackQuery.message.chat.id,
      noticeMessageId: ctx.callbackQuery.message.message_id,
    });
    await ctx.answerCbQuery();
    const activeBookmakers = SITE_PROVIDERS.filter((site) => BotSettings.isEnabled(`site:${site}`));
    const bookmakerRows = [];
    for (let index = 0; index < activeBookmakers.length; index += 2) {
      bookmakerRows.push(activeBookmakers.slice(index, index + 2).map((site) =>
        Markup.button.callback(getSiteLabel(site), `spin_prize_bookmaker:${resultId}:${site}`)
      ));
    }
    bookmakerRows.push([Markup.button.callback('❌ Отмена', 'spin_prize_cancel')]);
    await ctx.telegram.sendMessage(ctx.from.id, `Выигрыш: ${winner.prize_amount} сом\nВыберите букмекера:`, Markup.inlineKeyboard([
      ...bookmakerRows,
    ]));
  });

  bot.action(/^spin_prize_bookmaker:(\d+):(1xbet|melbet|mostbet|1win)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён', { show_alert: true });
    const state = getUserState(ctx.from.id);
    const resultId = Number(ctx.match[1]);
    if (state.step !== 'spin_prize_choose_bookmaker' || state.resultId !== resultId) {
      return ctx.answerCbQuery('Начните пополнение приза заново.', { show_alert: true });
    }
    const winner = getPrizeWinner(resultId);
    if (!winner || winner.payout_status !== 'pending') return ctx.answerCbQuery('Выигрыш уже обработан', { show_alert: true });
    const bookmaker = ctx.match[2];
    if (!BotSettings.isEnabled(`site:${bookmaker}`)) {
      return ctx.answerCbQuery('Этот букмекер сейчас отключён.', { show_alert: true });
    }
    setUserState(ctx.from.id, { ...state, step: 'spin_prize_player_id', resultId, bookmaker });
    await ctx.answerCbQuery();
    await ctx.telegram.sendMessage(ctx.from.id, `Букмекер: ${getSiteLabel(bookmaker)}\nПриз: ${winner.prize_amount} сом\nВведите ID букмекера. Для отмены: /cancel`);
  });

  bot.action('spin_prize_cancel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Доступ запрещён', { show_alert: true });
    clearUserState(ctx.from.id);
    await ctx.answerCbQuery('Отменено');
    await ctx.telegram.sendMessage(ctx.from.id, 'Пополнение приза отменено.');
  });

  bot.action('admin_requisites', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    clearUserState(ctx.from.id);
    await renderRequisites(ctx, true);
  });

  bot.action('admin_req_add', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    clearUserState(ctx.from.id);
    await ctx.editMessageText('Что загружаем?', addRequisiteKindKeyboard());
  });

  bot.action('admin_sites', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    clearUserState(ctx.from.id);
    await renderSiteRequisites(ctx, true);
  });

  bot.action('admin_site_add', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    clearUserState(ctx.from.id);
    await ctx.editMessageText('Выберите сайт:', addSiteKeyboard());
  });

  bot.action(/^admin_site_req:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const siteId = ctx.match[1];
    setUserState(ctx.from.id, { step: 'admin_req_site_photo', kind: 'site', site: siteId });
    await ctx.replyWithHTML(
      `📤 Отправьте <b>фото (2:1)</b> для сайта <b>${getSiteLabel(siteId)}</b>.`,
      { ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_sites')]]) }
    );
  });

  bot.action(/^admin_site_setactive:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const requisite = Requisites.getById(ctx.match[1]);
    if (!requisite || !requisite.site) {
      await ctx.answerCbQuery('Не найден');
      return;
    }
    Requisites.activateForSite(requisite.id, requisite.site);
    await ctx.answerCbQuery('✅ Активировано');
    await renderSiteRequisites(ctx, true);
  });

  bot.action(/^admin_req_kind:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const kind = ctx.match[1];
    if (kind === 'bank_qr') {
      setUserState(ctx.from.id, {
        step: 'admin_req_photo',
        kind: 'bank_qr',
        provider: 'qr_bank',
      });
      await ctx.reply(
        'Отправьте *фото QR* для QR BANK.',
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_requisites')]]),
        }
      );
      return;
    }
    setUserState(ctx.from.id, { step: 'admin_req_choose_provider', kind });
    await ctx.editMessageText('Выберите сеть:', addRequisiteProviderKeyboard(kind));
  });

  bot.action(/^admin_req_prov:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const providerId = ctx.match[1];
    const provider = getProvider(providerId);
    if (!provider) return;
    setUserState(ctx.from.id, {
      step: 'admin_req_photo',
      kind: provider.kind,
      provider: providerId,
    });
    await ctx.reply(
      `Отправьте *фото QR* для ${provider.label}.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('❌ Отмена', 'admin_requisites')]]),
      }
    );
  });

  bot.action(/^admin_req_setactive:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const requisite = Requisites.getById(ctx.match[1]);
    if (!requisite || !requisite.provider) {
      await ctx.answerCbQuery('Не найден');
      return;
    }
    Requisites.activateForProvider(requisite.id, requisite.provider);
    await ctx.answerCbQuery('✅ Активировано');
    await renderRequisites(ctx, true);
  });

  bot.action(/^admin_req_delete:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const requisiteId = ctx.match[1];
    if (!Requisites.getById(requisiteId)) {
      await ctx.answerCbQuery('Реквизит уже удалён');
      await renderRequisites(ctx, true);
      return;
    }
    if (await waitForRequisiteCountdowns(ctx, requisiteId)) return;

    await ctx.answerCbQuery();
    await ctx.editMessageReplyMarkup(
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Да, удалить', `admin_req_delete_confirm:${requisiteId}`),
          Markup.button.callback('❌ Нет', 'admin_requisites'),
        ],
      ]).reply_markup
    );
  });

  bot.action(/^admin_req_delete_confirm:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const requisiteId = ctx.match[1];
    if (!Requisites.getById(requisiteId)) {
      await ctx.answerCbQuery('Реквизит уже удалён');
      await renderRequisites(ctx, true);
      return;
    }
    if (await waitForRequisiteCountdowns(ctx, requisiteId)) return;

    Requisites.delete(requisiteId);
    clearQrDeleteWaiters(requisiteId);
    await ctx.answerCbQuery('✅ Удалено');
    await renderRequisites(ctx, true);
  });

  bot.action('admin_skip_details', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await saveAdminRequisite(ctx, getUserState(ctx.from.id), null);
  });

  bot.action('admin_transactions', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const pendingTopups = Transactions.getByStatus('pending', 'topup', 10);
    const pendingWithdrawals = Transactions.getByStatus('pending', 'withdraw', 10);
    let text = '📋 Ожидающие транзакции:\n\n';
    if (pendingTopups.length === 0 && pendingWithdrawals.length === 0) {
      text += '✅ Нет ожидающих транзакций.';
    }
    pendingTopups.forEach((t) => {
      text += `💰 ${t.transaction_id} | ${Number(t.amount).toFixed(2)} сом | /t_${t.id}\n`;
    });
    pendingWithdrawals.forEach((t) => {
      text += `💸 ${t.transaction_id}${Number(t.amount) > 0 ? ` | ${Number(t.amount).toFixed(2)} сом` : ''} | /t_${t.id}\n`;
    });

    await ctx.editMessageText(text, Markup.inlineKeyboard([
        [
          Markup.button.callback('📥 Пополнения', 'admin_txn_topups'),
          Markup.button.callback('📤 Выводы', 'admin_txn_withdrawals'),
        ],
        [Markup.button.callback('🔙 Админ меню', 'admin_back')],
      ]));
  });

  bot.action('admin_txn_topups', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await renderTxnList(ctx, Transactions.getAll(20).filter((t) => t.type === 'topup'));
  });

  bot.action('admin_txn_withdrawals', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await renderTxnList(ctx, Transactions.getAll(20).filter((t) => t.type === 'withdraw'));
  });

  async function renderTxnList(ctx, txns) {
    if (txns.length === 0) {
      await ctx.editMessageText('📋 Нет транзакций.', { ...adminMenu() });
      return;
    }
    let text = '📋 Транзакции:\n\n';
    const emoji = { pending: '⏳', confirmed: '✅', rejected: '❌' };
    txns.forEach((t) => {
      text += `${t.type === 'topup' ? '💰' : '💸'} ${t.transaction_id}${Number(t.amount) > 0 ? ` | ${Number(t.amount).toFixed(2)}` : ''} | ${emoji[t.status] || '❔'} | /t\\_${t.id}\n`;
    });
    await ctx.editMessageText(text, Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад', 'admin_transactions')],
        [Markup.button.callback('🔙 Админ меню', 'admin_back')],
      ]));
  }

  bot.hears(/^\/t_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещен.');
      return;
    }
    const txn = Transactions.getById(ctx.match[1]);
    if (!txn) {
      await ctx.reply('⚠️ Транзакция не найдена.');
      return;
    }
    await sendTxnCard(ctx, txn);
  });

  bot.action(/^admin_txn_confirm:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const txn = Transactions.getById(ctx.match[1]);
    if (!txn || txn.status !== 'pending') {
      await ctx.answerCbQuery('⚠️ Уже обработана');
      return;
    }

    if (txn.type === 'topup') {
      await ctx.answerCbQuery();
      await ctx.editMessageReplyMarkup(
        Markup.inlineKeyboard([
          [Markup.button.callback('🔒 Вы уверены?', `admin_txn_final_confirm:${txn.id}`)],
          [Markup.button.callback('🔙 Назад', `admin_txn_view:${txn.id}`)],
        ]).reply_markup
      );
    } else {
      const ok = await applyWithdrawConfirm(ctx, txn.transaction_id);
      if (!ok) return;
      await ctx.answerCbQuery('✅');
      await ctx.reply('✅ Вывод подтверждён.', adminMenu());
    }
  });

  bot.action(/^admin_txn_final_confirm:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const txn = Transactions.getById(ctx.match[1]);
    if (!txn) {
      await ctx.answerCbQuery('Не найдена');
      return;
    }
    const ok = await applyTopupConfirm(ctx, txn.transaction_id);
    if (!ok) return;
    await ctx.answerCbQuery('✅ Подтверждено');
    await ctx.reply('✅ Пополнение подтверждено.', adminMenu());
  });

  bot.action(/^admin_txn_reject:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const txn = Transactions.getById(ctx.match[1]);
    if (!txn || txn.status !== 'pending') {
      await ctx.answerCbQuery('⚠️ Уже обработана');
      return;
    }
    const admin = getAdminRecord(ctx.from.id);
    Transactions.updateStatus(txn.id, 'rejected', admin?.id || null);
    const user = Users.getById(txn.user_id);
    if (user) {
      await ctx.telegram.sendMessage(
        user.telegram_id,
        `❌ Ваш ${txn.type === 'topup' ? 'пополнение' : 'вывод'} #${txn.transaction_id} отклонен.`
      ).catch(() => {});
    }
    await ctx.answerCbQuery('❌ Отклонено');
    await ctx.reply('❌ Отклонено.', adminMenu());
  });

  bot.action(/^admin_txn_view:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const txn = Transactions.getById(ctx.match[1]);
    if (!txn) {
      await ctx.editMessageText('⚠️ Транзакция не найдена.', adminMenu());
      return;
    }
    await sendTxnCard(ctx, txn);
  });

  async function sendTxnCard(ctx, txn) {
    const user = Users.getById(txn.user_id);
    let text = `📋 *Транзакция ${txn.transaction_id}*\n\n`;
    text += `Тип: ${txn.type === 'topup' ? '💰 Пополнение' : '💸 Вывод'}\n`;
    if (txn.provider) text += `Способ: ${providerLabel(txn.provider)}\n`;
    if (Number(txn.amount) > 0) text += `Сумма: *${Number(txn.amount).toFixed(2)}* сом\n`;
    text += `Статус: ${txn.status}\n`;
    if (txn.payment_id) text += `ID платежа: \`${txn.payment_id}\`\n`;
    if (txn.withdraw_details) text += `Реквизиты: \`${txn.withdraw_details}\`\n`;
    text += `Дата: ${new Date(txn.created_at).toLocaleString('ru-RU')}\n`;
    if (user) {
      text += `\n👤 ${user.first_name || user.username || '-'}\nTelegram: \`${user.telegram_id}\``;
    }

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback('✅ Подтвердить', `admin_txn_confirm:${txn.id}`),
        Markup.button.callback('❌ Отклонить', `admin_txn_reject:${txn.id}`),
      ],
      [Markup.button.callback('🔙 Транзакции', 'admin_transactions')],
    ]);

    if (txn.receipt_photo_id && txn.type === 'topup') {
      await ctx.replyWithPhoto(txn.receipt_photo_id, { caption: text, parse_mode: 'Markdown', ...kb });
    } else if (txn.receipt_file && txn.type === 'topup') {
      await ctx.replyWithDocument(txn.receipt_file, { caption: text, parse_mode: 'Markdown', ...kb });
    } else {
      await ctx.reply(text, { parse_mode: 'Markdown', ...kb });
    }
  }

  bot.action('admin_users', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const allUsers = Users.getAll();
    if (allUsers.length === 0) {
      await ctx.editMessageText('👥 Пользователи: 0\nНет пользователей.', adminMenu());
      return;
    }
    const userStats = Users.getStats();
    let text = `👥 *Пользователи: ${allUsers.length}*\n✅ Активных: ${userStats.active} | 🚫 Забанено: ${userStats.banned}\n\n`;
    allUsers.slice(0, 20).forEach((u) => {
      const mark = u.active === 0 ? '🚫 ' : '';
      const nick = u.username ? `@${u.username}` : '-';
      text += `${mark}\`${u.telegram_id}\` | ${u.first_name || nick} | ${nick} | /u\\_${u.id}\n`;
    });
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Админ меню', 'admin_back')]]),
    });
  });

  bot.hears(/^\/u_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещен.');
      return;
    }
    const user = Users.getById(ctx.match[1]);
    if (!user) return;
    const txns = Transactions.getByUserId(user.id, 10);
    let text =
      `👤 *Пользователь*\n\n` +
      `Имя: ${user.first_name || '-'}\n` +
      `Ник: ${user.username ? '@' + user.username : 'нет'}\n` +
      `Telegram ID: \`${user.telegram_id}\`\n` +
      `Статус: ${user.active === 0 ? '🚫 бан' : '✅ активен'}\n\n` +
      `📋 *Последние транзакции:*\n`;
    if (txns.length === 0) text += 'Нет транзакций.';
    else {
      txns.forEach((t) => {
        text += `${t.type === 'topup' ? '💰' : '💸'} ${t.transaction_id}${Number(t.amount) > 0 ? ` | ${Number(t.amount).toFixed(2)}` : ''} | ${t.status}\n`;
      });
    }
    await ctx.reply(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          user.active === 1
            ? Markup.button.callback('🚫 Бан', `admin_ban_by_id:${user.id}`)
            : Markup.button.callback('✅ Разбанить', `admin_unban_by_id:${user.id}`),
        ],
        [Markup.button.callback('🔙 Админ меню', 'admin_back')],
      ]),
    });
  });

  bot.action(/^admin_unban_by_id:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const user = Users.getById(ctx.match[1]);
    if (!user) {
      await ctx.answerCbQuery('Не найден');
      return;
    }
    Users.unbanByTelegramId(user.telegram_id);
    await ctx.answerCbQuery('✅ Разбанен');
    await renderUnbanSection(ctx, 0, true);
  });

  bot.action(/^admin_unban_page:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await renderUnbanSection(ctx, Number(ctx.match[1]), true);
  });

  bot.action(/^admin_ban_by_id:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔');
      return;
    }
    const user = Users.getById(ctx.match[1]);
    if (!user) {
      await ctx.answerCbQuery('Не найден');
      return;
    }
    if (isAdmin(user.telegram_id)) {
      await ctx.answerCbQuery('Нельзя банить админа', { show_alert: true });
      return;
    }
    Users.banByTelegramId(user.telegram_id, {
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
    });
    clearUserState(user.telegram_id);
    await notifyBanned(ctx, user.telegram_id);
    await ctx.answerCbQuery('🚫 Забанен');
    await ctx.editMessageText(
      `🚫 Пользователь забанен.\n\n${userLabel(user)}\n\nБан по Telegram ID, смена ника не поможет.`,
      { parse_mode: 'Markdown', ...adminMenu() }
    );
  });

  bot.action('admin_back', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await ctx.editMessageText('🔐 *Админ панель*\n\nВыберите действие:', {
      parse_mode: 'Markdown',
      ...adminMenu(),
    });
  });

  const renderBookmakers = async (ctx, edit = true) => {
    const rows = SITE_PROVIDERS.map((id) => [Markup.button.callback(
      `${BotSettings.isEnabled(`site:${id}`) ? '🟢' : '🔴'} ${getSiteLabel(id)} — ${BotSettings.isEnabled(`site:${id}`) ? 'работает' : 'отключён'}`,
      `admin_site_toggle:${id}`
    )]);
    rows.push([Markup.button.callback('🔙 Админ меню', 'admin_back')]);
    const extra = Markup.inlineKeyboard(rows);
    const text = '🎰 Управление букмекерами\nНажмите на сайт, чтобы изменить доступность для пользователей.';
    if (edit && ctx.callbackQuery?.message) await ctx.editMessageText(text, extra);
    else await ctx.reply(text, extra);
  };

  bot.action('admin_bookmakers', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await renderBookmakers(ctx);
  });

  bot.action(/^admin_site_toggle:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const siteId = ctx.match[1];
    if (!SITE_PROVIDERS.includes(siteId)) return;
    BotSettings.set(`site:${siteId}`, BotSettings.isEnabled(`site:${siteId}`) ? '0' : '1');
    await renderBookmakers(ctx);
  });

  bot.action('admin_toggle_pause', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    const paused = BotSettings.get('bot_paused', '0') !== '1';
    BotSettings.set('bot_paused', paused ? '1' : '0');
    const label = paused
      ? 'Бот на паузе <tg-emoji emoji-id="6269223265001017592">⛔</tg-emoji>'
      : '✅ Бот снова работает';
    await ctx.editMessageText(`${label}\n\n🔐 Админ панель\nВыберите действие:`, {
      parse_mode: 'HTML', ...adminMenu(),
    });
  });

  bot.action('admin_ban_user', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    setUserState(ctx.from.id, { step: 'admin_ban_user' });
    await ctx.reply(
      '🚫 *Бан пользователя*\n\nОтправьте *Telegram ID* или *@username*.\nБан ставится на ID — смена ника его не снимет.\n\nПримеры:\n`123456789`\n`@username`',
      { parse_mode: 'Markdown' }
    );
  });

  bot.action('admin_unban_user', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    await renderUnbanSection(ctx, 0, true);
  });

  bot.action('admin_broadcast', async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
    setUserState(ctx.from.id, { step: 'admin_broadcast_msg' });
    await ctx.editMessageText(
      '📢 *Рассылка всем пользователям*\n\nОтправьте текст, фото, документ или другое вложение для рассылки.',
      { parse_mode: 'Markdown', ...adminMenu() }
    );
  });

  bot.action(/^admin_broadcast_btn:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.answerCbQuery('⛔ Доступ запрещен');
      return;
    }
    if (broadcastInProgress) {
      await ctx.answerCbQuery('Рассылка уже идёт', { show_alert: true });
      return;
    }
    await ctx.answerCbQuery();
    const choice = ctx.match[1];
    const state = getUserState(ctx.from.id);
    const broadcast = state.broadcast;
    if (!broadcast) {
      await ctx.editMessageText('⚠️ Сообщение для рассылки не найдено. Начните заново.', adminMenu());
      clearUserState(ctx.from.id);
      return;
    }

    if (choice === 'none') {
      clearUserState(ctx.from.id);
      startBroadcast(ctx, broadcast, null);
      return;
    }

    if (choice === 'topup') {
      clearUserState(ctx.from.id);
      startBroadcast(ctx, broadcast, { type: 'topup' });
      return;
    }

    if (choice === 'invite') {
      clearUserState(ctx.from.id);
      startBroadcast(ctx, broadcast, { type: 'invite' });
      return;
    }

    if (choice === 'link') {
      setUserState(ctx.from.id, { step: 'admin_broadcast_link_url', broadcast });
      await ctx.editMessageText(
        '🔗 Отправьте ссылку на Telegram-канал (например, https://t.me/channel):',
        { parse_mode: 'Markdown', ...adminMenu() }
      );
      return;
    }
  });

  bot.command('ban', async (ctx) => {
    if (await handleBanReply(ctx)) return;

    if (!ctx.from || !isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещен.');
      return;
    }
    const arg = ctx.message.text.replace(/^\/ban(@\S+)?\s*/i, '').trim();
    if (!arg) {
      await ctx.reply(
        'Ответьте `/ban` на заявку в канале или укажите пользователя:\n`/ban 123456789`\n`/ban @username`',
        { parse_mode: 'Markdown' }
      );
      return;
    }
    const user = await resolveUserFromQuery(ctx, arg);
    if (!user) {
      await ctx.reply('⚠️ Пользователь не найден. Нужен числовой Telegram ID или публичный @username.');
      return;
    }
    await applyBan(ctx, user);
  });

  bot.command('unban', async (ctx) => {
    if (await handleUnbanReply(ctx)) return;
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещен.');
      return;
    }
    const arg = ctx.message.text.replace(/^\/unban(@\S+)?\s*/i, '').trim();
    if (!arg) {
      await ctx.reply('Укажите Telegram ID или @username:\n`/unban 123456789`', {
        parse_mode: 'Markdown',
      });
      return;
    }
    const user = await resolveUserFromQuery(ctx, arg);
    if (!user) {
      await ctx.reply('⚠️ Пользователь не найден.');
      return;
    }
    await applyUnban(ctx, user);
  });

  bot.hears(/^\/ban_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещен.');
      return;
    }
    const user = await resolveUserFromQuery(ctx, ctx.match[1]);
    if (!user) {
      await ctx.reply('⚠️ Пользователь не найден.');
      return;
    }
    await applyBan(ctx, user);
  });

  bot.hears(/^\/unban_(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
      await ctx.reply('⛔ Доступ запрещен.');
      return;
    }
    const user = await resolveUserFromQuery(ctx, ctx.match[1]);
    if (!user) {
      await ctx.reply('⚠️ Пользователь не найден.');
      return;
    }
    await applyUnban(ctx, user);
  });

  bot.on('photo', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (state.step !== 'admin_req_photo' && state.step !== 'admin_req_site_photo' || !isAdmin(ctx.from.id)) {
      return next();
    }
    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    let nextState = { ...state, qr_code_photo_id: fileId };

    if (state.kind === 'bank_qr') {
      try {
        const styledQr = await createStyledQrFromTelegramPhoto(ctx.telegram, fileId);
        const preview = await ctx.replyWithPhoto(
          { source: styledQr.image, filename: 'flash-kassa-qr.png' },
          { caption: '✅ QR распознан и оформлен. Проверьте, что он хорошо сканируется.' }
        );
        const previewPhoto = preview.photo?.[preview.photo.length - 1];
        if (!previewPhoto) throw new Error('QR_PREVIEW_FAILED');
        nextState = {
          ...nextState,
          qr_code_photo_id: previewPhoto.file_id,
          payment_link_fragment: styledQr.paymentLinkFragment,
        };
      } catch (error) {
        console.error('[Admin] Bank QR processing failed:', error?.message || 'unknown error');
        await ctx.reply(
          error?.message === 'QR_NOT_FOUND'
            ? '⚠️ Не удалось распознать QR. Пришлите чёткое фото кода целиком, без бликов и обрезанных краёв.'
            : error?.message === 'QR_LINK_FRAGMENT_NOT_FOUND'
              ? '⚠️ В QR не найдена ссылка с фрагментом после #. Пришлите QR банка, в котором зашифрована ссылка вида https://банк/.../#данные.'
              : '⚠️ Не удалось обработать QR. Попробуйте отправить исходное изображение ещё раз.'
        );
        return;
      }
    }

    if (state.step === 'admin_req_site_photo') {
      setUserState(ctx.from.id, { ...nextState, step: 'admin_req_details' });
      await ctx.reply(
        '🖊 Введите подпись для админки (например, имя или пометку к реквизиту). Пользователи её не увидят. Или пропустите.',
        Markup.inlineKeyboard([[Markup.button.callback('Пропустить', 'admin_skip_details')]])
      );
      return;
    }

    if (state.kind === 'crypto') {
      setUserState(ctx.from.id, { ...nextState, step: 'admin_req_address' });
      await ctx.reply('Отправьте *текстом адрес кошелька*.', { parse_mode: 'Markdown' });
      return;
    }

    setUserState(ctx.from.id, { ...nextState, step: 'admin_req_details' });
    await ctx.reply(
      '🖊 Введите подпись для админки (например, имя или пометку к реквизиту). Пользователи её не увидят. Или пропустите.',
      Markup.inlineKeyboard([[Markup.button.callback('Пропустить', 'admin_skip_details')]])
    );
  });

  bot.on(['photo','document','video','animation','audio','voice','sticker'], async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (state.step === 'admin_broadcast_msg' && isAdmin(ctx.from.id)) {
      const broadcast = extractBroadcastContent(ctx.message);
      broadcast.chat_id = ctx.chat.id;
      broadcast.message_id = ctx.message.message_id;
      setUserState(ctx.from.id, { step: 'admin_broadcast_button_choice', broadcast });
      await ctx.reply(
        '⌨️ Добавить кнопку к рассылке?',
        Markup.inlineKeyboard([
          [Markup.button.callback('❌ Без кнопки', 'admin_broadcast_btn:none')],
          [Markup.button.callback('💎 Кнопка «Пополнить»', 'admin_broadcast_btn:topup')],
          [Markup.button.callback('👥 Кнопка «Пригласить»', 'admin_broadcast_btn:invite')],
          [Markup.button.callback('🔗 Кнопка-ссылка', 'admin_broadcast_btn:link')],
          [Markup.button.callback('🔙 Отмена', 'admin_back')],
        ])
      );
      return;
    }
    return next();
  });

  bot.on('document', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (!isAdmin(ctx.from.id) || state.step !== 'admin_manual_topup_input') return next();
    const document = ctx.message.document;
    if (!/\.csv$/i.test(document.file_name || '') || Number(document.file_size) > 100_000) {
      await ctx.reply('Загрузите CSV до 100 КБ или отправьте строки обычным текстом.');
      return;
    }
    try {
      const url = await ctx.telegram.getFileLink(document.file_id);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Telegram file download failed (${response.status})`);
      const csv = await response.text();
      if (Buffer.byteLength(csv, 'utf8') > 100_000) throw new Error('CSV больше 100 КБ.');
      await sendManualTopupPreview(ctx, parseManualTopupRows(csv));
    } catch (error) {
      await ctx.reply(`⚠️ Не удалось прочитать CSV: ${error.message}`);
    }
  });

  bot.on('text', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (state.step !== 'spin_winner_player_id' && state.step !== 'spin_winner_checking_id') return next();

    const text = String(ctx.message.text || '').trim();
    if (text === '/cancel' || text === '🔙 Назад') {
      clearUserState(ctx.from.id);
      await ctx.reply('Ввод ID для выигрыша отменён.', Markup.removeKeyboard());
      return;
    }
    if (state.step === 'spin_winner_checking_id') {
      await ctx.reply('⏳ Проверяю ID через API. Подождите немного.');
      return;
    }

    const winner = getPrizeWinner(state.resultId);
    if (!winner || Number(winner.telegram_id) !== Number(ctx.from.id) || winner.payout_status !== 'pending') {
      clearUserState(ctx.from.id);
      await ctx.reply('Этот выигрыш уже обработан или не найден.', Markup.removeKeyboard());
      return;
    }
    if (!BotSettings.isEnabled(`site:${state.bookmaker}`)) {
      clearUserState(ctx.from.id);
      await ctx.reply('Этот букмекер отключён. Выберите актуального букмекера в сообщении о выигрыше.', Markup.removeKeyboard());
      return;
    }
    if (!text || text.length > 128) {
      await ctx.reply('Введите ID букмекера (до 128 символов). Для отмены отправьте /cancel.');
      return;
    }
    if (state.bookmaker !== '1xbet' && isMobcashEnabledFor(state.bookmaker) && !/^\d+$/.test(text)) {
      await ctx.reply('ID должен содержать только цифры. Введите его ещё раз или отправьте /cancel.');
      return;
    }

    if (state.bookmaker === '1xbet') {
      const checkToken = crypto.randomUUID();
      setUserState(ctx.from.id, { ...state, step: 'spin_winner_checking_id', checkToken });
      await ctx.reply('<tg-emoji emoji-id="5427181942934088912">💬</tg-emoji>', { parse_mode: 'HTML' });
      try {
        await verifyBookmakerAccount('1xbet', text, { payerId: text });
      } catch (error) {
        const latest = getUserState(ctx.from.id);
        if (latest.step !== 'spin_winner_checking_id' || latest.checkToken !== checkToken) return;
        setUserState(ctx.from.id, { ...state, step: 'spin_winner_player_id' });
        if (error instanceof BookmakerAccountCheckConfigError) {
          await ctx.reply('⚠️ Проверка ID 1xBet сейчас не настроена. Обратитесь к администратору.');
        } else if (isBookmakerAccountNotFound(error)) {
          await ctx.reply(
            '<tg-emoji emoji-id="6271786398404055377">⚠️</tg-emoji> Неправильный ID, перепроверьте пожалуйста и отправьте снова<tg-emoji emoji-id="5796168957064912286">⭐️</tg-emoji>',
            { parse_mode: 'HTML' }
          );
        } else {
          console.error('[FreeSpin] 1xBet winner ID check failed:', error.message);
          await ctx.reply('⚠️ Не удалось проверить ID 1xBet. Попробуйте ещё раз чуть позже.');
        }
        return;
      }
      const latest = getUserState(ctx.from.id);
      if (latest.step !== 'spin_winner_checking_id' || latest.checkToken !== checkToken) return;
    }

    const saved = setPrizeWinnerAccount({
      resultId: state.resultId,
      telegramId: ctx.from.id,
      bookmaker: state.bookmaker,
      playerId: text,
    });
    if (!saved) {
      clearUserState(ctx.from.id);
      await ctx.reply('Не удалось сохранить ID: выигрыш уже обрабатывается. Напишите администратору.', Markup.removeKeyboard());
      return;
    }

    PlayerIds.remember(ctx.from.id, text, state.bookmaker);
    clearUserState(ctx.from.id);
    await ctx.reply('✅ ID сохранён. Администратор сможет зачислить приз на выбранного букмекера.', Markup.removeKeyboard());

    const username = saved.username ? `@${escapeHtml(saved.username.replace(/^@/, ''))}` : 'не указан';
    const adminText =
      `🎰 <b>Победитель прислал ID для зачисления приза</b>\n` +
      `Пользователь: ${escapeHtml(saved.first_name || saved.telegram_id)}\n` +
      `Username: ${username}\n` +
      `Букмекер: <b>${getSiteLabel(state.bookmaker)}</b>\n` +
      `ID: <code>${escapeHtml(text)}</code>\n` +
      `Приз: <b>${saved.prize_amount} сом</b>`;
    const adminKeyboard = Markup.inlineKeyboard([
      [Markup.button.url('💬 Связаться с победителем', `tg://user?id=${saved.telegram_id}`)],
      [Markup.button.callback('Пополнить💎', `spin_prize_topup:${state.resultId}`)],
      [Markup.button.callback('✅ Отметить выплаченным вручную', `spin_prize_paid:${state.resultId}`)],
    ]);
    let notified = false;
    if (config.bot.channels.topup) {
      try {
        await ctx.telegram.sendMessage(config.bot.channels.topup, adminText, {
          parse_mode: 'HTML',
          ...adminKeyboard,
        });
        notified = true;
      } catch (error) {
        console.error('[FreeSpin] Failed to notify top-up channel about winner ID:', error.message);
      }
    }
    if (!notified) {
      for (const adminId of Spins.listActiveAdminTelegramIds(config.admin.telegramIds)) {
        await ctx.telegram.sendMessage(adminId, adminText, {
          parse_mode: 'HTML',
          ...adminKeyboard,
        }).catch((error) => console.error(`[FreeSpin] Failed to notify admin ${adminId}:`, error.message));
      }
    }
  });

  bot.on('text', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (!isAdmin(ctx.from.id)) return next();

    if (state.step === 'spin_prize_player_id') {
      const playerId = ctx.message.text.trim();
      if (playerId === '/cancel') {
        clearUserState(ctx.from.id);
        await ctx.reply('Пополнение приза отменено.');
        return;
      }
      if (!playerId || playerId.length > 128 || !/^[\w-]+$/.test(playerId)) {
        await ctx.reply('Введите корректный ID букмекера (до 128 символов). Для отмены: /cancel');
        return;
      }

      const { resultId, bookmaker } = state;
      await executeSpinPrizeTopup(ctx, {
        resultId,
        bookmaker,
        playerId,
        noticeChatId: state.noticeChatId,
        noticeMessageId: state.noticeMessageId,
      });
      return;
    }

    if (state.step === 'admin_manual_topup_input') {
      const raw = ctx.message.text.trim();
      if (raw === '/cancel') {
        clearUserState(ctx.from.id);
        await ctx.reply('Ручное пополнение отменено.', adminMenu());
        return;
      }
      try {
        await sendManualTopupPreview(ctx, parseManualTopupRows(raw));
      } catch (error) {
        await ctx.reply(`⚠️ ${error.message}`);
      }
      return;
    }

    if (state.step === 'admin_manual_topup_player_id') {
      const playerId = ctx.message.text.trim();
      if (playerId === '/cancel') {
        clearUserState(ctx.from.id);
        await ctx.reply('Ручное пополнение отменено.', adminMenu());
        return;
      }
      if (!playerId || playerId.length > 128 || !/^[\w-]+$/.test(playerId)) {
        await ctx.reply('Введите корректный ID игрока (до 128 символов). Для отмены: /cancel');
        return;
      }
      setUserState(ctx.from.id, { ...state, step: 'admin_manual_topup_choose_amount', playerId });
      await ctx.reply(`Игрок: ${playerId}\nВыберите сумму:`, Markup.inlineKeyboard([
        [Markup.button.callback('35 сом', 'admin_manual_amount:35'), Markup.button.callback('50 сом', 'admin_manual_amount:50'), Markup.button.callback('100 сом', 'admin_manual_amount:100')],
        [Markup.button.callback('✍️ Свободный ввод', 'admin_manual_amount_custom')],
        [Markup.button.callback('❌ Отмена', 'admin_manual_topup_cancel')],
      ]));
      return;
    }

    if (state.step === 'admin_manual_topup_custom_amount') {
      const raw = ctx.message.text.trim();
      if (raw === '/cancel') {
        clearUserState(ctx.from.id);
        await ctx.reply('Ручное пополнение отменено.', adminMoreMenu());
        return;
      }
      const amount = Number(raw);
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        await ctx.reply('Введите сумму целым числом больше 0. Для отмены: /cancel');
        return;
      }
      await executeAdminManualTopup(ctx, state, amount);
      return;
    }

    if (state.step === 'admin_operator_limit_per_operation' || state.step === 'admin_operator_limit_daily') {
      const actingAdmin = db.prepare('SELECT role FROM admins WHERE user_id = ? AND active = 1').get(ctx.from.id);
      if (!actingAdmin || !['admin', 'superadmin'].includes(String(actingAdmin.role).toLowerCase())) {
        clearUserState(ctx.from.id);
        await ctx.reply('Эта настройка доступна только superadmin.');
        return;
      }
      if (ctx.message.text.trim() === '/cancel') {
        clearUserState(ctx.from.id);
        await ctx.reply('Настройка отменена.', adminMenu());
        return;
      }
      const limit = Number(ctx.message.text.trim());
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000_000) {
        await ctx.reply('Введите целое число больше 0. Для отмены нажмите /cancel.');
        return;
      }
      if (state.step === 'admin_operator_limit_per_operation') {
        db.prepare('UPDATE admins SET manual_limit = ? WHERE id = ?').run(limit, state.targetAdminId);
        setUserState(ctx.from.id, { ...state, step: 'admin_operator_limit_daily' });
        await ctx.reply('Теперь введите дневной лимит оператора в сомах.');
        return;
      }
      db.prepare('UPDATE admins SET daily_limit = ? WHERE id = ?').run(limit, state.targetAdminId);
      const target = db.prepare('SELECT user_id, manual_limit, daily_limit FROM admins WHERE id = ?').get(state.targetAdminId);
      db.prepare(`INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
        VALUES (?, 'admin.limits_updated', 'admin', ?, ?)`)
        .run(ctx.from.id, String(state.targetAdminId), JSON.stringify({ manual_limit: target.manual_limit, daily_limit: target.daily_limit }));
      clearUserState(ctx.from.id);
      await ctx.reply(`✅ Лимиты ${target.user_id}: ${target.manual_limit} сом за операцию, ${target.daily_limit} сом за сутки.`, adminMenu());
      return;
    }

    if (state.step === 'admin_optima_edit') {
      const value = ctx.message.text.trim();
      if (value === '/cancel') {
        clearUserState(ctx.from.id);
        await ctx.reply('Редактирование отменено.', adminMenu());
        return;
      }
      if (!value || value.length > 512) {
        await ctx.reply('⚠️ Значение должно быть от 1 до 512 символов.');
        return;
      }
      if (state.field === 'package_name' && !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value)) {
        await ctx.reply('⚠️ Package name должен выглядеть как kz.example.app.');
        return;
      }
      if (state.field.startsWith('regex_')) {
        try { new RegExp(value); } catch (_) {
          await ctx.reply('⚠️ Некорректный регулярный шаблон. Проверьте скобки и экранирование.');
          return;
        }
      }

      const bank = db.prepare("SELECT * FROM banks WHERE bank_code = 'optima'").get();
      const template = bank && db.prepare('SELECT * FROM bank_templates WHERE bank_id = ? ORDER BY id DESC LIMIT 1').get(bank.id);
      if (!bank || (state.field.startsWith('regex_') && !template)) {
        clearUserState(ctx.from.id);
        await ctx.reply('⚠️ Шаблон Optima не найден. Перезапустите настройку после добавления шаблона.', adminMenu());
        return;
      }
      if (state.field === 'package_name') {
        db.prepare("UPDATE banks SET package_name = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(value, bank.id);
        db.prepare('UPDATE bank_templates SET package_name = ?, updated_at = CURRENT_TIMESTAMP WHERE bank_id = ?').run(value, bank.id);
      } else {
        db.prepare(`UPDATE bank_templates SET ${state.field} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(value, template.id);
      }
      db.prepare(`
        INSERT INTO audit_log (actor_telegram_id, action, entity_type, entity_id, details_json)
        VALUES (?, 'bank.optima_template_updated', 'bank', ?, ?)
      `).run(ctx.from.id, String(bank.id), JSON.stringify({ field: state.field }));
      clearUserState(ctx.from.id);
      await ctx.reply('✅ Настройка Optima обновлена. Изменение применяется сразу, перезапуск APK не нужен.', adminMenu());
      return;
    }

    if (state.step === 'admin_ban_user') {
      const query = ctx.message.text.trim();
      clearUserState(ctx.from.id);
      const user = await resolveUserFromQuery(ctx, query);
      if (!user) {
        await ctx.reply('⚠️ Пользователь не найден. Нужен числовой Telegram ID или публичный @username.');
        return;
      }
      await applyBan(ctx, user);
      return;
    }

    if (state.step === 'admin_unban_user') {
      const query = ctx.message.text.trim();
      clearUserState(ctx.from.id);
      const user = await resolveUserFromQuery(ctx, query);
      if (!user) {
        await ctx.reply('⚠️ Пользователь не найден.');
        return;
      }
      await applyUnban(ctx, user);
      return;
    }

    if (state.step === 'admin_broadcast_msg') {
      const broadcast = extractBroadcastContent(ctx.message);
      broadcast.chat_id = ctx.chat.id;
      broadcast.message_id = ctx.message.message_id;
      setUserState(ctx.from.id, { step: 'admin_broadcast_button_choice', broadcast });
      await ctx.reply(
        '⌨️ Добавить кнопку к рассылке?',
        Markup.inlineKeyboard([
          [Markup.button.callback('❌ Без кнопки', 'admin_broadcast_btn:none')],
          [Markup.button.callback('💎 Кнопка «Пополнить»', 'admin_broadcast_btn:topup')],
          [Markup.button.callback('👥 Кнопка «Пригласить»', 'admin_broadcast_btn:invite')],
          [Markup.button.callback('🔗 Кнопка-ссылка', 'admin_broadcast_btn:link')],
          [Markup.button.callback('🔙 Отмена', 'admin_back')],
        ])
      );
      return;
    }

    if (state.step === 'admin_broadcast_link_url') {
      const url = ctx.message.text.trim();
      if (!/^https?:\/\/.+/.test(url)) {
        await ctx.reply('⚠️ Введите корректную ссылку (http:// или https://).');
        return;
      }
      setUserState(ctx.from.id, { step: 'admin_broadcast_link_text', broadcast: { ...state.broadcast, linkUrl: url } });
      await ctx.reply('📝 Введите текст кнопки:');
      return;
    }

    if (state.step === 'admin_broadcast_link_text') {
      const buttonText = ctx.message.text.trim();
      const broadcast = { ...state.broadcast, linkButtonText: buttonText };
      clearUserState(ctx.from.id);
      if (broadcastInProgress) {
        await ctx.reply('Рассылка уже идёт.');
        return;
      }
      startBroadcast(ctx, broadcast, { type: 'url', url: broadcast.linkUrl, text: buttonText });
      return;
    }

    if (state.step === 'admin_req_address') {
      const address = ctx.message.text.trim();
      setUserState(ctx.from.id, { ...state, wallet_address: address, step: 'admin_req_details' });
      await ctx.reply(
        '🖊 Введите подпись для админки (например, имя или пометку к реквизиту). Пользователи её не увидят. Или пропустите.',
        Markup.inlineKeyboard([[Markup.button.callback('Пропустить', 'admin_skip_details')]])
      );
      return;
    }

    if (state.step === 'admin_req_details') {
      await saveAdminRequisite(ctx, state, ctx.message.text.trim());
      return;
    }

    await next();
  });
}

async function saveAdminRequisite(ctx, state, details) {
  if ((!state.provider && !state.site) || !state.qr_code_photo_id) {
    await ctx.reply('⚠️ Не хватает данных. Начните загрузку заново.', adminMenu());
    clearUserState(ctx.from.id);
    return;
  }

  const admin = getAdminRecord(ctx.from.id);
  const info = Requisites.create({
    kind: state.kind,
    provider: state.provider || null,
    qr_code_photo_id: state.qr_code_photo_id,
    payment_link_fragment: state.payment_link_fragment || null,
    wallet_address: state.wallet_address || null,
    details,
    site: state.site || null,
    created_by: admin?.id || null,
  });

  if (state.site) {
    Requisites.activateForSite(info.lastInsertRowid, state.site);
    clearUserState(ctx.from.id);
    await ctx.reply(
      `✅ Реквизит для ${getSiteLabel(state.site)} сохранён и активирован.`,
      adminMenu()
    );
  } else {
    Requisites.activateForProvider(info.lastInsertRowid, state.provider);
    clearUserState(ctx.from.id);
    await ctx.reply(
      `✅ Реквизит ${providerLabel(state.provider)} сохранён и активирован.`,
      adminMenu()
    );
  }
}

function extractBroadcastContent(msg) {
  if (msg.text) return { type: 'text', text: msg.text, entities: msg.entities || [] };
  if (msg.photo) return { type: 'photo', file_id: msg.photo[msg.photo.length - 1].file_id, caption: msg.caption || undefined, caption_entities: msg.caption_entities || [] };
  if (msg.document) return { type: 'document', file_id: msg.document.file_id, caption: msg.caption || undefined, caption_entities: msg.caption_entities || [] };
  if (msg.video) return { type: 'video', file_id: msg.video.file_id, caption: msg.caption || undefined, caption_entities: msg.caption_entities || [] };
  if (msg.animation) return { type: 'animation', file_id: msg.animation.file_id, caption: msg.caption || undefined, caption_entities: msg.caption_entities || [] };
  if (msg.audio) return { type: 'audio', file_id: msg.audio.file_id, caption: msg.caption || undefined, caption_entities: msg.caption_entities || [] };
  if (msg.voice) return { type: 'voice', file_id: msg.voice.file_id };
  if (msg.sticker) return { type: 'sticker', file_id: msg.sticker.file_id };
  return { type: 'text', text: '' };
}

function replyMarkupForButton(buttonConfig, recipientTelegramId) {
  if (!buttonConfig) return undefined;
  if (buttonConfig.type === 'topup') {
    return Markup.inlineKeyboard([
      [Markup.button.callback('💎 Пополнить', 'btn_topup')],
    ]);
  }
  if (buttonConfig.type === 'url') {
    return Markup.inlineKeyboard([[Markup.button.url(buttonConfig.text, buttonConfig.url)]]);
  }
  if (buttonConfig.type === 'invite') {
    const referralLink = `https://t.me/${buttonConfig.botUsername}?start=ref_${recipientTelegramId}`;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralLink)}&text=${encodeURIComponent('Присоединяйся к FLASH!')}`;
    return Markup.inlineKeyboard([[Markup.button.url('Пригласить', shareUrl)]]);
  }
  return undefined;
}

function waitForBroadcast(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function telegramErrorCode(error) {
  return Number(error?.response?.error_code || error?.response?.body?.error_code || error?.code || 0);
}

function telegramRetryAfter(error) {
  return Number(error?.response?.parameters?.retry_after || error?.response?.body?.parameters?.retry_after || 0);
}

async function sendBroadcastOnce(telegram, chatId, broadcast, markupOptions) {
  const entities = broadcast.entities?.length ? { entities: broadcast.entities } : {};
  const captionEntities = broadcast.caption_entities?.length ? { caption_entities: broadcast.caption_entities } : {};
  if (broadcast.type === 'text') {
    await telegram.sendMessage(chatId, broadcast.text, { ...entities, ...markupOptions });
  } else if (broadcast.type === 'photo') {
    await telegram.sendPhoto(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
  } else if (broadcast.type === 'document') {
    await telegram.sendDocument(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
  } else if (broadcast.type === 'video') {
    await telegram.sendVideo(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
  } else if (broadcast.type === 'animation') {
    await telegram.sendAnimation(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
  } else if (broadcast.type === 'audio') {
    await telegram.sendAudio(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
  } else if (broadcast.type === 'voice') {
    await telegram.sendVoice(chatId, broadcast.file_id, markupOptions);
  } else if (broadcast.type === 'sticker') {
    await telegram.sendSticker(chatId, broadcast.file_id, markupOptions);
  }
}

function classifyBroadcastError(error) {
  const code = telegramErrorCode(error);
  if (code === 403) return 'blocked';
  return 'error';
}

async function sendBroadcastMessage(telegram, chatId, broadcast, buttonConfig) {
  const replyMarkup = replyMarkupForButton(buttonConfig, chatId);
  const markupOptions = replyMarkup || {};
  try {
    await sendBroadcastOnce(telegram, chatId, broadcast, markupOptions);
    return true;
  } catch (error) {
    if (telegramErrorCode(error) === 429) {
      const retryAfter = telegramRetryAfter(error);
      if (retryAfter > 0) {
        await waitForBroadcast(retryAfter * 1000);
        try {
          await sendBroadcastOnce(telegram, chatId, broadcast, markupOptions);
          return true;
        } catch (retryError) {
          const status = classifyBroadcastError(retryError);
          if (status === 'error') console.error('[Broadcast] Retry failed:', retryError.message);
          return status;
        }
      }
    }
    const status = classifyBroadcastError(error);
    if (status === 'error') console.error('[Broadcast] Send failed:', error.message);
    return status;
  }
}

async function doBroadcast(telegram, adminChatId, broadcast, buttonConfig) {
  if (buttonConfig?.type === 'invite') {
    let botUsername = BotSettings.get('bot_username', '');
    if (!botUsername) {
      try {
        botUsername = (await telegram.getMe()).username || '';
        if (botUsername) BotSettings.set('bot_username', botUsername);
      } catch (error) {
        console.error('[Broadcast] Could not get bot username for personal invite links:', error.message);
      }
    }
    if (!botUsername) {
      await telegram.sendMessage(adminChatId, '⚠️ Не удалось получить username бота. Рассылка не отправлена.');
      return;
    }
    buttonConfig = { ...buttonConfig, botUsername };
  }

  const users = Users.getActiveForBroadcast();
  let success = 0;
  let failed = 0;
  let blocked = 0;
  for (const u of users) {
    const result = await sendBroadcastMessage(telegram, u.telegram_id, broadcast, buttonConfig);
    if (result === true) success++;
    else if (result === 'blocked') {
      blocked++;
      Users.banByTelegramId(u.telegram_id);
    } else failed++;
    await waitForBroadcast(40);
  }
  const btnLabel = buttonConfig
    ? buttonConfig.type === 'topup' ? '«Пополнить»'
      : buttonConfig.type === 'invite' ? '«Пригласить»'
        : `ссылка "${buttonConfig.text}"`
    : 'без кнопки';
  await telegram.sendMessage(
    adminChatId,
    `📢 *Рассылка завершена*\n\nКнопка: *${btnLabel}*\nДоставлено: *${success}*\nЗаблокировали бота: *${blocked}*\nНе доставлено: *${failed}*\nВсего пользователей: *${users.length}*`,
    { parse_mode: 'Markdown', ...adminMenu() }
  );
}

function startBroadcast(ctx, broadcast, buttonConfig) {
  if (broadcastInProgress) return false;
  broadcastInProgress = true;
  const telegram = ctx.telegram;
  const adminChatId = ctx.chat.id;
  void doBroadcast(telegram, adminChatId, broadcast, buttonConfig)
    .catch((error) => {
      console.error('[Broadcast] Background job failed:', error.message);
      return telegram.sendMessage(adminChatId, '⚠️ Рассылка завершилась с ошибкой. Проверьте логи.').catch(() => {});
    })
    .finally(() => { broadcastInProgress = false; });
  return true;
}

module.exports = { setupAdminBotHandlers, isAdmin, adminMenu };

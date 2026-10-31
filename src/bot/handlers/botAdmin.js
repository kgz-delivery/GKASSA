const { Markup } = require('telegraf');
const { Requisites, Transactions, Users, BotSettings } = require('../../models');
const { isAdmin, getAdminRecord } = require('../adminAuth');
const { setUserState, getUserState, clearUserState } = require('../state');
const { applyTopupConfirm, applyWithdrawConfirm } = require('./adminCallbacks');
const { adminMenu, pdfReportsKeyboard } = require('../keyboards/adminKeyboard');
const { createTransactionReport } = require('../reports/pdfReport');
const { markPrizePaid } = require('../../spins');
const { createStyledQrFromTelegramPhoto } = require('../qrRequisites');
const { waitForQrCountdownsToFinish, clearQrDeleteWaiters } = require('../qrTimer');
const config = require('../../config');
const { CRYPTO_PROVIDERS, SITE_PROVIDERS, getProvider, providerLabel, getSiteLabel } = require('../../providers');

function escapeMarkdown(value) {
  return String(value || '').replace(/[\\_*`\[\]]/g, '\\$&');
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

function setupAdminBotHandlers(bot) {
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

    let text =
      '📊 *Статистика*\n\n' +
      `💰 Пополнений: *${stats.topups.count}* на *${Number(stats.topups.sum || 0).toFixed(2)}* сом\n` +
      `💸 Выводов: *${stats.withdrawals.count}* на *${Number(stats.withdrawals.sum || 0).toFixed(2)}* сом\n` +
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
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.telegram.sendMessage(
      winner.telegram_id,
      `✅ Администратор отметил приз ${winner.prize_amount} сом как выплаченный.`
    ).catch(() => {});
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
    let text = '📋 *Ожидающие транзакции:*\n\n';
    if (pendingTopups.length === 0 && pendingWithdrawals.length === 0) {
      text += '✅ Нет ожидающих транзакций.';
    }
    pendingTopups.forEach((t) => {
      text += `💰 ${t.transaction_id} | ${Number(t.amount).toFixed(2)} сом | /t_${t.id}\n`;
    });
    pendingWithdrawals.forEach((t) => {
      text += `💸 ${t.transaction_id}${Number(t.amount) > 0 ? ` | ${Number(t.amount).toFixed(2)} сом` : ''} | /t_${t.id}\n`;
    });

    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('📥 Пополнения', 'admin_txn_topups'),
          Markup.button.callback('📤 Выводы', 'admin_txn_withdrawals'),
        ],
        [Markup.button.callback('🔙 Админ меню', 'admin_back')],
      ]),
    });
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
    let text = '📋 *Транзакции:*\n\n';
    const emoji = { pending: '⏳', confirmed: '✅', rejected: '❌' };
    txns.forEach((t) => {
      text += `${t.type === 'topup' ? '💰' : '💸'} ${t.transaction_id}${Number(t.amount) > 0 ? ` | ${Number(t.amount).toFixed(2)}` : ''} | ${emoji[t.status] || '❔'} | /t\\_${t.id}\n`;
    });
    await ctx.editMessageText(text, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔙 Назад', 'admin_transactions')],
        [Markup.button.callback('🔙 Админ меню', 'admin_back')],
      ]),
    });
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
    await ctx.answerCbQuery();
    if (!isAdmin(ctx.from.id)) return;
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
      await doBroadcast(ctx, broadcast, null);
      return;
    }

    if (choice === 'topup') {
      clearUserState(ctx.from.id);
      await doBroadcast(ctx, broadcast, { type: 'topup' });
      return;
    }

    if (choice === 'invite') {
      clearUserState(ctx.from.id);
      await doBroadcast(ctx, broadcast, { type: 'invite' });
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

  bot.on('text', async (ctx, next) => {
    const state = getUserState(ctx.from.id);
    if (!isAdmin(ctx.from.id)) return next();

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
      await doBroadcast(ctx, broadcast, { type: 'url', url: broadcast.linkUrl, text: buttonText });
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

async function sendBroadcastMessage(ctx, chatId, broadcast, buttonConfig) {
  const replyMarkup = replyMarkupForButton(buttonConfig, chatId);
  const markupOptions = replyMarkup || {};
  const entities = broadcast.entities?.length ? { entities: broadcast.entities } : {};
  const captionEntities = broadcast.caption_entities?.length ? { caption_entities: broadcast.caption_entities } : {};
  try {
    if (broadcast.type === 'text') {
      await ctx.telegram.sendMessage(chatId, broadcast.text, { ...entities, ...markupOptions });
    } else if (broadcast.type === 'photo') {
      await ctx.telegram.sendPhoto(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
    } else if (broadcast.type === 'document') {
      await ctx.telegram.sendDocument(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
    } else if (broadcast.type === 'video') {
      await ctx.telegram.sendVideo(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
    } else if (broadcast.type === 'animation') {
      await ctx.telegram.sendAnimation(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
    } else if (broadcast.type === 'audio') {
      await ctx.telegram.sendAudio(chatId, broadcast.file_id, { caption: broadcast.caption, ...captionEntities, ...markupOptions });
    } else if (broadcast.type === 'voice') {
      await ctx.telegram.sendVoice(chatId, broadcast.file_id, markupOptions);
    } else if (broadcast.type === 'sticker') {
      await ctx.telegram.sendSticker(chatId, broadcast.file_id, markupOptions);
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function doBroadcast(ctx, broadcast, buttonConfig) {
  if (buttonConfig?.type === 'invite') {
    let botUsername = BotSettings.get('bot_username', '');
    if (!botUsername) {
      try {
        botUsername = (await ctx.telegram.getMe()).username || '';
        if (botUsername) BotSettings.set('bot_username', botUsername);
      } catch (error) {
        console.error('[Broadcast] Could not get bot username for personal invite links:', error.message);
      }
    }
    if (!botUsername) {
      await ctx.reply('⚠️ Не удалось получить username бота. Рассылка не отправлена.');
      return;
    }
    buttonConfig = { ...buttonConfig, botUsername };
  }

  const users = Users.getAll();
  let success = 0;
  let failed = 0;
  for (const u of users) {
    const ok = await sendBroadcastMessage(ctx, u.telegram_id, broadcast, buttonConfig);
    if (ok) success++; else failed++;
  }
  const btnLabel = buttonConfig
    ? buttonConfig.type === 'topup' ? '«Пополнить»'
      : buttonConfig.type === 'invite' ? '«Пригласить»'
        : `ссылка "${buttonConfig.text}"`
    : 'без кнопки';
  await ctx.reply(
    `📢 *Рассылка завершена*\n\nКнопка: *${btnLabel}*\nДоставлено: *${success}*\nНе доставлено: *${failed}*\nВсего пользователей: *${users.length}*`,
    { parse_mode: 'Markdown', ...adminMenu() }
  );
}

module.exports = { setupAdminBotHandlers, isAdmin, adminMenu };

const { Markup } = require('telegraf');
const config = require('../config');

const CHECK_CACHE_MS = 10_000;
const membershipCache = new Map();
const pendingStartPayloads = new Map();

function isSubscriptionConfigured() {
  return config.bot.requiredSubscriptions.every((chat) => Boolean(chat.id));
}

async function isUserSubscribed(ctx, { force = false } = {}) {
  if (!isSubscriptionConfigured()) return true;

  const userId = Number(ctx.from?.id);
  if (!userId) return false;
  const cached = membershipCache.get(userId);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.subscribed;

  const checks = await Promise.all(config.bot.requiredSubscriptions.map(async (chat) => {
    try {
      const member = await ctx.telegram.getChatMember(chat.id, userId);
      return member.status === 'creator' || member.status === 'administrator' || member.status === 'member' ||
        (member.status === 'restricted' && member.is_member === true);
    } catch (error) {
      console.error(`[Subscription] Could not check membership in ${chat.title}:`, error.message);
      return false;
    }
  }));

  const subscribed = checks.every(Boolean);
  membershipCache.set(userId, { subscribed, expiresAt: Date.now() + CHECK_CACHE_MS });
  return subscribed;
}

function subscriptionKeyboard() {
  const rows = config.bot.requiredSubscriptions.map((chat) => [Markup.button.url(`➕ ${chat.title}`, chat.url)]);
  rows.push([Markup.button.callback('✅ Проверить подписку', 'subscription_check')]);
  return Markup.inlineKeyboard(rows);
}

async function sendSubscriptionPrompt(ctx, retry = false) {
  const message = retry
    ? 'Подписка пока не найдена. Подпишитесь на оба чата и нажмите «Проверить подписку».'
    : 'Чтобы начать пользоваться ботом, подпишитесь на канал и группу, затем нажмите «Проверить подписку».';
  await ctx.reply(message, subscriptionKeyboard());
}

function rememberStartPayload(userId, payload) {
  if (payload) pendingStartPayloads.set(Number(userId), String(payload));
}

function takeStartPayload(userId) {
  const id = Number(userId);
  const payload = pendingStartPayloads.get(id) || '';
  pendingStartPayloads.delete(id);
  return payload;
}

function invalidateMembership(userId) {
  membershipCache.delete(Number(userId));
}

module.exports = {
  isSubscriptionConfigured,
  isUserSubscribed,
  sendSubscriptionPrompt,
  rememberStartPayload,
  takeStartPayload,
  invalidateMembership,
};

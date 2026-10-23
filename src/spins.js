const crypto = require('crypto');
const { db } = require('./database');
const { BotSettings, Users } = require('./models');

const FIRST_SPINS_WITHOUT_PRIZE = 5;
const SPIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRIZE_BUCKETS = [
  { key: '35', amount: 35, weight: 100000 },
  { key: '50', amount: 50, weight: 30000 },
  { key: '65', amount: 65, weight: 1000 },
  { key: '80', amount: 80, weight: 100 },
  { key: 'no_win', amount: 0, weight: 868900 },
];
const WEIGHT_TOTAL = PRIZE_BUCKETS.reduce((sum, prize) => sum + prize.weight, 0);

function drawPrize() {
  let value = crypto.randomInt(WEIGHT_TOTAL);
  for (const prize of PRIZE_BUCKETS) {
    if (value < prize.weight) return prize;
    value -= prize.weight;
  }
  return PRIZE_BUCKETS[PRIZE_BUCKETS.length - 1];
}

function creditReferralSpin(referrerId, referredUserId, rewardType = 'topup') {
  const result = db.prepare(`
    INSERT OR IGNORE INTO spin_credits (user_id, source, source_key)
    VALUES (?, 'referral', ?)
  `).run(referrerId, `referral_${rewardType}:${referredUserId}`);
  return result.changes === 1;
}

const attributeReferralAndGrantSpin = db.transaction((invitedTelegramId, referrerTelegramId) => {
  if (!invitedTelegramId || !referrerTelegramId || Number(invitedTelegramId) === Number(referrerTelegramId)) {
    return { referralGranted: false, referrerTelegramId: null };
  }
  const invited = db.prepare('SELECT id FROM users WHERE telegram_id = ?').get(Number(invitedTelegramId));
  const referrer = db.prepare('SELECT id, telegram_id FROM users WHERE telegram_id = ? AND active = 1')
    .get(Number(referrerTelegramId));
  if (!invited || !referrer) return { referralGranted: false, referrerTelegramId: null };

  const attributed = db.prepare(`
    UPDATE users SET referrer_user_id = ?
    WHERE id = ? AND referrer_user_id IS NULL
  `).run(referrer.id, invited.id).changes;
  if (!attributed) return { referralGranted: false, referrerTelegramId: null };

  const referralGranted = creditReferralSpin(referrer.id, invited.id, 'signup');
  return { referralGranted, referrerTelegramId: referrer.telegram_id };
});

const confirmTopupAndGrantSpins = db.transaction((transactionId, adminId) => {
  const changed = db.prepare(`
    UPDATE transactions
    SET status = 'confirmed', confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE transaction_id = ? AND type = 'topup' AND status = 'pending'
  `).run(adminId || null, transactionId).changes;
  if (!changed) return { confirmed: false, spinsGranted: 0, referralGranted: false };

  const transaction = db.prepare('SELECT id, user_id, amount FROM transactions WHERE transaction_id = ?').get(transactionId);
  const campaignStart = BotSettings.get('freespin_started_at', '1970-01-01 00:00:00');
  const confirmedTotal = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS amount
    FROM transactions
    WHERE user_id = ? AND type = 'topup' AND status = 'confirmed' AND confirmed_at >= ?
  `).get(transaction.user_id, campaignStart).amount;
  const earnedTotal = Math.floor(Number(confirmedTotal) / 100);
  const alreadyGranted = db.prepare(`
    SELECT COUNT(*) AS count FROM spin_credits WHERE user_id = ? AND source = 'topup'
  `).get(transaction.user_id).count;
  const spinsGranted = Math.max(0, earnedTotal - alreadyGranted);
  const insertCredit = db.prepare(`
    INSERT OR IGNORE INTO spin_credits (user_id, source, source_key)
    VALUES (?, 'topup', ?)
  `);
  for (let i = 0; i < spinsGranted; i += 1) {
    insertCredit.run(transaction.user_id, `topup:${transaction.id}:${i + 1}`);
  }

  let referralGranted = false;
  const user = db.prepare('SELECT referrer_user_id, referral_rewarded_at FROM users WHERE id = ?').get(transaction.user_id);
  if (user?.referrer_user_id && !user.referral_rewarded_at && Number(confirmedTotal) >= 100) {
    referralGranted = creditReferralSpin(user.referrer_user_id, transaction.user_id);
    if (referralGranted) {
      db.prepare('UPDATE users SET referral_rewarded_at = CURRENT_TIMESTAMP WHERE id = ?').run(transaction.user_id);
    }
  }

  return { confirmed: true, spinsGranted, referralGranted, userId: transaction.user_id, referrerId: user?.referrer_user_id || null };
});

function getSpinStatus(telegramId, botUsername = '') {
  const user = Users.getByTelegramId(telegramId);
  if (!user) return null;
  const credits = db.prepare(`
    SELECT source, COUNT(*) AS count FROM spin_credits WHERE user_id = ? AND used_at IS NULL GROUP BY source
  `).all(user.id);
  const availableTopup = credits.find((row) => row.source === 'topup')?.count || 0;
  const availableReferral = credits.find((row) => row.source === 'referral')?.count || 0;
  const lastDaily = db.prepare(`
    SELECT created_at FROM spin_results WHERE user_id = ? AND source = 'daily'
    ORDER BY id DESC LIMIT 1
  `).get(user.id)?.created_at || null;
  const usedSpins = db.prepare('SELECT COUNT(*) AS count FROM spin_results WHERE user_id = ?').get(user.id).count;
  const campaignStart = BotSettings.get('freespin_started_at', '1970-01-01 00:00:00');
  const isNewUser = user.created_at >= campaignStart;
  const dailyAt = lastDaily ? Date.parse(`${lastDaily.replace(' ', 'T')}Z`) : 0;
  const nextDailyAt = dailyAt ? dailyAt + SPIN_INTERVAL_MS : 0;
  const referralLink = botUsername
    ? `https://t.me/${botUsername}?start=ref_${user.telegram_id}`
    : null;
  return {
    availableTopup,
    availableReferral,
    dailyReady: !lastDaily || nextDailyAt <= Date.now(),
    nextDailyAt: nextDailyAt || null,
    firstLosingSpinsLeft: isNewUser ? Math.max(0, FIRST_SPINS_WITHOUT_PRIZE - usedSpins) : 0,
    usedSpins,
    referralLink,
  };
}

const createSpin = db.transaction((userId) => {
  const credit = db.prepare(`
    SELECT id, source FROM spin_credits
    WHERE user_id = ? AND used_at IS NULL ORDER BY id LIMIT 1
  `).get(userId);
  let source;
  if (credit) {
    db.prepare('UPDATE spin_credits SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL').run(credit.id);
    source = credit.source;
  } else {
    const lastDaily = db.prepare(`
      SELECT created_at FROM spin_results WHERE user_id = ? AND source = 'daily'
      ORDER BY id DESC LIMIT 1
    `).get(userId)?.created_at;
    if (lastDaily) {
      const lastAt = Date.parse(`${lastDaily.replace(' ', 'T')}Z`);
      if (Number.isFinite(lastAt) && Date.now() - lastAt < SPIN_INTERVAL_MS) {
        const error = new Error('DAILY_COOLDOWN');
        error.nextDailyAt = lastAt + SPIN_INTERVAL_MS;
        throw error;
      }
    }
    source = 'daily';
  }

  const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
  const campaignStart = BotSettings.get('freespin_started_at', '1970-01-01 00:00:00');
  const isNewUser = Boolean(user && user.created_at >= campaignStart);
  const usedSpins = db.prepare('SELECT COUNT(*) AS count FROM spin_results WHERE user_id = ?').get(userId).count;
  const forcedLoss = isNewUser && usedSpins < FIRST_SPINS_WITHOUT_PRIZE;
  const prize = forcedLoss
    ? { key: 'no_win', amount: 0 }
    : drawPrize();
  const inserted = db.prepare(`
    INSERT INTO spin_results (user_id, source, prize_key, prize_amount, payout_status)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, source, prize.key, prize.amount, prize.amount > 0 ? 'pending' : 'none');
  return {
    id: inserted.lastInsertRowid,
    source,
    prizeKey: prize.key,
    amount: prize.amount,
    spinNumber: usedSpins + 1,
    forcedLoss,
  };
});

function spin(telegramId) {
  const user = Users.getByTelegramId(telegramId);
  if (!user) throw new Error('USER_NOT_FOUND');
  return createSpin(user.id);
}

function getPrizeWinner(resultId) {
  return db.prepare(`
    SELECT r.*, u.telegram_id, u.username, u.first_name
    FROM spin_results r JOIN users u ON u.id = r.user_id WHERE r.id = ?
  `).get(resultId);
}

function listActiveAdminTelegramIds(configuredIds = []) {
  const stored = db.prepare('SELECT user_id FROM admins WHERE active = 1').all().map((row) => row.user_id);
  return [...new Set([...configuredIds, ...stored].map(Number).filter(Number.isFinite))];
}

function markPrizePaid(resultId, telegramAdminId) {
  const admin = db.prepare('SELECT id FROM admins WHERE user_id = ? AND active = 1').get(telegramAdminId);
  const changed = db.prepare(`
    UPDATE spin_results SET payout_status = 'paid', paid_by = ?, paid_at = CURRENT_TIMESTAMP
    WHERE id = ? AND payout_status = 'pending' AND prize_amount > 0
  `).run(admin?.id || null, resultId).changes;
  return changed === 1 ? getPrizeWinner(resultId) : null;
}

module.exports = {
  confirmTopupAndGrantSpins,
  attributeReferralAndGrantSpin,
  getSpinStatus,
  spin,
  getPrizeWinner,
  listActiveAdminTelegramIds,
  markPrizePaid,
};

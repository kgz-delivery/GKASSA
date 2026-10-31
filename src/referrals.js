const crypto = require('crypto');
const { db } = require('./database');

const MINIMUM_REFERRAL_PAYOUT = 100;

function money(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function creditReferralCommission(referredUserId, transactionId, depositAmount) {
  const referred = db.prepare(`
    SELECT u.id, u.referrer_user_id, r.telegram_id AS referrer_telegram_id
    FROM users u LEFT JOIN users r ON r.id = u.referrer_user_id
    WHERE u.id = ?
  `).get(referredUserId);
  if (!referred?.referrer_user_id || !referred.referrer_telegram_id) return null;

  const deposit = money(depositAmount);
  const commission = money(deposit * 0.03);
  if (commission <= 0) return null;

  const inserted = db.prepare(`
    INSERT OR IGNORE INTO referral_commissions
      (referrer_user_id, referred_user_id, transaction_id, deposit_amount, commission_amount)
    VALUES (?, ?, ?, ?, ?)
  `).run(referred.referrer_user_id, referred.id, transactionId, deposit, commission);
  if (!inserted.changes) return null;

  return {
    referrerUserId: referred.referrer_user_id,
    referrerTelegramId: referred.referrer_telegram_id,
    referredUserId: referred.id,
    depositAmount: deposit,
    commissionAmount: commission,
  };
}

function getReferralBalance(userId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(commission_amount), 0) AS earned,
      COALESCE(SUM(CASE WHEN status = 'available' THEN commission_amount ELSE 0 END), 0) AS available,
      COALESCE(SUM(CASE WHEN status = 'requested' THEN commission_amount ELSE 0 END), 0) AS pending,
      COALESCE(SUM(CASE WHEN status = 'paid' THEN commission_amount ELSE 0 END), 0) AS paid,
      COUNT(DISTINCT referred_user_id) AS invited_count
    FROM referral_commissions WHERE referrer_user_id = ?
  `).get(userId);
  const activity = db.prepare(`
    SELECT COUNT(*) AS deposit_count,
      COALESCE(SUM(deposit_amount), 0) AS deposit_total
    FROM referral_commissions WHERE referrer_user_id = ?
  `).get(userId);
  const latestCommission = db.prepare(`
    SELECT deposit_amount, commission_amount
    FROM referral_commissions WHERE referrer_user_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(userId) || null;
  const invitedCount = db.prepare('SELECT COUNT(*) AS count FROM users WHERE referrer_user_id = ?').get(userId).count;
  return {
    earned: money(row.earned),
    available: money(row.available),
    pending: money(row.pending),
    paid: money(row.paid),
    invitedCount,
    depositCount: activity.deposit_count,
    depositTotal: money(activity.deposit_total),
    latestCommission,
  };
}

const createPayoutRequestTransaction = db.transaction((userId, paymentDetails) => {
  const available = getReferralBalance(userId).available;
  if (available < MINIMUM_REFERRAL_PAYOUT) {
    const error = new Error('REFERRAL_PAYOUT_MINIMUM');
    error.available = available;
    throw error;
  }

  const requestId = `REF-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const created = db.prepare(`
    INSERT INTO referral_payout_requests (request_id, user_id, amount, payment_details)
    VALUES (?, ?, ?, ?)
  `).run(requestId, userId, available, paymentDetails);
  const reserved = db.prepare(`
    UPDATE referral_commissions
    SET status = 'requested', payout_request_id = ?
    WHERE referrer_user_id = ? AND status = 'available'
  `).run(created.lastInsertRowid, userId);
  if (!reserved.changes) throw new Error('REFERRAL_PAYOUT_RESERVATION_FAILED');
  return getPayoutRequest(requestId);
});

function createPayoutRequest(userId, paymentDetails) {
  return createPayoutRequestTransaction(userId, String(paymentDetails || '').trim());
}

function getPayoutRequest(requestId) {
  return db.prepare(`
    SELECT p.*, u.telegram_id, u.username, u.first_name
    FROM referral_payout_requests p JOIN users u ON u.id = p.user_id
    WHERE p.request_id = ?
  `).get(requestId);
}

const resolvePayoutRequestTransaction = db.transaction((requestId, resolution, adminTelegramId = null) => {
  if (!['paid', 'rejected'].includes(resolution)) throw new Error('INVALID_PAYOUT_RESOLUTION');
  const request = getPayoutRequest(requestId);
  if (!request || request.status !== 'pending') return null;

  const changed = db.prepare(`
    UPDATE referral_payout_requests
    SET status = ?, paid_by_telegram_id = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE request_id = ? AND status = 'pending'
  `).run(resolution, resolution === 'paid' ? adminTelegramId : null, requestId).changes;
  if (!changed) return null;

  db.prepare(`
    UPDATE referral_commissions
    SET status = ?, payout_request_id = CASE WHEN ? = 'rejected' THEN NULL ELSE payout_request_id END
    WHERE payout_request_id = ? AND status = 'requested'
  `).run(resolution === 'paid' ? 'paid' : 'available', resolution, request.id);
  return getPayoutRequest(requestId);
});

function resolvePayoutRequest(requestId, resolution, adminTelegramId) {
  return resolvePayoutRequestTransaction(requestId, resolution, adminTelegramId);
}

module.exports = {
  MINIMUM_REFERRAL_PAYOUT,
  creditReferralCommission,
  getReferralBalance,
  createPayoutRequest,
  getPayoutRequest,
  resolvePayoutRequest,
};

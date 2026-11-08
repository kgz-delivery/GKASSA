const { MobcashApiError, MobcashUnknownError } = require('./mobcash');

class MobcashPersistenceError extends Error {
  constructor(message, { transactionId, payerId, amountText, depositSucceeded = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MobcashPersistenceError';
    this.transactionId = transactionId;
    this.payerId = payerId;
    this.amountText = amountText;
    this.depositSucceeded = depositSucceeded;
  }
}

function createMobcashTopupProcessor({ getClient, orders, dryRun = false, logger = console, now = () => Date.now() }) {
  function log(transaction, result) {
    logger.info?.(`[Mob-Cash] ${JSON.stringify({
      at: new Date(now()).toISOString(),
      transaction_id: transaction.transaction_id,
      payerId: String(transaction.payment_id),
      amount: String(transaction.amount_text),
      result,
    })}`);
  }

  async function process(transaction) {
    const transactionSite = String(transaction.site || '').trim().toLowerCase();
    const explicitBookmaker = String(transaction.bookmaker || '').trim().toLowerCase();
    if (explicitBookmaker && transactionSite && explicitBookmaker !== transactionSite) {
      throw new TypeError('Mob-Cash bookmaker does not match the transaction bookmaker');
    }
    const bookmaker = transactionSite || explicitBookmaker;
    if (!bookmaker || typeof getClient !== 'function') {
      throw new TypeError('A bookmaker-specific Mob-Cash client is required');
    }
    const client = getClient(bookmaker);
    const payerId = String(transaction.payment_id);
    const amountText = String(transaction.amount_text);
    if (!/^\d+$/.test(amountText)) {
      throw new TypeError('Mob-Cash deposits require a whole-number amount');
    }
    const context = { transactionId: transaction.transaction_id, payerId, amountText, bookmaker };
    const account = await client.checkAccount(payerId, context);

    if (dryRun) {
      return { state: 'dry_run', nickname: account.nickname };
    }

    const claim = orders.claim(transaction.transaction_id, payerId, amountText, account.nickname, bookmaker);
    if (!claim.claimed) {
      return { state: 'already_processing', order: claim.order };
    }

    log({ ...transaction, payment_id: payerId, amount_text: amountText }, 'deposit_request');
    let result;
    try {
      result = await client.deposit(payerId, amountText, context);
    } catch (error) {
      const state = error instanceof MobcashApiError ? 'failed' : 'unknown';
      const safeResponse = typeof error.safeResponse === 'string' ? error.safeResponse : null;
      let saved;
      try {
        saved = orders.finishSending(transaction.transaction_id, state, {
          apiResponse: safeResponse,
          error: String(error.message || 'Mob-Cash request failed').slice(0, 1000),
        });
      } catch (persistError) {
        throw new MobcashPersistenceError('Could not persist Mob-Cash deposit failure state', {
          ...context, cause: persistError,
        });
      }
      if (!saved) {
        throw new MobcashPersistenceError('Mob-Cash deposit failure state was not saved', context);
      }
      log({ ...transaction, payment_id: payerId, amount_text: amountText }, state);
      return { state, error, nickname: account.nickname };
    }

    try {
      const saved = orders.finishSending(transaction.transaction_id, 'success', {
        apiResponse: result.apiResponse || null,
        nickname: account.nickname,
      });
      if (!saved) throw new Error('Order state was not sending');
    } catch (error) {
      throw new MobcashPersistenceError('Deposit succeeded but its result was not saved', {
        ...context, depositSucceeded: true, cause: error,
      });
    }
    log({ ...transaction, payment_id: payerId, amount_text: amountText }, 'success');
    return { state: 'success', nickname: account.nickname, amount: result.amount };
  }

  return { process };
}

module.exports = { MobcashPersistenceError, createMobcashTopupProcessor };

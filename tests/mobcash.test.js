const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const {
  MobcashApiError,
  MobcashUnknownError,
  createMobcashClient,
  getMobcashClient,
} = require('../src/mobcash');
const { createMobcashTopupProcessor } = require('../src/mobcashTopup');
const { parseTopupAmount, isWholeTopupAmountInput } = require('../src/money');
const { getBookmakerConfig, isMobcashEnabledFor, warnIncompleteMobcashBookmakers } = require('../src/mobcashConfig');
const { recoverSendingMobcashOrders } = require('../src/mobcashRecovery');

function fakeEnv(key, tokenSuffix = '') {
  return {
    [`MOBCASH_${key.toUpperCase()}_CASHBOX_CODE`]: '12345',
    [`MOBCASH_${key.toUpperCase()}_LOGIN`]: `mock-cashier-${key}`,
    [`MOBCASH_${key.toUpperCase()}_PASSWORD`]: `mock-password-${key}`,
    MOBCASH_ENABLED: '1',
    MOBCASH_BOOKMAKERS: key,
    ...(tokenSuffix ? { [`MOBCASH_${key.toUpperCase()}_BASE_URL`]: `https://${tokenSuffix}.example` } : {}),
  };
}

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

function loginResponse(token = 'mock-token') {
  return response(200, {
    accessToken: token,
    sessionID: 'mock-session',
    userID: 'mock-user',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

function apiSuccess(result) {
  return response(200, [{ id: 1, jsonrpc: '2.0', result }]);
}

test('checks account and deposits with JSON-RPC; normalizes amount strings', async () => {
  const requests = [];
  const logs = [];
  const client = createMobcashClient({
    bookmakerKey: '1xbet',
    env: fakeEnv('1xbet'),
    logger: { info: (line) => logs.push(line) },
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      if (url.endsWith('/login')) return loginResponse();
      if (url.endsWith('/payerNickname')) return apiSuccess({ nickname: 'Test Player' });
      return apiSuccess({ success: true, amount: 10 });
    },
  });

  assert.deepEqual(await client.checkAccount('123456', { transactionId: 'TX-1' }), {
    nickname: 'Test Player',
    apiResponse: JSON.stringify([{ id: 1, jsonrpc: '2.0', result: { nickname: 'Test Player' } }]),
  });
  const deposited = await client.deposit('123456', '10.00', {
    transactionId: 'TX-1', amountText: '10',
  });
  assert.equal(deposited.success, true);
  assert.equal(deposited.amount, '10');
  const depositRequest = requests.find((request) => request.url.endsWith('/deposit'));
  assert.deepEqual(depositRequest.body, {
    id: 1,
    jsonrpc: '2.0',
    params: {
      deposit: { amount: '10', payerID: '123456' },
      sessionID: 'mock-session',
      userID: 'mock-user',
    },
  });
  assert.equal(depositRequest.options.headers.Authorization, 'Bearer mock-token');
  assert.ok(logs.every((line) => !line.includes('mock-password') && !line.includes('mock-token')));
});

test('relogs in when token is within the 60 second refresh window', async () => {
  let now = Date.now();
  let logins = 0;
  const expiresAt = now + 120_000;
  const client = createMobcashClient({
    bookmakerKey: '1xbet',
    env: fakeEnv('1xbet'),
    now: () => now,
    logger: { info() {} },
    fetchImpl: async (url) => {
      if (url.endsWith('/login')) {
        logins += 1;
        return response(200, {
          accessToken: `mock-token-${logins}`,
          sessionID: 'mock-session',
          userID: 'mock-user',
          expiresAt: new Date(expiresAt).toISOString(),
        });
      }
      return apiSuccess({ nickname: 'Test Player' });
    },
  });
  await client.checkAccount('123456');
  now = expiresAt - 30_000;
  await client.checkAccount('123456');
  assert.equal(logins, 2);
});

test('retries one time after HTTP 401 using a refreshed token', async () => {
  let logins = 0;
  let accountRequests = 0;
  const client = createMobcashClient({
    bookmakerKey: '1xbet',
    env: fakeEnv('1xbet'),
    logger: { info() {} },
    fetchImpl: async (url) => {
      if (url.endsWith('/login')) return loginResponse(`mock-token-${++logins}`);
      accountRequests += 1;
      if (accountRequests === 1) return response(401, { error: 'unauthorized' });
      return apiSuccess({ nickname: 'Test Player' });
    },
  });
  const account = await client.checkAccount('123456');
  assert.equal(account.nickname, 'Test Player');
  assert.equal(logins, 2);
  assert.equal(accountRequests, 2);
});

test('treats a deposit timeout as an unknown outcome', async () => {
  const client = createMobcashClient({
    bookmakerKey: '1xbet',
    env: fakeEnv('1xbet'),
    timeoutMs: 5,
    logger: { info() {} },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/login')) return loginResponse();
      if (url.endsWith('/payerNickname')) return apiSuccess({ nickname: 'Test Player' });
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
  });
  await assert.rejects(client.deposit('123456', '10'), MobcashUnknownError);
});

test('reports an explicit account-not-found API response without depositing', async () => {
  let deposits = 0;
  const logs = [];
  const client = createMobcashClient({
    bookmakerKey: '1xbet',
    env: fakeEnv('1xbet'),
    logger: { info: (line) => logs.push(line) },
    fetchImpl: async (url) => {
      if (url.endsWith('/login')) return loginResponse();
      if (url.endsWith('/payerNickname')) return response(200, [{ error: { message: 'Account not found' } }]);
      deposits += 1;
      return apiSuccess({ success: true, amount: '10' });
    },
  });
  await assert.rejects(client.checkAccount('123456'), MobcashApiError);
  assert.equal(deposits, 0);
  const checkLog = logs.map((line) => JSON.parse(line.replace(/^\[Mob-Cash\] /, '')))
    .find((record) => record.result === 'api_error');
  assert.equal(checkLog.message, 'Account not found');
  assert.equal(checkLog.code, '');
  assert.equal(checkLog.payerId, '123456');
  assert.equal(checkLog.bookmaker, '1xbet');
  assert.equal(logs.some((line) => line.includes('Account not found') && line.includes('result')), true);
});

test('empty nickname is logged and accepted after a successful account lookup', async () => {
  const logs = [];
  const client = createMobcashClient({
    bookmakerKey: '1xbet', env: fakeEnv('1xbet'), logger: { info: (line) => logs.push(line) },
    fetchImpl: async (url) => url.endsWith('/login') ? loginResponse() : apiSuccess({ nickname: null, privateField: 'do-not-log' }),
  });
  const account = await client.checkAccount('123456', { transactionId: 'TX-EMPTY' });
  assert.equal(account.nickname, null);
  const resultLog = logs.map((line) => JSON.parse(line.replace(/^\[Mob-Cash\] /, '')))
    .find((record) => record.result === 'empty_nickname');
  assert.equal(resultLog.transaction_id, 'TX-EMPTY');
  assert.equal(resultLog.bookmaker, '1xbet');
  assert.equal(logs.every((line) => !line.includes('do-not-log')), true);
});

test('successful account lookup without nickname still claims order and sends deposit', async () => {
  let deposits = 0;
  let claims = 0;
  let state = 'sending';
  const processor = createMobcashTopupProcessor({
    getClient: () => ({
      async checkAccount() { return { nickname: null }; },
      async deposit() { deposits += 1; return { success: true, amount: '10', apiResponse: '{}' }; },
    }),
    orders: {
      claim(_id, _payer, _amount, nickname) { claims += 1; assert.equal(nickname, null); return { claimed: true }; },
      finishSending(_id, nextState) { state = nextState; return true; },
    }, logger: { info() {} },
  });
  const result = await processor.process({ transaction_id: 'TX-EMPTY', site: '1xbet', payment_id: '123', amount_text: '10' });
  assert.equal(result.state, 'success');
  assert.equal(deposits, 1);
  assert.equal(claims, 1);
  assert.equal(state, 'success');
});

test('top-up keyboards include client contact, copy id, and original action buttons', () => {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'telegraf') return { Markup: {
      inlineKeyboard: (rows) => ({ reply_markup: { inline_keyboard: rows } }),
      button: {
        callback: (text, callback_data) => ({ text, callback_data }),
        url: (text, url) => ({ text, url }),
      },
    } };
    if (request === '../../models' && parent?.filename.endsWith('adminKeyboard.js')) return { BotSettings: { get: () => '0' } };
    return originalLoad.call(this, request, parent, isMain);
  };
  let confirmTopupKeyboard;
  let confirmTopupFinalKeyboard;
  try {
    ({ confirmTopupKeyboard, confirmTopupFinalKeyboard } = require('../src/bot/keyboards/adminKeyboard'));
  } finally {
    Module._load = originalLoad;
  }
  const contact = { username: 'player_name', telegramId: 12345, payerId: '987654321' };
  const rows = confirmTopupKeyboard('TX-KB', contact).reply_markup.inline_keyboard;
  assert.deepEqual(rows[0][0], { text: '✉️ Написать клиенту', url: 'https://t.me/player_name' });
  assert.deepEqual(rows[1][0], { text: 'copy id', copy_text: { text: '987654321' } });
  assert.deepEqual(rows[2].map((button) => button.text), ['✅ Подтвердить', '❌ Отклонить']);
  const noUsername = confirmTopupFinalKeyboard('TX-KB', { telegramId: 12345, payerId: '987654321' })
    .reply_markup.inline_keyboard;
  assert.equal(noUsername[0][0].url, 'tg://user?id=12345');
  assert.equal(noUsername[1][0].copy_text.text, '987654321');
  assert.match(noUsername[2][0].text, /Вы уверены/);
});

test('does not send deposit twice for the same order', async () => {
  let currentOrder = null;
  let deposits = 0;
  const orders = {
    claim(transactionId, payerId, amountText, nickname, bookmaker) {
      if (currentOrder) return { claimed: false, order: currentOrder };
      currentOrder = { transaction_id: transactionId, bookmaker, payer_id: payerId, amount_text: amountText, nickname, state: 'sending' };
      return { claimed: true, order: currentOrder };
    },
    finishSending(_transactionId, state) {
      currentOrder.state = state;
      return true;
    },
  };
  const client = {
    async checkAccount() { return { nickname: 'Test Player' }; },
    async deposit() { deposits += 1; return { success: true, amount: '10', apiResponse: '{}' }; },
  };
  const processor = createMobcashTopupProcessor({ getClient: () => client, orders, logger: { info() {} } });
  const transaction = { transaction_id: 'TX-1', site: '1xbet', payment_id: '123456', amount_text: '10' };
  assert.equal((await processor.process(transaction)).state, 'success');
  assert.equal((await processor.process(transaction)).state, 'already_processing');
  assert.equal(deposits, 1);
});

test('unknown deposit outcome is not retried on a second confirmation', async () => {
  let currentOrder = null;
  let deposits = 0;
  const orders = {
    claim(transactionId, payerId, amountText, nickname, bookmaker) {
      if (currentOrder) return { claimed: false, order: currentOrder };
      currentOrder = { transaction_id: transactionId, bookmaker, payer_id: payerId, amount_text: amountText, nickname, state: 'sending' };
      return { claimed: true, order: currentOrder };
    },
    finishSending(_transactionId, state) { currentOrder.state = state; return true; },
  };
  const processor = createMobcashTopupProcessor({
    getClient: () => ({
      async checkAccount() { return { nickname: 'Test Player' }; },
      async deposit() { deposits += 1; throw new MobcashUnknownError('connection lost'); },
    }),
    orders, logger: { info() {} },
  });
  const transaction = { transaction_id: 'TX-UNKNOWN', site: '1xbet', payment_id: '123456', amount_text: '10' };
  assert.equal((await processor.process(transaction)).state, 'unknown');
  assert.equal((await processor.process(transaction)).state, 'already_processing');
  assert.equal(deposits, 1);
});

test('failed deposit order cannot be claimed and deposited a second time', async () => {
  let currentOrder = null;
  let deposits = 0;
  const orders = {
    claim(transactionId, payerId, amountText, nickname, bookmaker) {
      if (currentOrder) return { claimed: false, order: currentOrder };
      currentOrder = { transaction_id: transactionId, bookmaker, payer_id: payerId, amount_text: amountText, nickname, state: 'sending' };
      return { claimed: true, order: currentOrder };
    },
    finishSending(_transactionId, state) { currentOrder.state = state; return true; },
  };
  const processor = createMobcashTopupProcessor({
    getClient: () => ({
      async checkAccount() { return { nickname: 'Test Player' }; },
      async deposit() { deposits += 1; throw new MobcashApiError('declined'); },
    }),
    orders, logger: { info() {} },
  });
  const transaction = { transaction_id: 'TX-FAILED', site: '1xbet', payment_id: '123456', amount_text: '10' };
  assert.equal((await processor.process(transaction)).state, 'failed');
  assert.equal((await processor.process(transaction)).state, 'already_processing');
  assert.equal(deposits, 1);
});

test('dry-run checks the account but never claims or deposits an order', async () => {
  let deposits = 0;
  const processor = createMobcashTopupProcessor({
    getClient: () => ({
      async checkAccount() { return { nickname: 'Test Player' }; },
      async deposit() { deposits += 1; },
    }),
    orders: { claim() { throw new Error('dry-run must not claim an order'); } },
    dryRun: true,
    logger: { info() {} },
  });
  const result = await processor.process({ transaction_id: 'TX-2', site: '1xbet', payment_id: '123456', amount_text: '10' });
  assert.deepEqual(result, { state: 'dry_run', nickname: 'Test Player' });
  assert.equal(deposits, 0);
});

test('amount input is strict and limited to two fractional digits', () => {
  assert.equal(parseTopupAmount('100abc'), null);
  assert.equal(parseTopupAmount('10.123'), null);
  assert.equal(parseTopupAmount('9.99'), null);
  assert.equal(parseTopupAmount('10000.01'), null);
  assert.equal(parseTopupAmount('10,25').amountText, '10.25');
  assert.equal(isWholeTopupAmountInput('10'), true);
  assert.equal(isWholeTopupAmountInput('10.0'), false);
  assert.equal(isWholeTopupAmountInput('10,0'), false);
});

test('a bookmaker without its own credentials remains on the manual path', () => {
  const env = { ...fakeEnv('1xbet'), MOBCASH_ENABLED: '1', MOBCASH_BOOKMAKERS: '1xbet,melbet' };
  assert.equal(isMobcashEnabledFor('1xbet', env), true);
  assert.equal(isMobcashEnabledFor('melbet', env), false);
  assert.deepEqual(getBookmakerConfig('melbet', env).missing, [
    'MOBCASH_MELBET_CASHBOX_CODE', 'MOBCASH_MELBET_LOGIN', 'MOBCASH_MELBET_PASSWORD',
  ]);
  const warnings = [];
  warnIncompleteMobcashBookmakers(env, { warn: (line) => warnings.push(line) });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /melbet/);
  assert.doesNotMatch(warnings[0], /mock-password|12345/);
});

test('Mob-Cash client instances keep bookmaker tokens and API hosts separate', async () => {
  const seen = [];
  function clientFor(key) {
    return createMobcashClient({
      bookmakerKey: key,
      env: fakeEnv(key, `${key}.mobcash`),
      logger: { info() {} },
      fetchImpl: async (url, options) => {
        if (url.endsWith('/login')) return loginResponse(`token-${key}`);
        seen.push({ key, url, authorization: options.headers.Authorization });
        return apiSuccess({ nickname: `${key} player` });
      },
    });
  }
  await clientFor('1xbet').checkAccount('111');
  await clientFor('melbet').checkAccount('222');
  assert.deepEqual(seen.map((item) => [item.key, item.authorization, item.url]), [
    ['1xbet', 'Bearer token-1xbet', 'https://1xbet.mobcash.example/api/v1/mobile/payerNickname'],
    ['melbet', 'Bearer token-melbet', 'https://melbet.mobcash.example/api/v1/mobile/payerNickname'],
  ]);
  assert.strictEqual(getMobcashClient('1xbet'), getMobcashClient('1xbet'));
  assert.notStrictEqual(getMobcashClient('1xbet'), getMobcashClient('melbet'));
});

test('a 1xbet transaction cannot be routed through a different bookmaker client', async () => {
  const selected = [];
  const processor = createMobcashTopupProcessor({
    getClient(key) {
      selected.push(key);
      return { async checkAccount() { throw new Error('must not reach API'); } };
    },
    orders: { claim() { throw new Error('must not claim another bookmaker order'); } },
    logger: { info() {} },
  });
  await assert.rejects(processor.process({
    transaction_id: 'TX-ROUTE', site: '1xbet', bookmaker: 'melbet', payment_id: '123', amount_text: '10',
  }), /does not match/);
  assert.deepEqual(selected, []);
});

test('startup recovery moves sending orders to unknown without notifying admins', async () => {
  const order = {
    transaction_id: 'TX-RESTART', bookmaker: '1xbet', payment_id: '1234567890', amount_text: '50', state: 'sending',
  };
  const orders = {
    getSendingForRecovery() { return order.state === 'sending' ? [{ ...order }] : []; },
    markSendingUnknown(transactionId) {
      if (transactionId !== order.transaction_id || order.state !== 'sending') return false;
      order.state = 'unknown';
      return true;
    },
  };
  const logs = [];
  const recovered = await recoverSendingMobcashOrders({
    orders,
    formatBookmaker: (key) => key === '1xbet' ? '1XBET' : key,
    logger: { info: (...args) => logs.push(args) },
  });
  assert.equal(recovered, 1);
  assert.equal(order.state, 'unknown');
  assert.equal(logs.length, 1);
  assert.match(logs[0][1], /TX-RESTART/);
  assert.match(logs[0][1], /1XBET/);
  assert.match(logs[0][1], /"state":"unknown"/);
});

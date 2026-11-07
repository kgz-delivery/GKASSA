const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'gkassa-payment-tests-'));
process.env.DB_PATH = path.join(tempDirectory, 'payments.db');
process.env.ADMIN_TELEGRAM_IDS = '';
process.env.PAYMENT_DEVICE_TOKEN = 'test-payment-device-token';
process.env.MOBCASH_DRY_RUN = '0';

const { initDatabase, db } = require('../src/database');
const { reservePaymentOrder } = require('../src/paymentOrders');
const { setupPaymentApi, parseAmountCents } = require('../src/paymentApi');
const { Users } = require('../src/models');
const { Transactions } = require('../src/models');
const { runManualTopup } = require('../src/manualTopups');
const config = require('../src/config');
const express = require('express');

initDatabase();

test('seeds Optima only and reserves distinct cents for concurrent requests', async () => {
  const banks = db.prepare('SELECT bank_code FROM banks').all();
  assert.deepEqual(banks.map((bank) => bank.bank_code), ['optima']);
  const template = db.prepare(`
    SELECT * FROM bank_templates WHERE bank_id = (SELECT id FROM banks WHERE bank_code = 'optima')
  `).get();
  const notification = 'Пополнение по QR\nНа сумму: 100.00 KGS\nОт: Абдыманнапов Э. Э.';
  assert.equal(new RegExp(template.regex_amount).exec(notification)?.[1], '100.00');
  assert.equal(new RegExp(template.regex_sender).exec(notification)?.[1], 'Абдыманнапов Э. Э.');

  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.resolve().then(() =>
    reservePaymentOrder({
      telegramUserId: 800000 + index,
      bookmaker: '1xbet',
      playerId: String(100000 + index),
      amountRequested: 100,
    })
  )));

  assert.ok(results.every((result) => result.ok));
  assert.equal(new Set(results.map((result) => result.amountUniqueCents)).size, 20);
  assert.deepEqual(results.slice(0, 3).map((result) => result.amountUnique), ['100.01', '100.02', '100.03']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payment_reservations').get().count, 20);

  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads');
    process.env.DB_PATH = workerData.databasePath;
    process.env.ADMIN_TELEGRAM_IDS = '';
    const { db } = require(workerData.databaseModule);
    db.pragma('busy_timeout = 10000');
    const { reservePaymentOrder } = require(workerData.ordersModule);
    try {
      parentPort.postMessage(reservePaymentOrder({
        telegramUserId: workerData.telegramId,
        bookmaker: '1xbet', playerId: String(workerData.telegramId), amountRequested: 101,
      }));
    } catch (error) {
      parentPort.postMessage({ error: error.message });
    } finally {
      db.close();
    }
  `;
  const workerResults = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: {
        databasePath: process.env.DB_PATH,
        databaseModule: path.resolve(__dirname, '../src/database.js'),
        ordersModule: path.resolve(__dirname, '../src/paymentOrders.js'),
        telegramId: 850000 + index,
      },
    });
    worker.once('message', resolve);
    worker.once('error', reject);
  })));
  assert.ok(workerResults.every((result) => result.ok));
  assert.equal(new Set(workerResults.map((result) => result.amountUniqueCents)).size, 8);
});

test('only reserves cents through ninety-nine and then reports exhaustion', () => {
  const existing = db.prepare(`
    SELECT COUNT(*) AS count FROM payment_reservations WHERE amount_unique_cents BETWEEN 10001 AND 10099
  `).get().count;
  for (let index = existing; index < 99; index += 1) {
    const result = reservePaymentOrder({
      telegramUserId: 810000 + index,
      bookmaker: 'melbet',
      playerId: String(200000 + index),
      amountRequested: 100,
    });
    assert.equal(result.ok, true);
  }
  const exhausted = reservePaymentOrder({
    telegramUserId: 820000,
    bookmaker: 'mostbet',
    playerId: '300000',
    amountRequested: 100,
  });
  assert.deepEqual(exhausted, { ok: false, reason: 'no_free_amounts' });
});

test('parses exact KGS cents and rejects ambiguous amount strings', () => {
  assert.equal(parseAmountCents('100.37'), 10037);
  assert.equal(parseAmountCents('100'), 10000);
  assert.equal(parseAmountCents('100.3'), 10030);
  assert.equal(parseAmountCents('100,37'), null);
  assert.equal(parseAmountCents('100.377'), null);
  assert.equal(parseAmountCents('0'), null);
});

test('payment endpoint handles zero, one, multiple candidates and hash duplicates', async () => {
  const app = express();
  app.use(express.json());
  const healthTimer = setupPaymentApi(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sendPayment = async (hash, amount, receivedAt = new Date().toISOString()) => {
    const response = await fetch(`${baseUrl}/api/payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': 'test-reader',
        'x-token': 'test-payment-device-token',
      },
      body: JSON.stringify({
        device_id: 'test-reader', bank_code: 'optima', package_name: 'kz.optimabank.optima24',
        amount, sender: null, raw_text: `Оплата ${amount} KGS`, received_at: receivedAt, hash,
      }),
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    const noCandidate = await sendPayment('payment-no-match', '300.11');
    assert.equal(noCandidate.body.status, 'unmatched');

    const user = Users.createOrUpdate(830001, { username: 'autopay_test' });
    const single = reservePaymentOrder({ telegramUserId: user.telegram_id, bookmaker: '1xbet', playerId: '777001', amountRequested: 500 });
    const matched = await sendPayment('payment-one-match', single.amountUnique);
    assert.equal(matched.body.status, 'matched');
    assert.equal(db.prepare('SELECT status FROM incoming_payments WHERE hash = ?').get('payment-one-match').status, 'manual_review');

    const duplicate = await sendPayment('payment-one-match', single.amountUnique);
    assert.deepEqual(duplicate, { status: 200, body: { status: 'duplicate' } });

    const ambiguous = reservePaymentOrder({ telegramUserId: 830002, bookmaker: 'melbet', playerId: '777002', amountRequested: 501 });
    db.prepare(`
      INSERT INTO orders (telegram_user_id, bookmaker, player_id, amount_requested, amount_unique_cents, bank_id, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now', '+10 minutes'))
    `).run(830003, 'mostbet', '777003', 501, ambiguous.amountUniqueCents, ambiguous.bankId);
    const multiple = await sendPayment('payment-multiple-match', ambiguous.amountUnique);
    assert.equal(multiple.body.status, 'unmatched');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM orders WHERE amount_unique_cents = ? AND status = 'manual_review'")
      .get(ambiguous.amountUniqueCents).count, 2);
  } finally {
    clearInterval(healthTimer);
    await new Promise((resolve) => server.close(resolve));
  }
});

test('manual bookmaker top-up uses the existing API processor and records one completion', async () => {
  process.env.MOBCASH_ENABLED = '1';
  process.env.MOBCASH_BOOKMAKERS = '1xbet';
  process.env.MOBCASH_1XBET_CASHBOX_CODE = 'cashbox';
  process.env.MOBCASH_1XBET_LOGIN = 'login';
  process.env.MOBCASH_1XBET_PASSWORD = 'password';
  db.prepare("INSERT INTO admins (user_id, role, active) VALUES (840001, 'superadmin', 1)").run();
  let deposits = 0;
  const result = await runManualTopup({
    adminTelegramId: 840001,
    bookmaker: '1xbet',
    playerId: '87654321',
    amount: 250,
    reason: 'тестовый розыгрыш',
    getClient: () => ({
      async checkAccount() { return { nickname: 'test-player' }; },
      async deposit() { deposits += 1; return { apiResponse: '{"success":true}' }; },
    }),
  });
  assert.equal(result.state, 'success');
  assert.equal(deposits, 1);
  const saved = db.prepare('SELECT status, amount, reason FROM manual_topups WHERE id = ?').get(result.id);
  assert.deepEqual(saved, { status: 'completed', amount: 250, reason: 'тестовый розыгрыш' });
});

test('operator manual top-ups enforce per-operation and Bishkek daily caps', async () => {
  db.prepare("INSERT INTO admins (user_id, role, active, manual_limit, daily_limit) VALUES (840002, 'operator', 1, 900, 1000)").run();
  const getClient = () => ({
    async checkAccount() { return { nickname: 'operator-test' }; },
    async deposit() { return { apiResponse: '{"success":true}' }; },
  });
  await assert.rejects(runManualTopup({
    adminTelegramId: 840002, bookmaker: '1xbet', playerId: '87654322', amount: 901,
    reason: 'превышен лимит операции', getClient,
  }), /Лимит оператора/);

  const first = await runManualTopup({
    adminTelegramId: 840002, bookmaker: '1xbet', playerId: '87654323', amount: 200,
    reason: 'операторская операция', getClient,
  });
  assert.equal(first.state, 'success');
  await assert.rejects(runManualTopup({
    adminTelegramId: 840002, bookmaker: '1xbet', playerId: '87654324', amount: 801,
    reason: 'дневной лимит', getClient,
  }), /Дневной лимит/);
});

test('matched payment calls the mocked bookmaker API once and completes its order', async () => {
  const previousLimit = config.paymentAutomation.autoConfirmMaxSom;
  config.paymentAutomation.autoConfirmMaxSom = 700;
  const app = express();
  app.use(express.json());
  let deposits = 0;
  const healthTimer = setupPaymentApi(app, {
    isBookmakerEnabled: () => true,
    getClient: () => ({
      async checkAccount() { return { nickname: 'mock-player' }; },
      async deposit() { deposits += 1; return { apiResponse: '{"success":true}' }; },
    }),
    confirmTopup: async (transactionId) => {
      const transaction = Transactions.getByTransactionId(transactionId);
      return transaction && Transactions.updateStatus(transaction.id, 'confirmed').changes === 1;
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const user = Users.createOrUpdate(830004, { username: 'mock_autopay' });
  const order = reservePaymentOrder({
    telegramUserId: user.telegram_id, bookmaker: '1xbet', playerId: '777004', amountRequested: 600,
  });

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': 'mock-reader',
        'x-token': 'test-payment-device-token',
      },
      body: JSON.stringify({
        device_id: 'mock-reader', bank_code: 'optima', package_name: 'kz.optimabank.optima24',
        amount: order.amountUnique, sender: 'Тест', raw_text: `На сумму: ${order.amountUnique} KGS`,
        received_at: new Date().toISOString(), hash: 'payment-mocked-bookmaker-flow',
      }),
    });
    assert.deepEqual(await response.json(), { status: 'matched' });
    const savedOrder = db.prepare('SELECT status, auto_confirmed FROM orders WHERE id = ?').get(order.orderId);
    assert.deepEqual(savedOrder, { status: 'completed', auto_confirmed: 1 });
    assert.equal(deposits, 1);

    const duplicateResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/payments`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-device-id': 'mock-reader',
        'x-token': 'test-payment-device-token',
      },
      body: JSON.stringify({
        device_id: 'mock-reader', bank_code: 'optima', package_name: 'kz.optimabank.optima24',
        amount: order.amountUnique, sender: 'Тест', raw_text: `На сумму: ${order.amountUnique} KGS`,
        received_at: new Date().toISOString(), hash: 'payment-mocked-bookmaker-flow',
      }),
    });
    assert.deepEqual(await duplicateResponse.json(), { status: 'duplicate' });
    assert.equal(deposits, 1);
  } finally {
    config.paymentAutomation.autoConfirmMaxSom = previousLimit;
    clearInterval(healthTimer);
    await new Promise((resolve) => server.close(resolve));
  }
});

test.after(() => {
  db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

const DEFAULT_BASE_URL = 'https://admin.mob-cash.com';
const REQUEST_TIMEOUT_MS = 20_000;
const TOKEN_REFRESH_MARGIN_MS = 60_000;
const clients = new Map();
const { getBookmakerConfig } = require('./mobcashConfig');

class MobcashApiError extends Error {
  constructor(message, { operation = 'unknown', statusCode = null, safeResponse = null, code = null, apiMessage = null } = {}) {
    super(message);
    this.name = 'MobcashApiError';
    this.operation = operation;
    this.statusCode = statusCode;
    this.safeResponse = safeResponse;
    this.code = code;
    this.apiMessage = apiMessage;
  }
}

class MobcashUnknownError extends Error {
  constructor(message, { operation = 'unknown', statusCode = null, safeResponse = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MobcashUnknownError';
    this.operation = operation;
    this.statusCode = statusCode;
    this.safeResponse = safeResponse;
  }
}

function firstResult(payload) {
  return Array.isArray(payload) ? payload[0] : payload;
}

function safeJson(value) {
  return JSON.stringify(value, (key, item) =>
    /password|token|authorization|withdrawalcode/i.test(key) ? '***' : item
  );
}

function normalizeAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new MobcashUnknownError('API returned an invalid amount', { operation: 'amount' });
  }
  const raw = String(value).trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new MobcashUnknownError('API returned an invalid amount', { operation: 'amount' });
  }
  const [whole, fraction = ''] = raw.split('.');
  const normalizedWhole = whole.replace(/^0+(?=\d)/, '');
  const normalizedFraction = fraction.replace(/0+$/, '');
  return normalizedFraction ? `${normalizedWhole}.${normalizedFraction}` : normalizedWhole;
}

function createMobcashClient({
  bookmakerKey,
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = REQUEST_TIMEOUT_MS,
  now = () => Date.now(),
  logger = console,
} = {}) {
  let auth = null;
  let loginPromise = null;

  function configValues() {
    return getBookmakerConfig(bookmakerKey, env);
  }

  function log(context, result) {
    const record = {
      at: new Date(now()).toISOString(),
      transaction_id: context?.transactionId || null,
      payerId: context?.payerId || null,
      amount: context?.amountText || null,
      result,
    };
    logger.info?.(`[Mob-Cash] ${JSON.stringify(record)}`);
  }

  function sanitizeText(value) {
    let text = typeof value === 'string' ? value : safeJson(value);
    const { password } = configValues();
    if (password) text = text.split(password).join('***');
    if (auth?.accessToken) text = text.split(auth.accessToken).join('***');
    return text.slice(0, 4000);
  }

  async function fetchJson(url, body, headers, operation, context) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let rawBody;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      rawBody = await response.text();
    } catch (error) {
      const timedOut = controller.signal.aborted || error?.name === 'AbortError';
      throw new MobcashUnknownError(timedOut ? 'Mob-Cash request timed out' : 'Mob-Cash connection failed', {
        operation,
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    let payload;
    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch (_) {
      payload = null;
    }
    return { response, payload, safeResponse: sanitizeText(payload ?? rawBody ?? '') };
  }

  function responseError(payload, safeResponse, operation, statusCode) {
    const entry = firstResult(payload);
    const error = entry?.error ?? entry?.result?.error;
    let message = 'Mob-Cash rejected the request';
    if (typeof error === 'string' && error.trim()) message = error.trim();
    else if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) message = error.message.trim();
    else if (error && typeof error === 'object') message = safeJson(error);
    else if (typeof entry?.message === 'string' && entry.message.trim()) message = entry.message.trim();
    else if (statusCode) message = `Mob-Cash returned HTTP ${statusCode}`;
    const apiCode = error && typeof error === 'object' ? error.code ?? null : null;
    const apiMessage = error && typeof error === 'object' && typeof error.message === 'string'
      ? error.message : typeof error === 'string' ? error : entry?.message;
    return new MobcashApiError(sanitizeText(message), {
      operation, statusCode, safeResponse, code: apiCode, apiMessage: sanitizeText(apiMessage || message),
    });
  }

  function assertHttpAndEnvelope(result, operation) {
    const { response, payload, safeResponse } = result;
    if (!response.ok) {
      if (response.status >= 400 && response.status < 500) {
        throw responseError(payload, safeResponse, operation, response.status);
      }
      throw new MobcashUnknownError(`Mob-Cash returned HTTP ${response.status}`, {
        operation,
        statusCode: response.status,
        safeResponse,
      });
    }
    const entry = firstResult(payload);
    if (!entry || typeof entry !== 'object') {
      throw new MobcashUnknownError('Mob-Cash returned an unrecognized response', { operation, safeResponse });
    }
    if (entry.error || entry.result?.error || entry.result?.success === false) {
      throw responseError(payload, safeResponse, operation, response.status);
    }
    return { entry, safeResponse };
  }

  async function login(context = null) {
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const values = configValues();
      const cashboxCode = Number(values.cashboxCode);
      if (values.missing.length || !Number.isFinite(cashboxCode)) {
        throw new MobcashApiError('Mob-Cash credentials are not configured', { operation: 'login' });
      }
      log(context, 'login_request');
      let result;
      try {
        result = await fetchJson(`${values.baseUrl || DEFAULT_BASE_URL}/api/v2/cashbox/login`, {
          cashboxCode,
          login: values.login,
          password: values.password,
        }, {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
        }, 'login', context);
        const { entry, safeResponse } = assertHttpAndEnvelope(result, 'login');
        const data = entry.result && typeof entry.result === 'object' ? entry.result : entry;
        const expiresAtMs = Date.parse(data.expiresAt);
        if (!data.accessToken || !data.sessionID || !data.userID || !Number.isFinite(expiresAtMs)) {
          throw new MobcashUnknownError('Mob-Cash login returned an incomplete response', {
            operation: 'login', safeResponse,
          });
        }
        auth = {
          accessToken: String(data.accessToken),
          sessionID: String(data.sessionID),
          userID: String(data.userID),
          expiresAt: String(data.expiresAt),
          expiresAtMs,
        };
        log(context, 'login_success');
        return auth;
      } catch (error) {
        log(context, 'login_failed');
        throw error;
      }
    })().finally(() => {
      loginPromise = null;
    });
    return loginPromise;
  }

  async function getAuth(context, force = false, rejectedToken = null) {
    if (rejectedToken && auth?.accessToken && auth.accessToken !== rejectedToken && auth.expiresAtMs > now()) {
      return auth;
    }
    if (!force && auth && auth.expiresAtMs - now() > TOKEN_REFRESH_MARGIN_MS) return auth;
    return login(context);
  }

  async function authenticatedPost(method, methodParams, operation, context = null) {
    let currentAuth = await getAuth(context);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      log(context, `${operation}_request`);
      const { baseUrl } = configValues();
      const result = await fetchJson(`${baseUrl || DEFAULT_BASE_URL}/api/v1/mobile/${method}`, {
        id: 1,
        jsonrpc: '2.0',
        params: {
          ...methodParams,
          sessionID: currentAuth.sessionID,
          userID: currentAuth.userID,
        },
      }, {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${currentAuth.accessToken}`,
      }, operation, context);
      if (result.response.status === 401 && attempt === 0) {
        currentAuth = await getAuth(context, true, currentAuth.accessToken);
        continue;
      }
      const parsed = assertHttpAndEnvelope(result, operation);
      return { ...parsed, auth: currentAuth };
    }
    throw new MobcashApiError('Mob-Cash authorization failed after re-login', { operation, statusCode: 401 });
  }

  async function checkAccount(payerId, context = {}) {
    const logCheck = (result, extra = {}) => logger.info?.(`[Mob-Cash] ${JSON.stringify({
      at: new Date(now()).toISOString(),
      transaction_id: context?.transactionId || null,
      payerId: String(payerId),
      bookmaker: context?.bookmaker || bookmakerKey,
      result,
      ...extra,
    })}`);
    try {
      const { entry, safeResponse } = await authenticatedPost(
        'payerNickname', { payerID: String(payerId) }, 'payerNickname', { ...context, payerId: String(payerId) }
      );
      if (!entry.result || typeof entry.result !== 'object') {
        throw new MobcashUnknownError('Mob-Cash returned an account lookup without a result', {
          operation: 'payerNickname', safeResponse,
        });
      }
      const nickname = entry.result?.nickname;
      if (typeof nickname !== 'string' || !nickname.trim()) {
        logCheck('empty_nickname');
        return { nickname: null, apiResponse: safeResponse };
      }
      logCheck('ok');
      return { nickname: nickname.trim(), apiResponse: safeResponse };
    } catch (error) {
      if (error instanceof MobcashApiError && error.code !== 'EMPTY_NICKNAME') {
        const apiMessage = String(error.apiMessage || error.message || '').slice(0, 100);
        logCheck('api_error', { code: String(error.code ?? '').slice(0, 100), message: apiMessage });
      } else if (!(error instanceof MobcashApiError)) {
        logCheck('unknown_error');
      }
      throw error;
    }
  }

  async function deposit(payerId, amount, context = {}) {
    const amountText = normalizeAmount(amount);
    const { entry, safeResponse } = await authenticatedPost(
      'deposit',
      { deposit: { amount: amountText, payerID: String(payerId) } },
      'deposit',
      { ...context, payerId: String(payerId), amountText }
    );
    if (entry.result?.success !== true) {
      throw new MobcashUnknownError('Mob-Cash returned an unrecognized deposit result', {
        operation: 'deposit', safeResponse,
      });
    }
    const rawAmount = entry.result.amount;
    const normalizedResultAmount = rawAmount === undefined || rawAmount === null
      ? amountText
      : normalizeAmount(rawAmount);
    const result = { success: true, amount: normalizedResultAmount };
    log({ ...context, payerId: String(payerId), amountText }, `deposit_success:${normalizedResultAmount}`);
    return { ...result, apiResponse: safeResponse };
  }

  function clearAuth() {
    auth = null;
  }

  return { login, checkAccount, deposit, clearAuth };
}

function getMobcashClient(bookmakerKey) {
  const key = String(bookmakerKey || '').trim().toLowerCase();
  if (!key) throw new TypeError('A bookmaker key is required for Mob-Cash');
  if (!clients.has(key)) clients.set(key, createMobcashClient({ bookmakerKey: key }));
  return clients.get(key);
}

module.exports = {
  MobcashApiError,
  MobcashUnknownError,
  createMobcashClient,
  getMobcashClient,
  normalizeAmount,
};

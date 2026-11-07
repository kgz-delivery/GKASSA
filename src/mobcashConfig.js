function parseBookmakers(env = process.env) {
  return String(env.MOBCASH_BOOKMAKERS || '')
    .split(',').map((key) => key.trim().toLowerCase()).filter(Boolean);
}

function getBookmakerConfig(bookmakerKey, env = process.env) {
  const key = String(bookmakerKey || '').trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(key)) return { key, missing: ['bookmaker key'] };
  const envPrefix = `MOBCASH_${key.toUpperCase()}`;
  const cashboxCode = String(env[`${envPrefix}_CASHBOX_CODE`] || '').trim();
  const login = String(env[`${envPrefix}_LOGIN`] || '').trim();
  const password = String(env[`${envPrefix}_PASSWORD`] || '').trim();
  const missing = [];
  if (!cashboxCode) missing.push(`${envPrefix}_CASHBOX_CODE`);
  if (!login) missing.push(`${envPrefix}_LOGIN`);
  if (!password) missing.push(`${envPrefix}_PASSWORD`);
  return {
    key,
    cashboxCode,
    login,
    password,
    baseUrl: String(env[`${envPrefix}_BASE_URL`] || 'https://admin.mob-cash.com').trim().replace(/\/+$/, ''),
    missing,
  };
}

function isMobcashEnabledFor(bookmakerKey, env = process.env) {
  const key = String(bookmakerKey || '').trim().toLowerCase();
  return env.MOBCASH_ENABLED === '1' && parseBookmakers(env).includes(key) &&
    getBookmakerConfig(key, env).missing.length === 0;
}

function warnIncompleteMobcashBookmakers(env = process.env, logger = console) {
  if (env.MOBCASH_ENABLED !== '1') return;
  for (const key of parseBookmakers(env)) {
    const { missing } = getBookmakerConfig(key, env);
    if (missing.length) {
      logger.warn?.(`[Mob-Cash] ${key}: missing ${missing.join(', ')}`);
    }
  }
}

module.exports = {
  parseBookmakers,
  getBookmakerConfig,
  isMobcashEnabledFor,
  warnIncompleteMobcashBookmakers,
};

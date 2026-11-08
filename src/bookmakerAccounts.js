const { getBookmakerConfig } = require('./mobcashConfig');
const { getMobcashClient, MobcashApiError } = require('./mobcash');

class BookmakerAccountCheckConfigError extends Error {
  constructor() {
    super('Проверка аккаунта 1xBet не настроена.');
    this.name = 'BookmakerAccountCheckConfigError';
  }
}

async function verifyBookmakerAccount(bookmaker, playerId, context = {}) {
  const key = String(bookmaker || '').trim().toLowerCase();
  if (key !== '1xbet') return { exists: null, nickname: null };

  const bookmakerConfig = getBookmakerConfig(key);
  if (bookmakerConfig.missing.length || !Number.isFinite(Number(bookmakerConfig.cashboxCode))) {
    throw new BookmakerAccountCheckConfigError();
  }

  // A successful lookup is enough. Some valid accounts do not return a nickname/FIO.
  const account = await getMobcashClient(key).checkAccount(String(playerId), {
    ...context,
    bookmaker: key,
    payerId: String(playerId),
  });
  return { exists: true, nickname: account.nickname || null };
}

function isBookmakerAccountNotFound(error) {
  if (!(error instanceof MobcashApiError) || error.operation !== 'payerNickname') return false;
  const details = `${error.code || ''} ${error.apiMessage || ''} ${error.message || ''}`;
  return /not\s*found|does\s*not\s*exist|unknown\s*(account|payer)|аккаунт.*не\s*найден|игрок.*не\s*найден/i.test(details);
}

module.exports = {
  verifyBookmakerAccount,
  isBookmakerAccountNotFound,
  BookmakerAccountCheckConfigError,
};

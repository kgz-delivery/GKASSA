const PROVIDERS = {
  qr_bank: { id: 'qr_bank', kind: 'bank_qr', label: 'QR BANK' },
  trc20: { id: 'trc20', kind: 'crypto', label: 'TRC-20' },
  bep20: { id: 'bep20', kind: 'crypto', label: 'BEP-20' },
  ton: { id: 'ton', kind: 'crypto', label: 'TON' },
};

const LEGACY_BANK_PROVIDERS = ['mbank', 'elqr', 'bakai'];
const BANK_PROVIDERS = ['qr_bank'];
const CRYPTO_PROVIDERS = ['trc20', 'bep20', 'ton'];
const SITE_PROVIDERS = ['melbet', '1xbet', '1win', 'mostbet'];

const SITE_LABELS = {
  melbet: 'Melbet',
  '1xbet': '1X BET',
  '1win': '1WIN',
  mostbet: 'MOSTBET',
};

function getSiteLabel(id) {
  return SITE_LABELS[id] || id || '—';
}

function getProvider(id) {
  if (LEGACY_BANK_PROVIDERS.includes(id)) return PROVIDERS.qr_bank;
  return PROVIDERS[id] || null;
}

function providerLabel(id) {
  return getProvider(id)?.label || id || '—';
}

module.exports = {
  PROVIDERS,
  BANK_PROVIDERS,
  CRYPTO_PROVIDERS,
  SITE_PROVIDERS,
  SITE_LABELS,
  LEGACY_BANK_PROVIDERS,
  getProvider,
  providerLabel,
  getSiteLabel,
};

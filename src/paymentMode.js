const config = require('./config');
const { BotSettings } = require('./models');

const PAYMENT_MODE_KEY = 'payment_mode';

function getPaymentMode() {
  if (config.paymentAutomation.autoConfirmMaxSom <= 0) return 'manual';
  return BotSettings.get(PAYMENT_MODE_KEY, 'auto') === 'manual' ? 'manual' : 'auto';
}

function isAutoPaymentEnabled() {
  return config.paymentAutomation.autoConfirmMaxSom > 0 && getPaymentMode() === 'auto';
}

function setPaymentMode(mode) {
  if (!['auto', 'manual'].includes(mode)) throw new TypeError('Invalid payment mode');
  BotSettings.set(PAYMENT_MODE_KEY, mode);
}

module.exports = { getPaymentMode, isAutoPaymentEnabled, setPaymentMode };

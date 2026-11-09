function parseTopupAmount(input) {
  const raw = String(input || '').trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw)) return null;
  const [wholePart, fractionPart = ''] = raw.replace(',', '.').split('.');
  const whole = wholePart.replace(/^0+(?=\d)/, '');
  const fraction = fractionPart.padEnd(2, '0');
  const cents = BigInt(whole) * 100n + BigInt(fraction || '0');
  if (cents < 1000n || cents > 1_000_000n) return null;
  const trimmedFraction = fractionPart.replace(/0+$/, '');
  return {
    cents,
    amount: Number(cents) / 100,
    amountText: trimmedFraction ? `${whole}.${trimmedFraction}` : whole,
  };
}

function isWholeTopupAmountInput(input) {
  return /^\d+$/.test(String(input || '').trim());
}

module.exports = { parseTopupAmount, isWholeTopupAmountInput };

async function recoverSendingMobcashOrders({ orders, formatBookmaker = (key) => key, logger = console }) {
  const pending = orders.getSendingForRecovery();
  let recovered = 0;
  for (const order of pending) {
    if (!orders.markSendingUnknown(order.transaction_id)) continue;
    recovered += 1;
    const bookmaker = order.bookmaker || order.site || '';
    logger.info?.('[Mob-Cash] Recovered interrupted order', JSON.stringify({
      transaction_id: order.transaction_id,
      bookmaker: formatBookmaker(bookmaker),
      payerId: String(order.payment_id || order.payer_id || ''),
      amount: order.amount_text || order.amount,
      state: 'unknown',
    }));
  }
  return recovered;
}

module.exports = { recoverSendingMobcashOrders };

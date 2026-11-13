// Money is integer cents. GST is 10% and is calculated and rounded per line,
// half away from zero, so a line's tax never changes when other lines are
// added. Amounts are tax exclusive (the Xero default), or tax inclusive when
// the lab's prices include GST (`inclusive`): then a line's amount holds its
// GST (one eleventh), and the total is the sum of the lines.

export const GST_RATE_BASIS_POINTS = 1000;

function roundHalfAwayFromZero(numerator, denominator) {
  const sign = Math.sign(numerator);
  const abs = Math.abs(numerator);
  return sign * Math.floor((abs * 2 + denominator) / (denominator * 2));
}

export function lineTotals({ quantity, unitAmountCents, taxCode, inclusive = false }) {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new TypeError('quantity must be a positive whole number');
  }
  if (!Number.isSafeInteger(unitAmountCents)) {
    throw new TypeError('unitAmountCents must be whole cents');
  }
  if (taxCode !== 'GST' && taxCode !== 'GST_FREE') {
    throw new TypeError(`unknown tax code: ${taxCode}`);
  }
  const lineAmountCents = quantity * unitAmountCents;
  let taxCents = 0;
  if (taxCode === 'GST') {
    taxCents = inclusive
      ? roundHalfAwayFromZero(lineAmountCents * GST_RATE_BASIS_POINTS, 10_000 + GST_RATE_BASIS_POINTS)
      : roundHalfAwayFromZero(lineAmountCents * GST_RATE_BASIS_POINTS, 10_000);
  }
  return { lineAmountCents, taxCents };
}

// Inclusive: the subtotal is the lines less their GST, as Xero shows it.
export function invoiceTotals(lines, { inclusive = false } = {}) {
  let amountCents = 0;
  let taxCents = 0;
  for (const line of lines) {
    amountCents += line.lineAmountCents;
    taxCents += line.taxCents;
  }
  return inclusive
    ? { subtotalCents: amountCents - taxCents, taxCents, totalCents: amountCents }
    : { subtotalCents: amountCents, taxCents, totalCents: amountCents + taxCents };
}

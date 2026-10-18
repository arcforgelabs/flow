// Money is integer cents. GST is 10% and is calculated and rounded per line,
// half away from zero, on tax-exclusive amounts (the Xero default), so a
// line's tax never changes when other lines are added.

export const GST_RATE_BASIS_POINTS = 1000;

function roundHalfAwayFromZero(numerator, denominator) {
  const sign = Math.sign(numerator);
  const abs = Math.abs(numerator);
  return sign * Math.floor((abs * 2 + denominator) / (denominator * 2));
}

export function lineTotals({ quantity, unitAmountCents, taxCode }) {
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
  const taxCents = taxCode === 'GST'
    ? roundHalfAwayFromZero(lineAmountCents * GST_RATE_BASIS_POINTS, 10_000)
    : 0;
  return { lineAmountCents, taxCents };
}

export function invoiceTotals(lines) {
  let subtotalCents = 0;
  let taxCents = 0;
  for (const line of lines) {
    subtotalCents += line.lineAmountCents;
    taxCents += line.taxCents;
  }
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

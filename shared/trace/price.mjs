// Pool spot price. p = sqrtP^2 / 2^192 * 10^(dec0 - dec1) = token1 per token0. BigInt, 1e-6 precision.
// Returns USD per 1 unit of the stock token (USDG at par). Pure.
const Q192 = 1n << 192n;
export function priceToken1PerToken0(sqrtPriceX96, dec0, dec1) {
  const s = BigInt(sqrtPriceX96); if (s === 0n) return null;
  // scaled by 1e6 * 10^dec0 / 10^dec1 using BigInt only
  let num = s * s * 1_000_000n, den = Q192;
  if (dec0 >= dec1) num *= 10n ** BigInt(dec0 - dec1); else den *= 10n ** BigInt(dec1 - dec0);
  return Number(num / den) / 1e6;
}
// USDG price of the stock token: if USDG is token0, stock price = 1 / (token1 per token0)
export function stockUsd(sqrtPriceX96, stockAddr, usdgAddr, stockDec = 18, usdgDec = 6) {
  const s = stockAddr.toLowerCase(), u = usdgAddr.toLowerCase(), stockIsToken0 = BigInt(s) < BigInt(u);
  if (stockIsToken0) { const p = priceToken1PerToken0(sqrtPriceX96, stockDec, usdgDec); return p; }
  // USDG is token0: p = stock per USDG; invert with more precision than 1e-6
  const s2 = BigInt(sqrtPriceX96); if (s2 === 0n) return null;
  // stock-per-usdg = s^2/2^192 * 10^(usdgDec - stockDec); usd per stock = inverse
  const numInv = Q192 * 10n ** BigInt(Math.max(0, stockDec - usdgDec)) * 1_000_000n; // scaled 1e6
  const denInv = s2 * s2 * 10n ** BigInt(Math.max(0, usdgDec - stockDec));
  return Number(numInv / denInv) / 1e6;
}
export const toUsd = (amountNum, price) => (price == null ? null : amountNum * price);

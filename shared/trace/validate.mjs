// Input classification + 400-level errors (pure).
import { isAddr, isTx, norm } from '../format.mjs';
import { HOURS_ALLOWED } from './windows.mjs';

export class ApiError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; this.extra = extra; } }
export const MSG = {
  invalid_input: 'Paste a Robinhood Chain address (0x + 40 hex) or a transaction hash (0x + 64 hex).',
  too_old: 'v0.1 address mode covers 7 days. Paste the theft transaction for older cases.',
  tx_not_found: 'Not found on Robinhood Chain. If it was just sent, wait a minute.',
};
export function parseInput(input, { hours, role } = {}) {
  const v = typeof input === 'string' ? input.trim() : '';
  if (isTx(v)) return { kind: 'tx', value: norm(v), hours: null };
  if (!isAddr(v)) throw new ApiError(400, 'invalid_input', MSG.invalid_input);
  let h = hours == null ? 24 : Number(hours);
  if (!Number.isFinite(h) || h <= 0) throw new ApiError(400, 'invalid_input', MSG.invalid_input);
  if (h > 168) throw new ApiError(400, 'too_old', MSG.too_old);
  if (!HOURS_ALLOWED.includes(h)) h = HOURS_ALLOWED.find((x) => x >= h);
  if (role != null && role !== 'thief' && role !== 'victim') throw new ApiError(400, 'invalid_input', MSG.invalid_input);
  return { kind: role === 'victim' ? 'victim' : 'address', value: norm(v), hours: h };
}
// what is a non-wallet? token contracts, pools, routers, the registry -> 400 not_a_wallet
export function notWalletReason(addr, ctx) {
  const a = norm(addr);
  if (ctx.tokenBySym.has(a)) return `This is the ${ctx.tokenBySym.get(a)} token contract, not a wallet.`;
  if (a === ctx.usdg) return 'This is the USDG token contract, not a wallet.';
  if (ctx.poolSet.has(a)) return 'This is a Uniswap pool, not a wallet.';
  if (ctx.knownByAddr.has(a)) return `This is the ${ctx.knownByAddr.get(a)} contract, not a wallet.`;
  return null;
}

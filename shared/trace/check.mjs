// Approval check: which spenders can still move the victim's official tokens? Read-only (allowance reads); revoking is done by the user's own wallet.
import { SEL, TOPIC_APPROVAL, topicAddr, addrFromTopic, addr32, encodeAllowance, decodeUint } from '../abi.mjs';
import { PRIO } from '../rpc/lane.mjs';
import { planWindows, hoursToBlocks } from './windows.mjs';
import { unitsToNumber } from '../format.mjs';

export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
export const SEL_PERMIT2_ALLOWANCE = '0x927da105'; // allowance(address owner,address token,address spender) -> (uint160 amount,uint48 expiration,uint48 nonce)
export const SEL_APPROVE = '0x095ea7b3', SEL_PERMIT2_APPROVE = '0x87517c45'; // approve(address,uint256) / Permit2 approve(address token,address spender,uint160,uint48)
const UNLIMITED = 1n << 255n;
const w = (n) => BigInt(n).toString(16).padStart(64, '0');
export const revokeTx = (row) => row.via === 'permit2'
  ? { to: PERMIT2, data: SEL_PERMIT2_APPROVE + addr32(row.token) + addr32(row.spender) + w(0) + w(0) }
  : { to: row.token, data: SEL_APPROVE + addr32(row.spender) + w(0) };

// view: a case view (graph). Spenders = tx.from / tx.to of every tx in which the owner's official tokens left (<= 6 txs), minus the owner itself.
export async function spendersFromCase(chain, view, owner, { prio = PRIO.interactive, maxTx = 6 } = {}) {
  const txs = [...new Set(view.edges.filter((e) => e.from === owner).map((e) => e.tx))].slice(0, maxTx);
  if (view.seed.kind === 'tx' && !txs.includes(view.seed.value)) txs.unshift(view.seed.value);
  const sp = new Set();
  for (const h of txs) { const t = await chain.tx(h, { prio }); for (const a of [t?.from, t?.to]) if (a && a.toLowerCase() !== owner) sp.add(a.toLowerCase()); }
  const tokens = new Set(view.edges.filter((e) => e.from === owner).map((e) => e.token));
  return { spenders: [...sp], tokens: [...tokens], txs };
}
// Approval events the owner emitted in the last `hours` (default 24): spenders unknown without a case
export async function spendersFromApprovals(chain, ctx, owner, head, { hours = 24, prio = PRIO.interactive } = {}) {
  const sp = new Set(), tokens = new Set();
  for (const [a, b] of planWindows(Math.max(0, head - hoursToBlocks(hours)), head)) {
    const logs = await chain.getLogs({ address: ctx.freezable, topics: [TOPIC_APPROVAL, topicAddr(owner)], fromBlock: a, toBlock: b }, { prio });
    for (const l of logs) if (l.topics?.length === 3) { if (addrFromTopic(l.topics[2]) !== owner) sp.add(addrFromTopic(l.topics[2])); tokens.add(l.address.toLowerCase()); }
  }
  return { spenders: [...sp], tokens: [...tokens], txs: [] };
}
export async function readAllowances(chain, ctx, owner, spenders, tokens, { prio = PRIO.interactive } = {}) {
  tokens = [...new Set([...tokens.filter((t) => ctx.tokens.has(t)), ctx.usdg])];
  const targets = [...new Set([...spenders, PERMIT2])];
  const calls = [], meta = [];
  for (const t of tokens) for (const s of targets) { calls.push({ target: t, callData: encodeAllowance(owner, s) }); meta.push({ token: t, spender: s, via: 'erc20' }); }
  for (const t of tokens) for (const s of spenders) { calls.push({ target: PERMIT2, callData: SEL_PERMIT2_ALLOWANCE + addr32(owner) + addr32(t) + addr32(s) }); meta.push({ token: t, spender: s, via: 'permit2' }); }
  const res = calls.length ? await chain.multicall(calls, { prio, ttl: 10 }) : [];
  const rows = [], now = Math.floor(Date.now() / 1000);
  res.forEach((r, i) => {
    if (!r.success) return; const m = meta[i], info = ctx.tokens.get(m.token);
    let amt, exp = null;
    if (m.via === 'permit2') { const d = r.returnData.replace(/^0x/, ''); amt = BigInt('0x' + (d.slice(0, 64) || '0')); exp = Number(BigInt('0x' + (d.slice(64, 128) || '0'))); if (exp && exp < now) return; } else amt = decodeUint(r.returnData);
    if (amt === 0n) return;
    rows.push({ ...m, symbol: info.symbol, allowanceRaw: amt.toString(), allowance: unitsToNumber(amt > UNLIMITED ? UNLIMITED : amt, info.decimals), unlimited: amt >= UNLIMITED || amt >= (1n << 159n), ...(exp ? { expiresAt: exp } : {}), spenderLabel: m.spender === PERMIT2 ? 'Permit2' : ctx.knownByAddr.get(m.spender) || null, revoke: revokeTx({ ...m }) });
  });
  return rows.sort((a, b) => Number(b.unlimited) - Number(a.unlimited));
}
// view optional (case). Returns {owner, spenders[], txs[], source, checkedAt}
export async function checkAddress(chain, ctx, owner, { view = null, head = null, prio } = {}) {
  let src;
  if (view && view.seed.victim === owner || (view && view.edges.some((e) => e.from === owner))) src = { ...(await spendersFromCase(chain, view, owner, { prio })), source: 'case' };
  else { head ??= await chain.head({ prio }); src = { ...(await spendersFromApprovals(chain, ctx, owner, head, { prio })), source: 'approvals-24h' }; }
  const rows = await readAllowances(chain, ctx, owner, src.spenders, src.tokens, { prio });
  return { owner, source: src.source, candidates: src.spenders, txs: src.txs, spenders: rows, checkedAt: Math.floor(Date.now() / 1000) };
}

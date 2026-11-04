// Freeze-request pack: three plain-text blocks (Robinhood, Paxos, police summary). Pure. No invented data: every line comes from the graph or is a labelled placeholder.
import { COPY } from './copy.mjs';
import { fmtUsd, fmtDateTime, shortAddr, fmtAmount } from './format.mjs';

export const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com';
export const HONESTY = 'Frostwit does not freeze, move or return anything. Robinhood and Paxos decide what happens to an address, and they usually need a police report or a legal directive.';
const tx = (h) => `${BLOCKSCOUT}/tx/${h}`, addr = (a) => `${BLOCKSCOUT}/address/${a}`;
const usd = (x) => (x == null ? 'n/a' : fmtUsd(x));
const when = (t, approx) => (t ? fmtDateTime(t) + (approx ? ' (approx.)' : '') : 'time n/a');

function status(row, events = {}) {
  const parts = [];
  if (row.blocked) parts.push('blocked in Robinhood access registry' + (row.blockedTx ? ` (${tx(row.blockedTx)})` : ''));
  if (row.frozen) parts.push('frozen by Paxos (USDG isFrozen)');
  if (row.paused) parts.push('token paused');
  return parts.length ? parts.join('; ') : 'not blocked or frozen at the time of the check';
}

// opts: { caseId, caseUrl, graph, generatedAt }  -> { variant, robinhood, paxos, police, markdown }
const NOACC = COPY.noAccusation;
function recvLine(seed) {
  const list = (seed.kind === 'address' ? seed.thieves : seed.firstReceivers ?? seed.thieves) || [];
  const label = seed.kind === 'address' ? 'Address pasted by the case opener as the thief\'s' : 'Addresses that first received value from the transaction reported by the case opener';
  return `${label}: ${list.length ? list.map(addr).join(', ') : 'none found'}`;
}
export function buildPack({ caseId, caseUrl, graph, generatedAt, watermark = false }) {
  const p = buildPack0({ caseId, caseUrl, graph, generatedAt });
  if (!watermark) return p;
  const W = 'EXAMPLE — not a report. This is a staging demonstration on an ordinary transaction.';
  return { ...p, robinhood: W + '\n\n' + p.robinhood, paxos: W + '\n\n' + p.paxos, police: W + '\n\n' + p.police, markdown: '> ' + W + '\n\n' + p.markdown, watermark: W };
}
function buildPack0({ caseId, caseUrl, graph, generatedAt }) {
  if (!graph) return buildTemplate();
  const rows = graph.freezable || [];
  const rh = rows.filter((r) => r.issuer === 'robinhood'), px = rows.filter((r) => r.issuer === 'paxos');
  const seedTx = graph.seed.kind === 'tx' ? graph.seed.value : null;
  const asOf = graph.freezable?.[0]?.checkedAt ?? generatedAt;
  const blockN = graph.freezable?.[0]?.checkedBlock ?? graph.head;
  const allBlocked = rows.length > 0 && rows.every((r) => r.blocked || r.frozen);
  const anyBlocked = rows.some((r) => r.blocked);
  const head = [
    `Case: ${caseUrl}`,
    seedTx ? `Transaction reported as the theft by the case opener: ${tx(seedTx)}` : graph.seed.kind === 'address' ? `Traced from address: ${addr(graph.seed.value)} (last ${graph.seed.hours || 24} h window starting at block ${graph.seed.block})` : `Traced from the sender's address: ${addr(graph.seed.value)}`,
    `Chain: Robinhood Chain mainnet (chain id 4663)`,
  ];
  const table = (list) => list.length ? list.map((r) => `- ${addr(r.holder)} holds ${fmtAmount(r.amountRaw, r.issuer === 'paxos' ? 6 : 18).replace(/\.\d+$/, (m) => m)} ${r.symbol} (token ${BLOCKSCOUT}/token/${r.token}), ≈ ${usd(r.usd)} (pool spot), ${status(r)}`) : [];

  // ---- Robinhood ----
  const rhL = ['To: support@robinhood.com (also via https://robinhood.com/contact)', `Subject: Review request: Robinhood stock tokens at addresses linked to a drain on Robinhood Chain (case ${caseId})`, '', 'Hello,', '', NOACC, '',
    'I am a victim of a drain on Robinhood Chain. I traced where the value went using public chain data.', '', ...head, ''];
  if (rh.length) {
    rhL.push(`Official Robinhood stock tokens currently held by the addresses below (checked ${when(asOf)}, block ${blockN}):`, ...table(rh), '');
    rhL.push(anyBlocked && rh.every((r) => r.blocked)
      ? 'These addresses are already blocked in the access registry. I request that you review the balances held there.'
      : 'I request that you review these addresses under your terms.');
  } else rhL.push(`At the time of the check (${when(asOf)}) the traced addresses held no official Robinhood stock token. The trail and the transactions are in the case file above.`);
  rhL.push('I understand you may require a police report or a legal directive. I will provide the report number once it is filed.', '', 'Thank you.');

  // ---- Paxos ----
  const pxL = ['To: https://support.paxos.com (Paxos, issuer of USDG)', `Subject: Notice: USDG at addresses linked to a drain on Robinhood Chain (case ${caseId})`, '', 'Hello,', '', NOACC, '',
    'I understand that Paxos acts on USDG only on a formal legal directive (court order, regulator or law enforcement). This message is to put you on notice of the addresses below; it is not a demand.', '', ...head, ''];
  if (px.length) {
    pxL.push(`USDG currently held by the addresses below (checked ${when(asOf)}, block ${blockN}):`, ...table(px), '');
    if (px.some((r) => r.frozen)) pxL.push('At least one of these addresses already shows as frozen (isFrozen). I request review of the balance.', '');
  } else pxL.push(`At the time of the check (${when(asOf)}) the traced addresses held no USDG.`, '');
  pxL.push('I will provide the police report number and any legal directive once I have them.', '', 'Thank you.');

  // ---- Police summary ----
  const poL = ['Summary for a police report (public chain data, Robinhood Chain, chain id 4663)', '', NOACC, '', ...head, '', `Victim address: ${graph.seed.victim ? addr(graph.seed.victim) : 'not determined (address-mode case)'}`,
    recvLine(graph.seed), '', 'Timeline (UTC):'];
  const edges = [...(graph.edges || [])].filter((e) => e.kind !== 'exit').sort((a, b) => a.block - b.block);
  if (!edges.length) poL.push('- no stock-token or USDG transfers found');
  for (const e of edges) poL.push(`- ${when(e.time, e.timeApprox)}: ${fmtAmount(e.amountRaw, e.token && e.symbol === 'USDG' ? 6 : 18)} ${e.symbol || 'token'} (≈ ${usd(e.usd)}) ${e.kind === 'swap' ? `swapped${e.via ? ' via ' + e.via : ''}` : 'sent'} from ${shortAddr(e.from)} to ${shortAddr(e.to)}, tx ${tx(e.tx)}`);
  poL.push('', 'Current locations:');
  if (!rows.length) poL.push('- no official stock-token or USDG balance found at the traced addresses at the time of the check');
  for (const r of rows) poL.push(`- ${addr(r.holder)}: ${fmtAmount(r.amountRaw, r.issuer === 'paxos' ? 6 : 18)} ${r.symbol} ≈ ${usd(r.usd)} (pool spot); ${status(r)}`);
  const exits = (graph.exits || []).filter((e) => ['eth', 'other-token', 'lookalike', 'contract'].includes(e.kind));
  if (exits.length) { poL.push('', 'Value that left the traced token set:'); for (const e of exits.slice(0, 12)) poL.push(`- ${e.kind}: ${e.note}${e.tx ? ` (tx ${tx(e.tx)})` : ''}`); }
  poL.push('', 'Value that left as native ETH is not traced by this tool.', `Trace status: ${graph.status}${graph.budget?.truncated ? ` (stopped: ${graph.budget.reason})` : ''}.`);

  const variant = rows.length === 0 ? 'empty' : allBlocked ? 'blocked' : 'open';
  return assemble(variant, rhL, pxL, poL, caseUrl);
}

function assemble(variant, rhL, pxL, poL, caseUrl) {
  const foot = 'Generated by frostwit.pro from public chain data. Not legal advice.';
  const robinhood = rhL.join('\n'), paxos = pxL.join('\n'), police = poL.join('\n');
  const markdown = ['# Freeze-request pack', '', `> ${HONESTY}`, caseUrl ? `> Case: ${caseUrl}` : '', '', '## To Robinhood', '', fence(robinhood), '', '## To Paxos (USDG)', '', fence(paxos), '', '## Summary for your police report', '', fence(police), '', `*${foot}*`, ''].join('\n');
  return { variant, robinhood, paxos, police, markdown, honesty: HONESTY, footer: foot };
}
const fence = (s) => '```text\n' + s + '\n```';

// Template with field labels only (no addresses, no amounts): shown on the landing "Request" sheet and when no case exists.
export function buildTemplate() {
  const f = (l) => `<${l}>`;
  const head = [`Case: ${f('case page link')}`, `Transaction reported as the theft by the case opener: ${f('transaction link')}`, 'Chain: Robinhood Chain mainnet (chain id 4663)'];
  const rhL = ['To: support@robinhood.com (also via https://robinhood.com/contact)', `Subject: Review request: Robinhood stock tokens at addresses linked to a drain on Robinhood Chain (case ${f('case id')})`, '', 'Hello,', '', NOACC, '', 'I am a victim of a drain on Robinhood Chain. I traced where the value went using public chain data.', '', ...head, '',
    `Official Robinhood stock tokens currently held by the addresses below (checked ${f('time UTC')}, block ${f('block')}):`, `- ${f('holder address')} holds ${f('amount')} ${f('token symbol')}, ≈ ${f('USD')} (pool spot), ${f('registry status')}`, '', 'I request that you review these addresses under your terms.', 'I understand you may require a police report or a legal directive. I will provide the report number once it is filed.', '', 'Thank you.'];
  const pxL = ['To: https://support.paxos.com (Paxos, issuer of USDG)', `Subject: Notice: USDG at addresses linked to a drain on Robinhood Chain (case ${f('case id')})`, '', 'Hello,', '', NOACC, '', 'I understand that Paxos acts on USDG only on a formal legal directive (court order, regulator or law enforcement). This message is to put you on notice of the addresses below; it is not a demand.', '', ...head, '',
    `USDG currently held by the addresses below (checked ${f('time UTC')}, block ${f('block')}):`, `- ${f('holder address')} holds ${f('amount')} USDG, ≈ ${f('USD')}, ${f('frozen status')}`, '', 'I will provide the police report number and any legal directive once I have them.', '', 'Thank you.'];
  const poL = ['Summary for a police report (public chain data, Robinhood Chain, chain id 4663)', '', NOACC, '', ...head, '', `Victim address: ${f('your address')}`, `Addresses that first received value from the transaction reported by the case opener: ${f('addresses')}`, '', 'Timeline (UTC):', `- ${f('time')}: ${f('amount')} ${f('token')} sent from ${f('from')} to ${f('to')}, tx ${f('transaction link')}`, '', 'Current locations:', `- ${f('address')}: ${f('amount')} ${f('token')} ≈ ${f('USD')}; ${f('status')}`, '', 'Value that left as native ETH is not traced by this tool.'];
  return assemble('template', rhL, pxL, poL, null);
}

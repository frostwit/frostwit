// Pure HTML-string renderers shared by SSR (server/src/pages) and the browser (case.js polling). Same function = same bytes.
import { esc, shortAddr, fmtUsd, fmtDateTime, fmtTime, fmtAmount } from '../../../shared/format.mjs';
import { LINKS, COPY } from '../../../shared/copy.mjs';

const tokDec = (sym) => (sym === 'USDG' ? 6 : 18);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: Number(n) >= 1000 ? 2 : 6 }));
export const a = (addr, text) => `<a class="fw-addr" href="${LINKS.address(addr)}" rel="noopener" target="_blank" title="${esc(addr)}">${esc(text ?? shortAddr(addr))}</a>`;
export const txl = (h, text) => (h ? `<a class="fw-txl" href="${LINKS.tx(h)}" rel="noopener" target="_blank" title="${esc(h)}">${esc(text ?? shortAddr(h))}</a>` : '—');
const usdTxt = (u) => (u == null ? '—' : '≈ ' + fmtUsd(u));
const poolLabel = '≈ USD (pool spot)';

export function chips(row, issuerEvents) {
  const out = [];
  if (row.blocked) out.push(`<span class="fw-chip fw-chip--blocked">${row.blockedTx ? `<a href="${LINKS.tx(row.blockedTx)}" rel="noopener" target="_blank">blocked by Robinhood registry</a>` : 'blocked by Robinhood registry'}</span>`);
  if (row.frozen) out.push('<span class="fw-chip fw-chip--frozen">frozen by Paxos</span>');
  if (row.paused) out.push('<span class="fw-chip fw-chip--paused">token paused</span>');
  if (!row.blocked && !row.frozen) out.push('<span class="fw-chip fw-chip--open">open</span>');
  return out.join(' ');
}
export function stampOf(v) {
  const q = v.queue || {};
  if (v.status === 'error') return { cls: 'amber', text: v.error === 'tx_not_found' ? 'NOT FOUND' : 'TRACE FAILED' };
  if (!v.rpcOk && v.rpcOk !== undefined) return { cls: 'amber', text: 'RPC DOWN — cached' };
  if (q.pausedSec > 0 && (v.status === 'queued' || v.status === 'tracing')) return { cls: 'amber', text: `RPC PAUSED — rate limit, resumes in ${q.pausedSec} s` };
  if (v.status === 'queued') return { cls: 'cold', text: `QUEUED #${q.position || 1} · ~${q.etaSec ?? 0} s` };
  if (v.status === 'tracing') return { cls: 'cold', text: 'TRACING' };
  if (v.status === 'partial') return { cls: 'amber', text: 'PARTIAL — budget' };
  return { cls: 'cobalt', text: 'DONE' };
}
export function statusBlock(v, nowSec) {
  const s = stampOf(v);
  const last = v.lastCheckAt ? `last checked ${fmtTime(v.lastCheckAt)}${v.watch?.until && v.watch.until > nowSec ? ` · next in ${Math.max(0, Math.round(((v.lastCheckAt + v.watch.cadenceMin * 60) - nowSec) / 60))} min` : ''}` : '';
  const live = v.status === 'tracing' || v.status === 'queued';
  return `<div class="fw-status" data-status="${esc(v.status)}"><span class="fw-stamp fw-stamp--${s.cls}">${esc(s.text)}</span>${last ? `<span class="fw-label">${esc(last)}</span>` : ''}${live && v.budget?.rpcCalls ? `<span class="fw-label">${v.budget.rpcCalls} RPC calls so far</span>` : ''}${v.status === 'partial' && v.budget?.reason ? `<span class="fw-label">stopped: ${esc(v.budget.reason)}</span>` : ''}</div>`;
}
export function seedLine(v) {
  const s = v.seed || {};
  if (s.kind === 'tx') return `<p class="fw-seed"><span class="fw-label">SEED TX</span> ${txl(s.value, s.value.slice(0, 10) + '…' + s.value.slice(-6))} <span class="fw-label">BLOCK</span> <span class="fw-mono">${esc(String(s.block).replace(/\B(?=(\d{3})+$)/g, ' '))}</span>${s.time ? ` <span class="fw-label">AT</span> ${esc(fmtDateTime(s.time))}${s.timeApprox ? ' (approx.)' : ''}` : ''}</p>`;
  if (s.kind === 'victim') return `<p class="fw-seed"><span class="fw-label">YOUR ADDRESS</span> ${a(s.value)} <span class="fw-label">WINDOW</span> <span class="fw-mono">${v.input?.hours || 24} h</span></p>`;
  return `<p class="fw-seed"><span class="fw-label">TRACING</span> ${a(s.value)} — address pasted by the case opener as the thief's <span class="fw-label">WINDOW</span> <span class="fw-mono">${v.input?.hours || 24} h</span> · Your own wallet? <button type="button" class="fw-linkbtn" data-trace-victim="${esc(s.value)}">Switch to “my address”</button>.</p>`;
}

// rows: freezable rows (live or as-of); asOfNote when reconstructed
export function freezablePanel(rows, { status, asOfNote, nodes = [] } = {}) {
  if (!rows.length) {
    const empty = status === 'done' || status === 'partial';
    return `<section class="fw-sheet fw-freezable" aria-labelledby="fw-fz-h"><h2 id="fw-fz-h" class="fw-h2">Freezable now</h2>${empty ? `<p>Nothing freezable: this transaction moved ETH or tokens no issuer controls, or the value already left the traced addresses. ${esc(COPY.limitEth)} See the exits below and <a href="/what-to-do">what to do in the first hour</a>.</p>` : '<p class="fw-muted">Waiting for the trace…</p>'}</section>`;
  }
  const blockedAll = rows.every((r) => r.blocked || r.frozen);
  const body = rows.map((r) => `<tr><td data-l="Holder">${a(r.holder)}</td><td data-l="Token"><a href="${LINKS.token(r.token, r.holder)}" rel="noopener" target="_blank" title="${r.amountRawUi ? 'balanceOf ' + esc(fmtAmount(r.amountRaw, tokDec(r.symbol))) : esc(r.token)}">${esc(r.symbol)}</a></td><td data-l="Amount" class="fw-num">${num(r.amount)}</td><td data-l="${poolLabel}" class="fw-num">${usdTxt(r.usd)}</td><td data-l="Issuer">${r.issuer === 'paxos' ? 'Paxos' : 'Robinhood'}</td><td data-l="Status">${chips(r)}</td></tr>`).join('');
  return `<section class="fw-sheet fw-freezable" aria-labelledby="fw-fz-h"><h2 id="fw-fz-h" class="fw-h2">Freezable now</h2>
<div class="fw-tblwrap"><table class="fw-table"><thead><tr><th>Holder</th><th>Token</th><th>Amount</th><th>${poolLabel}</th><th>Issuer</th><th>Status</th></tr></thead><tbody>${body}</tbody></table></div>
${blockedAll ? "<p class=\"fw-note\">Already blocked by Robinhood's registry: the balance cannot move; what happens to it is the issuer's decision.</p>" : ''}
${asOfNote ? `<p class="fw-note">${esc(asOfNote)}</p>` : `<p class="fw-note">Checked ${esc(fmtTime(rows[0].checkedAt))} at block ${esc(String(rows[0].checkedBlock))}. USD figures are ${poolLabel.toLowerCase()}, not an execution price.</p>`}</section>`;
}

export function hopTable(v, upToBlock) {
  const edges = (v.edges || []).filter((e) => upToBlock == null || e.block <= upToBlock).sort((x, y) => x.block - y.block || (x.logIndex ?? 0) - (y.logIndex ?? 0));
  if (!edges.length) return '<p class="fw-muted">No hops yet.</p>';
  const rows = edges.map((e, i) => {
    const kind = e.kind === 'swap' ? `swapped${e.via ? ' via ' + esc(e.via) : ''}${e.swapTo?.length ? ' → ' + e.swapTo.map((s) => esc(num(s.amount)) + ' ' + esc(s.symbol || 'token')).join(', ') : ''}` : e.kind === 'contract' ? 'into a contract (not followed)' : 'transfer';
    return `<tr tabindex="0" data-block="${e.block}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"><td data-l="#" class="fw-num">${i + 1}</td><td data-l="Time">${e.time ? esc(fmtDateTime(e.time)) + (e.timeApprox ? ' ≈' : '') : '—'}</td><td data-l="From">${a(e.from)}</td><td data-l="To">${a(e.to)}</td><td data-l="Amount" class="fw-num">${txl(e.tx, num(e.amount) + ' ' + (e.symbol || 'token'))}</td><td data-l="${poolLabel}" class="fw-num">${usdTxt(e.usd)}</td><td data-l="Hop">${kind}</td></tr>`;
  }).join('');
  return `<div class="fw-tblwrap"><table class="fw-table fw-hops"><thead><tr><th>#</th><th>Time (UTC)</th><th>From</th><th>To</th><th>Amount (tx)</th><th>${poolLabel}</th><th>Hop</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

const EXIT_LABEL = { eth: 'ETH', 'other-token': 'Other token', lookalike: 'FAKE token', contract: 'Contract', depth: 'Depth limit', fanout: 'Fan-out', dust: 'Dust', horizon: 'Horizon' };
export function exitsList(v) {
  const ex = v.exits || [];
  if (!ex.length) return '';
  const nodeBy = new Map((v.nodes || []).map((n) => [n.address, n]));
  const items = ex.map((e) => {
    const cont = nodeBy.get(e.from)?.unfinished || e.kind === 'depth' || e.kind === 'fanout' ? `<button type="button" class="fw-btn fw-btn--sm" data-continue="${esc(e.kind === 'depth' ? e.from : e.from)}">Continue from this address</button>` : '';
    return `<li class="fw-exit fw-exit--${esc(e.kind)}"><span class="fw-chip fw-chip--amber">${esc(EXIT_LABEL[e.kind] || e.kind)}</span> ${a(e.from)} — ${esc(e.note)}${e.tx ? ' · ' + txl(e.tx, 'tx') : ''} ${cont}</li>`;
  }).join('');
  return `<section class="fw-sheet fw-exits" aria-labelledby="fw-ex-h"><h2 id="fw-ex-h" class="fw-h2">Not freezable: where it left</h2><p>${esc(COPY.notFreezable)} ${esc(COPY.limitEth)}</p><ul class="fw-list">${items}</ul></section>`;
}
export function changeLog(v) {
  const rows = (v.checks || []).filter((c) => c.diff && c.diff.length);
  if (!rows.length) return `<section class="fw-sheet fw-log" aria-labelledby="fw-log-h"><h2 id="fw-log-h" class="fw-h2">Change log</h2><p class="fw-muted">No change since the trace. ${esc(COPY.recheck)}</p></section>`;
  return `<section class="fw-sheet fw-log" aria-labelledby="fw-log-h"><h2 id="fw-log-h" class="fw-h2">Change log</h2><ul class="fw-list">${rows.map((c) => c.diff.map((d) => `<li><span class="fw-label">${esc(fmtDateTime(c.at))}</span> ${esc(d.text)}${d.tx ? ' · ' + txl(d.tx, 'tx') : ''}</li>`).join('')).join('')}</ul></section>`;
}
export function candidatesPanel(v) {
  const c = v.candidates || [];
  if (!c.length) return `<section class="fw-sheet" aria-labelledby="fw-cand-h"><h2 id="fw-cand-h" class="fw-h2">Candidates</h2><p>No outgoing stock-token or USDG transfers in this window. If the drain was ETH or another token, Frostwit cannot see it.</p></section>`;
  return `<section class="fw-sheet fw-cands" aria-labelledby="fw-cand-h"><h2 id="fw-cand-h" class="fw-h2">Candidates</h2><p>Candidates — the one you did not authorise is the thief. Frostwit does not know which one it is. Pick the transfer you did not sign.</p>
<div class="fw-tblwrap"><table class="fw-table"><thead><tr><th>Time (UTC)</th><th>Receiver</th><th>Amount (tx)</th><th>${poolLabel}</th><th></th></tr></thead><tbody>${c.map((x) => `<tr><td data-l="Time">${x.time ? esc(fmtDateTime(x.time)) : '—'}</td><td data-l="Receiver">${a(x.receiver)}</td><td data-l="Amount" class="fw-num">${txl(x.tx, num(x.amount) + ' ' + x.symbol)}</td><td data-l="${poolLabel}" class="fw-num">${usdTxt(x.usd)}</td><td><button type="button" class="fw-btn fw-btn--sm" data-trace-tx="${esc(x.tx)}">Trace this one</button></td></tr>`).join('')}</tbody></table></div>${v.candidatesTotal > c.length ? `<p class="fw-note">Showing ${c.length} of ${v.candidatesTotal}, largest first.</p>` : ''}</section>`;
}

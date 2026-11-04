import { layout, esc, jsonScript, wrap } from './layout.mjs';
import { statusBlock, seedLine, freezablePanel, hopTable, exitsList, changeLog, candidatesPanel, a, txl, chips } from '../../../web/src/pages/render.mjs';
import { COPY, LINKS } from '../../../shared/copy.mjs';
import { buildPack, buildTemplate } from '../../../shared/pack.mjs';
import { fmtDate, fmtDateTime, fmtInt, shortAddr } from '../../../shared/format.mjs';
import { docsPage } from './docs.mjs';
import { tokenPage } from './token.mjs';

const nowSec = () => Math.floor(Date.now() / 1000);
const H1 = (label, text) => `<p class="fw-label">${esc(label)}</p><h1 class="fw-h1">${esc(text)}</h1>`;

const pctx0 = (ctx, id) => (ctx.posterReady ? `<link rel="preload" href="/img/case/${id}.png" as="image" fetchpriority="high">` : '');
// ---------- /case/:id ----------
export function casePage(ctx, v) {
  const id = v.id, victim = v.input.kind === 'victim';
  const banner = v.rpcOk === false ? `<p class="fw-banner" role="status">Robinhood Chain RPC is not reachable. Showing the last stored result${v.lastCheckAt ? ' from ' + esc(fmtDateTime(v.lastCheckAt)) : ''}; re-checks are paused.</p>` : '';
  const poster = ctx.posterReady ? `<img class="fw-scene__poster" src="/img/case/${id}.png" alt="The trail drawn as crystals and strings: each hop of the traced value, from the first address on the left to where it sits now." width="1200" height="630">` : '';
  const fz = victim ? candidatesPanel(v) : freezablePanel(v.freezable, { status: v.status });
  const actions = victim ? '' : `<section class="fw-sheet fw-actions" aria-labelledby="fw-act-h"><h2 id="fw-act-h" class="fw-h2">Freeze-request pack</h2><p>Written for you: one text for Robinhood (stock tokens), one for Paxos (USDG), one summary for your police report. ${esc(COPY.honesty)}</p><p><a class="fw-btn" href="/case/${id}/pack">Open the pack</a> <a class="fw-btn fw-btn--ghost" href="/api/case/${id}">JSON</a>${v.seed.victim ? ` <a class="fw-btn fw-btn--ghost" href="/check/${v.seed.victim}?case=${id}">Check approvals (read-only; revoke from your own wallet)</a>` : ''}</p></section>`;
  const priority = ctx.token().launched ? `<section class="fw-sheet fw-priority" id="fw-priority" aria-labelledby="fw-pr-h"><h2 id="fw-pr-h" class="fw-h2">Priority watch</h2><p>$FWIT holders can put a case on priority watch: re-checked every 2 minutes for 30 days, and re-traced on demand. Holding at least ${fmtInt(ctx.token().minHold)} $FWIT is required; no signature is needed.</p><form class="fw-inline" data-priority="${id}"><input class="fw-field" name="holder" placeholder="0x… holder address" autocomplete="off" spellcheck="false" aria-label="Holder address"><button class="fw-btn" type="submit">Verify and watch</button> <button class="fw-btn fw-btn--ghost" type="button" data-retrace="${id}">Retrace now</button></form><p class="fw-note" data-priority-out>${v.watch.priority ? 'Priority watch is on: re-checked every 2 minutes.' : ''}</p></section>` : '';
  const body = wrap(`
<header class="fw-casehead">${H1('CASE NO.', id)}<div id="fw-status">${statusBlock(v, nowSec())}</div>${seedLine(v)}${banner}</header>
${victim ? '' : `<section class="fw-casescene" aria-label="The trail"><div id="fw-scene" class="fw-case__scene">${poster}</div><div id="fw-rail" class="fw-case__rail"></div></section>`}
<div id="fw-fz">${fz}</div>
<p class="fw-note fw-noacc">${esc(COPY.noAccusation)}</p>
${victim ? '' : `<section class="fw-sheet" aria-labelledby="fw-hops-h"><h2 id="fw-hops-h" class="fw-h2">The trail, hop by hop</h2><p class="fw-note" id="fw-hops-note">${esc(COPY.limitEth)} Every amount links to its transaction on Blockscout.</p><div id="fw-hops">${hopTable(v)}</div></section>
<div id="fw-exits">${exitsList(v)}</div><div id="fw-log">${changeLog(v)}</div>${actions}${priority}`}
<p class="fw-note">${esc(COPY.honesty)} ${esc(COPY.limitsLine)} ${esc(COPY.notAudited)}</p>
${jsonScript('fw-case', v)}`, 'fw-case');
  const hops = Math.max(0, v.edges.length), usd = v.freezable.reduce((s, r) => s + (r.blocked || r.frozen ? 0 : r.usd || 0), 0);
  const desc = victim ? 'Where the stock tokens and USDG left this wallet, on Robinhood Chain.' : `${hops} hops traced on Robinhood Chain; ≈ ${Math.round(usd).toLocaleString('en-US')} USD in official stock tokens and USDG sits at addresses the issuer can still act on (pool spot). Frostwit cannot freeze anything itself.`;
  return layout(ctx, { title: `Case ${id}`, desc, path: `/case/${id}`, og: `/og/case/${id}.png`, body, scripts: ['/dist/pages.js'], noindex: false, bodyClass: 'fw-page fw-pg-case', head: pctx0(ctx, id) });
}

// ---------- /case/:id/pack ----------
export function packPage(ctx, v) {
  const pack = buildPack({ caseId: v.id, caseUrl: v.links.page, graph: v.status === 'queued' || v.status === 'error' ? null : v, generatedAt: nowSec(), watermark: ctx.cfg.staging });
  const blk = (id, h, to, text) => `<section class="fw-sheet fw-pack" aria-labelledby="${id}-h"><h2 id="${id}-h" class="fw-h2">${esc(h)}</h2><p class="fw-note">${to}</p><pre class="fw-packtext" id="${id}" tabindex="0">${esc(text)}</pre><p><button class="fw-btn" type="button" data-copy-target="${id}">Copy</button></p></section>`;
  const variantNote = pack.variant === 'blocked' ? '<p class="fw-note">Every address in this case is already blocked or frozen. The texts below ask for a review of the balances.</p>' : pack.variant === 'empty' ? '<p class="fw-note">No official stock-token or USDG balance was found at the traced addresses at the last check. The texts say so.</p>' : '';
  const body = wrap(`<header class="fw-casehead">${H1('FREEZE-REQUEST PACK', 'Case ' + v.id)}<p class="fw-honesty">${esc(pack.honesty)}</p><p><a class="fw-btn" href="/api/case/${v.id}/pack.md" download="frostwit-${v.id}.md">Download .md</a> <a class="fw-btn fw-btn--ghost" href="/case/${v.id}">Back to the case</a></p>${variantNote}</header>
${blk('pk-rh', 'To Robinhood', `Send to <a href="mailto:${COPY.contacts.robinhood.email}">${COPY.contacts.robinhood.email}</a> or via <a href="${COPY.contacts.robinhood.url}" rel="noopener" target="_blank">robinhood.com/contact</a>. Stock tokens only.`, pack.robinhood)}
${blk('pk-px', 'To Paxos (USDG)', `Send via <a href="${COPY.contacts.paxos.url}" rel="noopener" target="_blank">support.paxos.com</a>. ${esc(COPY.paxosRule)}`, pack.paxos)}
${blk('pk-po', 'Summary for your police report', 'Plain timeline of the transactions, addresses and amounts. Add the report number to the other two texts once you have it.', pack.police)}
<p class="fw-note">${esc(pack.footer)} ${esc(COPY.limitsLine)}</p>`, 'fw-packpage');
  return layout(ctx, { title: `Pack for case ${v.id}`, desc: 'The freeze-request pack for this case: a text for Robinhood, a text for Paxos and a summary for the police report.', path: `/case/${v.id}/pack`, body, noindex: true, bodyClass: 'fw-page fw-pg-pack' });
}
export function packMarkdown(ctx, v) { return buildPack({ caseId: v.id, caseUrl: v.links.page, graph: v.status === 'queued' || v.status === 'error' ? null : v, generatedAt: nowSec(), watermark: ctx.cfg.staging }).markdown; }

// ---------- /issuer-actions ----------
export function actionsPage(ctx, data, stats, { all = false } = {}) {
  const ev = data.events, bt = data.batch; const inBatch = (e) => bt && e.kind === 'blocked' && e.block >= bt.fromBlock && e.block <= bt.toBlock;
  const batchEv = ev.filter(inBatch), recent = ev.filter((e) => !inBatch(e));
  const row = (e) => `<tr><td data-l="Time (UTC)">${e.time ? esc(fmtDateTime(e.time)) : '—'}</td><td data-l="Action"><span class="fw-stamp fw-stamp--${e.kind === 'blocked' ? 'cobalt' : 'amber'}">${e.kind === 'blocked' ? 'Blocked' : 'Unblocked'}</span></td><td data-l="Address"><a class="fw-addr" href="/status/${e.address}" title="${esc(e.address)}">${esc(shortAddr(e.address))}</a></td><td data-l="Operator">${e.operator ? a(e.operator) : '—'}</td><td data-l="Block" class="fw-num">${fmtInt(e.block)}</td><td data-l="Transaction">${txl(e.tx, 'tx')}</td></tr>`;
  const table = (rows) => `<div class="fw-tblwrap"><table class="fw-table"><thead><tr><th>Time (UTC)</th><th>Action</th><th>Address</th><th>Operator</th><th>Block</th><th>Transaction</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`;
  const batchText = bt ? `First batch: ${bt.count} Blocked events, ${bt.addresses} addresses, blocks ${fmtInt(bt.fromBlock)}–${fmtInt(bt.toBlock)}, ${fmtDateTime(bt.fromTime)} to ${fmtDateTime(bt.toTime)}` : '';
  const preBlock = bt && !all ? `<section class="fw-sheet fw-pre"><p><span class="fw-label">FIRST BATCH</span> ${esc(batchText)}. <a href="/issuer-actions?all=1">Show all ${bt.count}</a> or read the <a href="/api/issuer-actions?limit=500">JSON</a>.</p></section>` : bt ? `<details open class="fw-sheet fw-pre"><summary><span class="fw-label">FIRST BATCH</span> ${esc(batchText)}.</summary>${table(batchEv)}</details>` : '';
  const body = wrap(`<header class="fw-casehead">${H1('ISSUER ACTIONS', "Every Blocked / Unblocked event of Robinhood's registry")}
<p>${esc(COPY.issuerOnly)} These are issuer actions, not accusations: the addresses below are not described as anything else. ${esc(COPY.limitUsdg)}</p>
<dl class="fw-kv"><div><dt class="fw-label">BLOCKED NOW</dt><dd class="fw-data">${fmtInt(stats.blockedNow)}</dd></div><div><dt class="fw-label">EVENTS TOTAL</dt><dd class="fw-data">${fmtInt(stats.eventsTotal)}</dd></div><div><dt class="fw-label">LAST ACTION</dt><dd class="fw-data">${stats.lastActionAt ? esc(fmtDateTime(stats.lastActionAt)) : '—'}</dd></div></dl>
${data.backfillDone ? '' : '<p class="fw-banner">Indexing registry events…</p>'}</header>
<section class="fw-sheet" aria-labelledby="fw-ia-h"><h2 id="fw-ia-h" class="fw-h2">Newest first</h2>${table(recent)}<p class="fw-note">Each row links its transaction on Blockscout and the address's own status page. Data: the registry ${a(ctx.ctx.registry, 'contract')} event logs, read from the official RPC. <a href="/api/issuer-actions">JSON</a></p></section>${preBlock}
<p class="fw-note">Blocked / Unblocked are events of the access registry that Robinhood's stock tokens consult. USDG (Paxos) works differently: <code>isFrozen</code> is a live flag per address and its history is not indexed here.</p>`, 'fw-actionspage');
  return layout(ctx, { title: 'Issuer actions', desc: "Every Blocked and Unblocked event of Robinhood's access registry on Robinhood Chain, with transaction links.", path: '/issuer-actions', body, bodyClass: 'fw-page fw-pg-actions' });
}

// ---------- /status/:address ----------
export function statusPage(ctx, s) {
  const chipOf = (flag, onT, offT, unk) => (flag === null ? `<span class="fw-chip fw-chip--muted">${unk}</span>` : flag ? `<span class="fw-chip fw-chip--blocked">${onT}</span>` : `<span class="fw-chip fw-chip--open">${offT}</span>`);
  const evs = s.events.length ? `<div class="fw-tblwrap"><table class="fw-table"><thead><tr><th>Time (UTC)</th><th>Action</th><th>Operator</th><th>Block</th><th>Transaction</th></tr></thead><tbody>${s.events.map((e) => `<tr><td data-l="Time (UTC)">${e.time ? esc(fmtDateTime(e.time)) : '—'}</td><td data-l="Action"><span class="fw-stamp fw-stamp--${e.kind === 'blocked' ? 'cobalt' : 'amber'}">${e.kind === 'blocked' ? 'Blocked' : 'Unblocked'}</span></td><td data-l="Operator">${e.operator ? a(e.operator) : '—'}</td><td data-l="Block" class="fw-num">${fmtInt(e.block)}</td><td data-l="Transaction">${txl(e.tx, 'tx')}</td></tr>`).join('')}</tbody></table></div>` : '<p>The registry has no Blocked or Unblocked event for this address.</p>';
  const body = wrap(`<header class="fw-casehead">${H1('ADDRESS STATUS', shortAddr(s.address))}<p class="fw-mono fw-break">${esc(s.address)}</p>
<p>${s.live ? `Checked ${esc(fmtDateTime(s.checkedAt))}.` : 'The live check is not available right now (RPC unreachable); the registry events below come from the stored index.'}</p></header>
<section class="fw-sheet" aria-labelledby="fw-st-h"><h2 id="fw-st-h" class="fw-h2">Right now</h2>
<dl class="fw-kv"><div><dt class="fw-label">ROBINHOOD REGISTRY (isBlocked)</dt><dd>${chipOf(s.blocked, 'blocked by Robinhood registry', 'not blocked', 'unknown')}</dd></div>
<div><dt class="fw-label">PAXOS USDG (isFrozen)</dt><dd>${chipOf(s.frozen, 'frozen by Paxos', 'not frozen', 'unknown')}</dd></div></dl>
<p class="fw-note">Live flag only; Paxos freeze history is not indexed in this version.</p></section>
<section class="fw-sheet" aria-labelledby="fw-sev-h"><h2 id="fw-sev-h" class="fw-h2">Registry history of this address</h2>${evs}</section>
<section class="fw-sheet"><p><button class="fw-btn" type="button" data-trace-address="${esc(s.address)}">Trace from this address</button> <a class="fw-btn fw-btn--ghost" href="${LINKS.address(s.address)}" rel="noopener" target="_blank">Blockscout</a> <a class="fw-btn fw-btn--ghost" href="/api/status/${s.address}">JSON</a></p>
<p class="fw-note">Tracing reads the last 24 hours for official stock-token and USDG transfers into this address. A registry action on its own says nothing about why the issuer acted.</p></section>`, 'fw-statuspage');
  return layout(ctx, { title: `Status ${shortAddr(s.address)}`, desc: 'Is this address blocked by Robinhood\'s registry or frozen by Paxos? Live flags and the registry history of this address on Robinhood Chain.', path: `/status/${s.address}`, body, bodyClass: 'fw-page fw-pg-status' });
}

// ---------- /check (form) ----------
export function checkIndexPage(ctx) {
  const body = wrap(`<header class="fw-casehead">${H1('APPROVAL CHECK', 'Which approval did the drainer use?')}<p>Paste your own wallet address. Frostwit lists the spenders that still hold an allowance on your official stock tokens and USDG, including through Permit2. It is read-only: revoking sends <code>approve(spender, 0)</code> from your own wallet, and Frostwit never signs. ${esc(COPY.honesty)}</p></header>
<section class="fw-sheet"><form class="fw-inline" data-check-form><input class="fw-field" name="address" placeholder="0x… your wallet address" autocomplete="off" spellcheck="false" aria-label="Your wallet address"><button class="fw-btn" type="submit">Check approvals</button></form><p class="fw-note" data-check-err></p></section>`, 'fw-checkpage');
  return layout(ctx, { title: 'Approval check', desc: 'Which spenders still hold an allowance on your wallet, with a revoke from your own wallet. Read-only.', path: '/check', body, bodyClass: 'fw-page fw-pg-check' });
}
// ---------- /check/:address ----------
export function checkPage(ctx, owner, caseId) {
  const body = wrap(`<header class="fw-casehead">${H1('APPROVAL CHECK', shortAddr(owner))}<p class="fw-mono fw-break">${esc(owner)}</p>
<p>Which approval did the drainer use? This lists the spenders that can still move your official stock tokens and USDG, including through Permit2. Revoking is done from your own wallet: Frostwit never holds a key and never signs. ${esc(COPY.honesty)}</p></header>
<section class="fw-sheet" id="fw-check" data-check="${owner}" data-case="${esc(/^[0-9a-f]{12}$/.test(caseId || '') ? caseId : '')}" aria-live="polite"><h2 class="fw-h2">Allowances right now</h2><p class="fw-muted" data-check-out>Checking…</p><div data-check-list></div></section>
<section class="fw-sheet"><h2 class="fw-h2">Revoke</h2><p>The button asks your wallet to send <code>approve(spender, 0)</code> on Robinhood Chain (chain id 4663) from the address above. Check the address in your wallet before you confirm. Gas is paid in ETH. ${caseId ? `<a href="/case/${esc(caseId)}">Back to the case</a>.` : ''}</p>
<p><button class="fw-btn" type="button" data-wallet-connect>Connect wallet</button> <span class="fw-note" data-wallet-out></span></p></section>
<p class="fw-note">With a case, spenders come from the senders and receivers of the transactions in which your tokens left. Without a case, Frostwit reads the approvals this address emitted in the last 24 hours. An allowance that is not listed here is zero for the spenders checked; it does not prove no other approval exists.</p>`, 'fw-checkpage');
  return layout(ctx, { title: `Approval check ${shortAddr(owner)}`, desc: 'Which spenders still hold an allowance on this address, and a one-click revoke from your own wallet.', path: `/check/${owner}`, body, noindex: true, bodyClass: 'fw-page fw-pg-check' });
}

// ---------- static pages ----------
const li = (items) => `<ol class="fw-steps">${items.map((x) => `<li>${x}</li>`).join('')}</ol>`;
export function whatToDoPage(ctx) {
  const body = wrap(`<header class="fw-casehead">${H1('THE FIRST HOUR', 'What to do after a drain, in order')}<p>Nothing here needs Frostwit. Do these first; trace in parallel.</p></header>
<section class="fw-sheet">${li([
    '<strong>Stop signing.</strong> Do not approve, connect or sign anything else with the drained wallet or the device it ran on until you know how it happened.',
    '<strong>Move what is left to a fresh wallet.</strong> Create the new wallet on a clean device, with a new seed phrase, then move remaining assets there. Native ETH for gas may be needed first.',
    '<strong>Save the evidence.</strong> Copy the transaction links of the theft (Blockscout), your address, the time and what you were doing. Take screenshots. Frostwit\'s case page and pack collect these for you.',
    '<strong>Do not pay recovery services.</strong> Anyone who contacts you offering to get funds back for a fee, or asks for your seed phrase, is part of the scam. Robinhood and Paxos never need your seed phrase.',
    '<strong>Report to the police</strong> and keep the report number. Robinhood and Paxos usually need a police report or a legal directive before they act on an address.',
    '<strong>Revoke approvals</strong> you gave to unknown contracts, from a wallet you control.'])}</section>
<section class="fw-sheet" id="approval" aria-labelledby="wd-ap"><h2 id="wd-ap" class="fw-h2">I signed something</h2><p>A signed approval or permit can let a contract move your tokens later. Stop using the wallet, move the remaining assets to a fresh wallet, then revoke the approval from a wallet you control (an explorer's approval checker or your wallet's own revoke tool). Then paste the theft transaction on the <a href="/">trace form</a>.</p></section>
<section class="fw-sheet" id="seed" aria-labelledby="wd-seed"><h2 id="wd-seed" class="fw-h2">My seed phrase leaked</h2><p>Treat the whole wallet as lost: anyone with the phrase can sign. Move what is left to a new wallet with a new phrase immediately, on a clean device. Do not reuse the phrase on any chain. Then trace the drain from the transaction.</p></section>
<section class="fw-sheet" id="scammer" aria-labelledby="wd-sc"><h2 id="wd-sc" class="fw-h2">I sent to a scammer</h2><p>Sending is final. Paste the transaction hash, or use “thief's address” mode with 24 hours, to see where the value is now and what the issuer could still act on. ${esc(COPY.honesty)}</p></section>
<section class="fw-sheet"><h2 class="fw-h2">Where to ask</h2><p>Robinhood: <a href="${COPY.contacts.robinhood.url}" rel="noopener" target="_blank">robinhood.com/contact</a> or <a href="mailto:${COPY.contacts.robinhood.email}">${COPY.contacts.robinhood.email}</a> (<a href="https://robinhood.com/us/en/support/articles/avoid-scams/" rel="noopener" target="_blank">avoid scams</a>). Paxos (USDG): <a href="${COPY.contacts.paxos.url}" rel="noopener" target="_blank">support.paxos.com</a>. ${esc(COPY.paxosRule)}</p><p>Which approval did the drainer use? <a href="/check">Check approvals</a> (read-only; revoke from your own wallet): it lists the spenders that still hold an allowance on your official tokens, including Permit2.</p></section>`, 'fw-wtd');
  return layout(ctx, { title: 'What to do after a drain', desc: 'The first hour after a drain on Robinhood Chain, in order: stop signing, move what is left, save the evidence, report, revoke approvals.', path: '/what-to-do', body, bodyClass: 'fw-page fw-pg-wtd' });
}
export function notFoundPage(ctx, what = 'No case here.') {
  return layout(ctx, { title: 'Not found', desc: 'Not found.', path: '/404', noindex: true, body: wrap(`<header class="fw-casehead">${H1('404', what)}<p><a class="fw-btn" href="/">Back to the trace form</a></p></header>`), bodyClass: 'fw-page fw-pg-404' });
}
export { docsPage, tokenPage };

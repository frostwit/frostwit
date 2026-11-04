// Client script for SSR pages (case, pack, status, actions...). No signing libraries, no third-party requests.
import { statusBlock, freezablePanel, hopTable, exitsList, changeLog, candidatesPanel, seedLine } from './render.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const jfetch = (u, o) => fetch(u, { cache: 'no-store', headers: { accept: 'application/json', 'content-type': 'application/json' }, ...o });

// ---- copy buttons ----
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy],[data-copy-target]'); if (!b) return;
  const text = b.dataset.copy ?? document.getElementById(b.dataset.copyTarget)?.textContent ?? '';
  try { await navigator.clipboard.writeText(text); } catch { const r = document.createRange(); const el = document.getElementById(b.dataset.copyTarget); if (el) { r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } }
  const old = b.textContent; b.textContent = 'Copied'; setTimeout(() => { b.textContent = old; }, 1400);
});

// ---- start a case from a button (continue / candidate / switch role / status page) ----
async function startCase(body, btn) {
  const old = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = 'Starting…'; }
  try {
    const r = await jfetch('/api/case', { method: 'POST', body: JSON.stringify(body) }); const j = await r.json();
    if (r.ok && j.id) { location.href = `/case/${j.id}`; return; }
    alert(j.message || 'Could not start the case.');
  } catch { alert('Network error. Try again.'); }
  if (btn) { btn.disabled = false; btn.textContent = old; }
}
document.addEventListener('click', (e) => {
  let b;
  if ((b = e.target.closest('[data-trace-address]'))) startCase({ input: b.dataset.traceAddress, hours: 24 }, b);
  else if ((b = e.target.closest('[data-trace-victim]'))) startCase({ input: b.dataset.traceVictim, hours: 24, role: 'victim' }, b);
  else if ((b = e.target.closest('[data-trace-tx]'))) startCase({ input: b.dataset.traceTx }, b);
  else if ((b = e.target.closest('[data-continue]'))) startCase({ input: b.dataset.continue, hours: 24 }, b);
});

// ---- priority watch (post-launch only: the form exists only when launched) ----
document.addEventListener('submit', async (e) => {
  const f = e.target.closest('[data-priority]'); if (!f) return; e.preventDefault();
  const out = $('[data-priority-out]', f.parentElement), holder = f.holder.value.trim();
  out.textContent = 'Checking…';
  try {
    const r = await jfetch(`/api/case/${f.dataset.priority}/priority`, { method: 'POST', body: JSON.stringify({ holder }) }); const j = await r.json();
    out.textContent = !r.ok ? j.message : !j.enabled ? 'Priority watch is off until $FWIT exists.' : j.holder ? 'Priority watch is on: re-checked every 2 minutes for 30 days.' : `That address holds less than the minimum. Priority watch needs ${Number(j.minHold || 0).toLocaleString('en-US')} $FWIT.`;
  } catch { out.textContent = 'Network error.'; }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-retrace]'); if (!b) return;
  const f = b.closest('form'), out = $('[data-priority-out]', f.parentElement); out.textContent = 'Checking…';
  try {
    const r = await jfetch(`/api/case/${b.dataset.retrace}/retrace`, { method: 'POST', body: JSON.stringify({ holder: f.holder.value.trim() }) }); const j = await r.json();
    if (r.ok && j.retrace) { out.textContent = 'Re-tracing from the seed…'; poll(); } else out.textContent = r.ok ? 'Retrace needs a holder of at least the minimum.' : j.message;
  } catch { out.textContent = 'Network error.'; }
});

// ---- case page ----
const dataEl = $('#fw-case');
let view = dataEl ? JSON.parse(dataEl.textContent) : null, scene = null, asOfBlock = null, timer = null;
const sceneData = () => ({ kind: 'graph', graph: view });
const nowSec = () => Math.floor(Date.now() / 1000);

function paint() {
  if (!view) return;
  $('#fw-status').innerHTML = statusBlock(view, nowSec());
  const victim = view.input.kind === 'victim';
  if (asOfBlock == null) $('#fw-fz').innerHTML = victim ? candidatesPanel(view) : freezablePanel(view.freezable, { status: view.status });
  if (victim) return;
  $('#fw-hops').innerHTML = hopTable(view, asOfBlock);
  $('#fw-exits').innerHTML = exitsList(view);
  $('#fw-log').innerHTML = changeLog(view);
  $('#fw-hops-note')?.classList.toggle('fw-hidden', false);
}
async function poll() {
  clearTimeout(timer);
  if (!view) return;
  try {
    const r = await jfetch(`/api/case/${view.id}`); if (r.ok) { view = await r.json(); paint(); scene?.update(sceneData()); }
  } catch { /* keep the last render */ }
  if (['queued', 'tracing'].includes(view.status)) timer = setTimeout(poll, 2000);
  else if (view.watch?.until > nowSec()) timer = setTimeout(poll, 60_000);
}
async function mountCase() {
  const el = $('#fw-scene'); if (!el || !view || view.input.kind === 'victim') return;
  try {
    const mod = await import('/dist/scene.js'); if (!mod.mountScene) return;
    scene = mod.mountScene(el, sceneData(), {
      poster: $('.fw-scene__poster', el)?.getAttribute('src'), interactive: true, pan: true, railEl: $('#fw-rail'),
      onContinue: (address) => startCase({ input: address, hours: 24 }),
      onScrub: (block, rows) => {
        const live = block == null || block >= (view.head ?? Infinity); asOfBlock = live ? null : block;
        $('#fw-hops').innerHTML = hopTable(view, asOfBlock);
        $('#fw-fz').innerHTML = live ? freezablePanel(view.freezable, { status: view.status }) : freezablePanel(rows || [], { status: view.status, asOfNote: 'Status flags (blocked/frozen) are current; balances are reconstructed from the hops.' });
      },
    });
  } catch { /* no scene bundle or no WebGL: the poster, tables and panel already work */ }
}
if (view) { mountCase(); if (['queued', 'tracing'].includes(view.status) || view.watch?.until > nowSec()) timer = setTimeout(poll, view.status === 'done' || view.status === 'partial' ? 60_000 : 1500); }

document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-check-form]'); if (!f) return; e.preventDefault();
  const v = f.address.value.trim(); if (!/^0x[0-9a-fA-F]{40}$/.test(v)) { $('[data-check-err]').textContent = 'Paste a Robinhood Chain address (0x + 40 hex).'; return; }
  location.href = '/check/' + v.toLowerCase();
});
// ---- /check: allowances + revoke from the user's own wallet (no signing libs; window.ethereum only) ----
const chk = $('#fw-check');
if (chk) {
  const owner = chk.dataset.check, cs = chk.dataset.case, out = $('[data-check-out]', chk), list = $('[data-check-list]', chk), wout = $('[data-wallet-out]');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let rows = [];
  const draw = () => {
    if (!rows.length) { list.innerHTML = '<p>No live allowance found for the spenders checked.</p>'; return; }
    list.innerHTML = `<div class="fw-tblwrap"><table class="fw-table"><thead><tr><th>Token</th><th>Spender</th><th>Allowance</th><th>Via</th><th></th></tr></thead><tbody>${rows.map((r, i) => `<tr><td data-l="Token">${esc(r.symbol)}</td><td data-l="Spender"><a class="fw-addr" href="https://robinhoodchain.blockscout.com/address/${r.spender}" rel="noopener" target="_blank">${esc(r.spenderLabel || r.spender)}</a></td><td data-l="Allowance" class="fw-num">${r.unlimited ? '<span class="fw-chip fw-chip--amber">unlimited</span>' : Number(r.allowance).toLocaleString('en-US', { maximumFractionDigits: 6 })}</td><td data-l="Via">${r.via === 'permit2' ? 'Permit2' : 'token approval'}</td><td><button class="fw-btn fw-btn--sm" type="button" data-revoke="${i}">Revoke</button></td></tr>`).join('')}</tbody></table></div>`;
  };
  const load = async () => {
    out.textContent = 'Checking…';
    try {
      const r = await jfetch(`/api/check/${owner}${cs ? '?case=' + cs : ''}`); const j = await r.json();
      if (!r.ok) { out.textContent = j.message || 'Check failed.'; return; }
      rows = j.spenders; out.textContent = `Checked ${new Date(j.checkedAt * 1000).toISOString().slice(11, 16)} UTC · ${j.candidates.length} spender${j.candidates.length === 1 ? '' : 's'} examined (${j.source === 'case' ? 'from the case transactions' : 'from your approvals of the last 24 h'}).`; draw();
    } catch { out.textContent = 'Network error.'; }
  };
  load();
  let account = null;
  const connect = async () => {
    if (!window.ethereum) { wout.textContent = 'No wallet found in this browser. Open this page in your wallet app browser.'; return false; }
    try {
      const [a] = await window.ethereum.request({ method: 'eth_requestAccounts' }); account = a.toLowerCase();
      try { await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x1237' }] }); } catch (e) { wout.textContent = 'Add Robinhood Chain (chain id 4663) to your wallet, then try again.'; return false; }
      wout.textContent = account === owner ? 'Connected as the checked address.' : `Connected as ${account.slice(0, 8)}…, not the checked address. Switch account before revoking.`;
      return account === owner;
    } catch { wout.textContent = 'Connection cancelled.'; return false; }
  };
  $('[data-wallet-connect]').addEventListener('click', connect);
  chk.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-revoke]'); if (!b) return;
    if (!(account === owner || await connect())) return;
    const r = rows[Number(b.dataset.revoke)];
    b.disabled = true; b.textContent = 'Confirm in wallet…';
    try {
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [{ from: account, to: r.revoke.to, data: r.revoke.data }] });
      wout.innerHTML = `Revoke sent: <a href="https://robinhoodchain.blockscout.com/tx/${hash}" rel="noopener" target="_blank">${hash.slice(0, 12)}…</a>. Re-checking in a few seconds.`;
      setTimeout(load, 6000);
    } catch (err) { b.disabled = false; b.textContent = 'Revoke'; wout.textContent = err?.code === 4001 ? 'Cancelled in the wallet.' : 'The wallet refused or the transaction failed.'; }
  });
}

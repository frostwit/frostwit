import { layout, esc, wrap, caSlot, buyUrl } from './layout.mjs';
import { COPY, LINKS } from '../../../shared/copy.mjs';

export function tokenPage(ctx) {
  const t = ctx.token(), live = caSlot(t);
  const utility = t.launched
    ? `<p>$FWIT holders can put a case on <strong>priority watch</strong>: re-checked every 2 minutes for 30 days instead of every 15 minutes for 7, and re-traced on demand. Holding at least ${Number(t.minHold).toLocaleString('en-US')} $FWIT is required. This is the only token utility. Tracing, the freeze-request pack and the API stay free and open to everyone.</p>`
    : `<p>Until $FWIT exists, priority watch is off. Once it does, holders of at least ${Number(t.minHold).toLocaleString('en-US')} $FWIT can put a case on priority watch: re-checked every 2 minutes for 30 days instead of every 15 minutes for 7, and re-traced on demand. That is the only token utility. Everything else is open to everyone.</p>`;
  const body = wrap(`<header class="fw-casehead"><p class="fw-label">TOKEN</p><h1 class="fw-h1">$FWIT</h1><p>Launch Thu 5 Nov 2026, 15:00 UTC.</p></header>
<section class="fw-sheet" aria-labelledby="tk-ca"><h2 id="tk-ca" class="fw-h2">Contract address</h2>${live ? `<p class="fw-ca fw-ca--page">${live}</p>` : '<p>$FWIT · CA at launch — only the address posted here and on @frostwitRH is real.</p>'}<p class="fw-note">The only official CA is the one on this page and on <a href="${esc(t.x)}" rel="noopener" target="_blank">@frostwitRH</a>.</p></section>
<section class="fw-sheet" aria-labelledby="tk-u"><h2 id="tk-u" class="fw-h2">What it does</h2>${utility}</section>
<section class="fw-sheet" aria-labelledby="tk-f"><h2 id="tk-f" class="fw-h2">Fees</h2><p>The launch platform's creator fee on $FWIT trades pays for the server, the domain and the data. It goes to the team wallet ${t.teamWallet ? `<a class="fw-addr" href="${LINKS.address(t.teamWallet)}" rel="noopener" target="_blank">${esc(t.teamWallet)}</a>` : ''}.</p></section>
<section class="fw-sheet" aria-labelledby="tk-r"><h2 id="tk-r" class="fw-h2">No promise of returns</h2><p><strong>No promise of returns.</strong> Priority watch is a convenience, not a yield. ${esc(COPY.notAudited)} The tracer has no contract of its own and never asks for a wallet or a signature; the only contract is the $FWIT token, whose address is posted here at launch. ${esc(COPY.honesty)}</p></section>`, 'fw-tokenpage');
  return layout(ctx, { title: '$FWIT', desc: 'The $FWIT token: what it does, the team wallet, the contract address, and what it does not promise.', path: '/token', body, bodyClass: 'fw-page fw-pg-token' });
}

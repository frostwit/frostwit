// Small pure helpers shared by server and browser.
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/, TX_RE = /^0x[0-9a-fA-F]{64}$/;
export const isAddr = (s) => typeof s === 'string' && ADDR_RE.test(s);
export const isTx = (s) => typeof s === 'string' && TX_RE.test(s);
export const norm = (s) => String(s).trim().toLowerCase();
export const shortAddr = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtDate = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : 'n/a');
export const fmtDateTime = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'n/a');
export const fmtTime = (t) => (t ? new Date(t * 1000).toISOString().slice(11, 16) + ' UTC' : 'n/a');
export function fmtUsd(x) {
  if (x == null || !Number.isFinite(+x)) return '—';
  x = +x;
  if (x >= 1e6) return '$' + (x / 1e6).toFixed(2) + 'M';
  if (x >= 1e4) return '$' + (x / 1e3).toFixed(1) + 'k';
  return '$' + x.toLocaleString('en-US', { maximumFractionDigits: x < 100 ? 2 : 0 });
}
// BigInt raw + decimals -> number (precision loss fine for display) and string with thousands separators, <= 6 decimals
export function unitsToNumber(raw, dec) { const r = BigInt(raw), d = 10n ** BigInt(dec); return Number(r / d) + Number(r % d) / Number(d); }
export function fmtAmount(raw, dec) {
  const r = BigInt(raw), d = 10n ** BigInt(dec), whole = r / d, frac = (r % d).toString().padStart(dec, '0').slice(0, 6).replace(/0+$/, '');
  return whole.toLocaleString('en-US') + (frac ? '.' + frac : '');
}
export const fmtInt = (x) => (x == null || !Number.isFinite(+x) ? 'n/a' : Math.round(+x).toLocaleString('en-US'));
export const ago = (sec) => (sec < 90 ? `${Math.round(sec)} s` : sec < 5400 ? `${Math.round(sec / 60)} min` : sec < 172800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} d`);

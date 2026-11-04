// Public sentences that must read the same on every surface (landing, docs, pack, llms.txt, API index). Claims table: BRIEF §1.
export const COPY = {
  honesty: 'Frostwit cannot freeze or recover anything. Robinhood and Paxos decide, and they usually need a police report or a legal directive.',
  paste: "Paste the theft transaction, or the thief's address.",
  limitEth: 'Native ETH is not traced in this version.',
  limitWindow: 'Address mode covers the last 24 hours by default, up to 7 days (slower, queued). For anything older, paste the theft transaction.',
  limitUsdg: 'Paxos freeze history is not indexed in this version; the live USDG flag is shown.',
  notFreezable: 'Not freezable: value that left as ETH, as other tokens, or into a contract. Frostwit says where it went and stops there.',
  recheck: 'Re-checked every 15 minutes for 7 days while the case is open. Changes are logged with the transaction that moved the value.',
  lane: "One shared lane to Robinhood's RPC: traces run one request at a time, every case shows its place in the queue.",
  noAccount: 'No account. No wallet to trace. Public JSON API, no key.',
  notAudited: 'Not audited. Read the limits before you trust a trace.',
  noReturns: 'No promise of returns. Priority watch is a convenience, not a yield.',
  issuerOnly: "Robinhood's registry decides; Frostwit only reads the events.",
  contacts: { robinhood: { url: 'https://robinhood.com/contact', email: 'support@robinhood.com' }, paxos: { url: 'https://support.paxos.com' } },
  paxosRule: 'Paxos freezes USDG only on a formal legal directive (court, regulator, law enforcement).',
  noAccusation: 'This is not an accusation. Addresses are listed because value moved through them on-chain; the case opener decides what to report.',
  limitsLine: 'Limits: native ETH is not traced; address mode covers 7 days; Paxos freeze history is not indexed.',
};
export const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com';
export const LINKS = { tx: (h) => `${BLOCKSCOUT}/tx/${h}`, address: (a) => `${BLOCKSCOUT}/address/${a}`, token: (a, holder) => `${BLOCKSCOUT}/token/${a}${holder ? '?holder=' + holder : ''}` };

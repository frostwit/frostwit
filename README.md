# Frostwit

Drained on Robinhood Chain? Paste the theft transaction (or the thief's address). Frostwit follows the stolen value on-chain, shows which part still sits in assets the issuer can freeze (official Robinhood stock tokens, USDG), re-checks it while the case is open, and writes the freeze-request pack for you. No wallet needed to trace.

Frostwit cannot freeze or recover anything. Robinhood and Paxos decide, and they usually need a police report or a legal directive.

- Site: https://frostwit.pro · API: `GET /api`, `/llms.txt` · X: @frostwitRH
- Native ETH is not traced in this version.
- Address mode covers the last 24 hours by default, up to 7 days (slower, queued). For anything older, paste the theft transaction.
- Paxos freeze history is not indexed in this version; the live USDG flag is shown.
- Not audited. No promise of returns.

## Run
`npm ci && npm run build && STATE_DIR=./state node server/src/index.mjs` (Node >= 20). Chain reads need the official RPC (`RPC_URL`, default https://rpc.mainnet.chain.robinhood.com), which is rate-limited: all reads go through one lane (1 in flight, 350 ms apart, 61 s pause on a rate error). `npm test` runs on recorded fixtures, no network.
Deploy: `./deploy.sh` (rsync, build on server, systemd, nginx, certbot). Launch: `./golive.sh <CA>`.

Test fixtures are recorded from Robinhood Chain with wallet addresses and tx hashes anonymised.

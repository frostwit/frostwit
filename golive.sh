#!/usr/bin/env bash
# Usage: ./golive.sh <CA>     Run locally. Writes web/token.json (ca, launched:true, launchedAt) and uploads ONLY that file.
# Env: NO_UPLOAD=1 write the local file only (dry run) · NO_PONS=1 skip the Pons check (tests) · HOST=us1 DOMAIN=frostwit.pro
# The server re-reads token.json every 60 s: the CA slot, the Buy link, /token and priority watch switch on.
set -euo pipefail
cd "$(dirname "$0")"
CA="${1:-}"
[[ "$CA" =~ ^0x[0-9a-fA-F]{40}$ ]] || { echo "usage: $0 0x<40 hex>"; exit 1; }
CA="$(echo "$CA" | tr 'A-F' 'a-f' | sed 's/^0X/0x/')"
HOST="${HOST:-us1}"; DOMAIN="${DOMAIN:-frostwit.pro}"
[ -f web/token.json ] || { echo "web/token.json missing"; exit 1; }
SYM="FWIT"
if [ -z "${NO_PONS:-}" ]; then
  BODY="$(timeout 30 curl -fsS -H 'user-agent: frostwit.pro/0.1 golive' "https://ponsfamily.com/api/launches/$CA")" || { echo "Pons does not know $CA"; exit 1; }
  SYM="$(printf '%s' "$BODY" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(String(JSON.parse(s).symbol||'')))")"
  [ -n "$SYM" ] || { echo "no symbol from Pons"; exit 1; }
fi
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node - "$CA" "$SYM" "$NOW" <<'JS'
const fs = require('fs'); const [ca, sym, now] = process.argv.slice(2);
const f = 'web/token.json', t = JSON.parse(fs.readFileSync(f, 'utf8'));
const same = t.launched === true && String(t.ca).toLowerCase() === ca.toLowerCase();
t.symbol = sym; t.ca = ca; t.launched = true; t.launchedAt = same && t.launchedAt ? t.launchedAt : now;
fs.writeFileSync(f, JSON.stringify(t, null, 2) + '\n');
JS
echo "token.json written:"; cat web/token.json
if [ -z "${NO_UPLOAD:-}" ]; then
  timeout 60 rsync -az -e 'ssh -o ConnectTimeout=15 -o BatchMode=yes' web/token.json "$HOST:/opt/frostwit/repo/web/token.json"
  for i in $(seq 1 16); do
    if timeout 20 curl -fsS "https://$DOMAIN/token.json?ts=$(date +%s)" | grep -qi "$CA"; then echo "token.json carries the CA: OK"; break; fi
    [ "$i" = 16 ] && { echo "WARNING: live token.json does not show the CA yet"; exit 1; }
    sleep 5
  done
  echo "waiting for the server to reload token.json (<= 60 s)..."
  for i in $(seq 1 16); do
    if timeout 20 curl -fsS "https://$DOMAIN/?ts=$(date +%s)" | grep -qi "$CA"; then echo "landing shows the CA: OK"; break; fi
    [ "$i" = 16 ] && { echo "WARNING: landing does not show the CA yet"; exit 1; }
    sleep 5
  done
fi
echo
echo "--- post text (copy) ---"
echo "CA is live: \$$SYM"
echo "$CA"
echo "The only official CA is the one on https://$DOMAIN and on @frostwitRH."
echo "(reminder: re-render web/og.jpg if it carries the CA; deploy.sh picks it up)"

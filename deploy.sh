#!/usr/bin/env bash
# Deploy Frostwit: rsync ONLY this repo dir -> us1:/opt/frostwit/repo -> npm ci + web build on the server -> systemd -> nginx -> certbot (first run).
# Env: SKIP_SMOKE=1 · SKIP_TESTS=1 · HOST=us1 PORT=4830 DOMAIN=frostwit.pro
set -euo pipefail
cd "$(dirname "$0")"
HOST="${HOST:-us1}"; PORT="${PORT:-4830}"; DOMAIN="${DOMAIN:-frostwit.pro}"
APP=/opt/frostwit
SSH="timeout 400 ssh -o ConnectTimeout=15 -o BatchMode=yes $HOST"
SSHO="ssh -o ConnectTimeout=15 -o BatchMode=yes"

# 1. tests
if [ -z "${SKIP_TESTS:-}" ]; then timeout 300 npm test >/dev/null 2>&1 || { echo "ABORT: tests fail (run npm test)"; exit 1; }; fi

# 2. token.json must be complete and consistent
node - <<'JS' || exit 1
const t = JSON.parse(require('fs').readFileSync('web/token.json', 'utf8'));
const bad = [];
if (!/^0x[0-9a-fA-F]{40}$/.test(t.teamWallet || '')) bad.push('teamWallet empty or invalid');
if (!(Number(t.minHold) > 0)) bad.push('minHold empty');
if (!t.launched && !/^0x0{40}$/.test(t.ca)) bad.push('launched:false but ca is set');
if (t.launched && /^0x0{40}$/.test(t.ca)) bad.push('launched:true but ca is zero');
if (bad.length) { console.error('ABORT: web/token.json: ' + bad.join('; ')); process.exit(1); }
JS

# 3. copy rules for user-facing files (no WIB, no soon/coming, no creator-tax mention)
if grep -rInE '\bWIB\b|\b(soon|coming)\b|creator tax' --include=*.mjs --include=*.js --include=*.html --include=*.css --include=*.json --include=*.txt \
     server/src shared web/src web/token.json README.md 2>/dev/null | grep -v '/test/' | grep -v 'deploy.sh'; then echo "ABORT: banned word in user-facing files (above)"; exit 1; fi

# 4. deploy files
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
for f in frostwit.service nginx-frostwit.conf nginx-bootstrap.conf frostwit-headers.conf frostwit-zones.conf; do sed -e "s/__PORT__/$PORT/g" -e "s/__DOMAIN__/$DOMAIN/g" "deploy/$f" > "$TMP/$f"; done

# 5. sync (only this directory; nothing from the parent project folder; never wallet files)
$SSH "mkdir -p $APP/repo $APP/state"
rsync -az --delete -e "$SSHO" --exclude .git --exclude node_modules --exclude state --exclude web/dist --exclude web/art/drafts --exclude fixtures \
  --exclude '*.log' --exclude '.env*' --exclude 'wallet*' --exclude 'WALLETS*' --exclude 'BUILD-LOG.md' ./ "$HOST:$APP/repo/"
scp -q -o ConnectTimeout=15 "$TMP"/* "$HOST:/tmp/"

# us1 has two certbot accounts, both used by other projects, and no default: pin one (override with CERTBOT_ACCOUNT)
CERTBOT_ACCOUNT="${CERTBOT_ACCOUNT:-0b694074a23b8015058d5ebe2d503be6}"
$SSH "DOMAIN=$DOMAIN PORT=$PORT CERTBOT_ACCOUNT=$CERTBOT_ACCOUNT bash -s" <<'REMOTE'
set -euo pipefail
APP=/opt/frostwit
if ! systemctl is-active --quiet frostwit && ss -ltnp | grep -q ":$PORT "; then echo "ABORT: port $PORT in use"; ss -ltnp | grep ":$PORT "; exit 1; fi
id frostwit >/dev/null 2>&1 || useradd --system --home-dir $APP --shell /usr/sbin/nologin frostwit
cd $APP/repo
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2
node scripts/build-web.mjs
chown -R frostwit:frostwit $APP/state; chmod -R a+rX $APP/repo
install -m 0644 /tmp/frostwit-headers.conf /etc/nginx/snippets/frostwit-headers.conf
install -m 0644 /tmp/frostwit-zones.conf /etc/nginx/conf.d/frostwit-zones.conf
if [ ! -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem ]; then
  echo "no certificate yet: bootstrap on port 80 + certbot"
  install -m 0644 /tmp/nginx-bootstrap.conf /etc/nginx/sites-available/frostwit
  ln -sf /etc/nginx/sites-available/frostwit /etc/nginx/sites-enabled/frostwit
  nginx -t && systemctl reload nginx
  certbot certonly --webroot -w /var/www/html -d $DOMAIN -d www.$DOMAIN --non-interactive --agree-tos --account "$CERTBOT_ACCOUNT"
fi
install -m 0644 /tmp/frostwit.service /etc/systemd/system/frostwit.service
systemctl daemon-reload; systemctl enable frostwit >/dev/null 2>&1; systemctl restart frostwit
install -m 0644 /tmp/nginx-frostwit.conf /etc/nginx/sites-available/frostwit
ln -sf /etc/nginx/sites-available/frostwit /etc/nginx/sites-enabled/frostwit
rm -f /tmp/frostwit* /tmp/nginx-frostwit.conf /tmp/nginx-bootstrap.conf
nginx -t && systemctl reload nginx
for i in $(seq 1 30); do curl -fsS "127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 2; done
systemctl is-active frostwit; curl -fsS "127.0.0.1:$PORT/api/health"; echo
REMOTE

# 6. smoke
if [ -z "${SKIP_SMOKE:-}" ]; then
  timeout 30 curl -fsS "https://$DOMAIN/api/health" >/dev/null && echo "health OK"
  timeout 30 curl -fsS "https://$DOMAIN/api/stats" && echo
  timeout 30 curl -fsS "https://$DOMAIN/token.json" >/dev/null && echo "token.json OK"
  timeout 30 curl -fsS -o /dev/null "https://$DOMAIN/dist/styles.css" && echo "assets OK"
fi
echo "deploy done -> https://$DOMAIN"

// Dev tool: full-page screenshots through Chrome DevTools with real device metrics (headless Chrome cannot go below 500 px wide otherwise).
// node scripts/shot.mjs <width> <outfile.png> <url>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const [w, out, url] = [+process.argv[2], process.argv[3], process.argv[4]];
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/gx-chrome-${port}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let tabs; for (let i = 0; i < 50; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.length) break; } catch {} await sleep(200); }
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d.result ?? { error: d.error }); pend.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send('Emulation.setDeviceMetricsOverride', { width: w, height: 900, deviceScaleFactor: 1, mobile: w < 600 });
await send('Page.enable'); await send('Page.navigate', { url }); await sleep(2500);
const m = await send('Page.getLayoutMetrics'); const h = Math.ceil(m.cssContentSize?.height || m.contentSize.height);
const over = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth', returnByValue: true });
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: Math.min(h, 6000), scale: 1 } });
if (!shot.data) { console.error(JSON.stringify(shot)); process.exit(1); }
fs.writeFileSync(out, Buffer.from(shot.data, 'base64')); console.log(out, 'scrollWidth', over.result.value, 'height', h);
ws.close(); proc.kill();

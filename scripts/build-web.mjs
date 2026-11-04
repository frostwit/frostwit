// Builds web/dist: LANDING's bundle (landing, scene, styles, fonts, art) + APP's pages.js and fallback page CSS.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'web/dist');
fs.mkdirSync(dist, { recursive: true });
const landing = path.join(root, 'web/src/landing/build.mjs');
if (fs.existsSync(landing)) await (await import(landing)).buildLanding({ root, dist });
// scene bundle for /case: mountScene (no three.js inside; it loads scene-gl.js on its own)
const sceneIdx = path.join(root, 'web/src/scene/index.mjs');
if (fs.existsSync(sceneIdx) && !fs.existsSync(path.join(dist, 'scene.js'))) await build({ entryPoints: [sceneIdx], outfile: path.join(dist, 'scene.js'), bundle: true, minify: true, format: 'esm', target: 'es2020', legalComments: 'none', logLevel: 'warning' });
await build({ entryPoints: [path.join(root, 'web/src/pages/pages.js')], outfile: path.join(dist, 'pages.js'), bundle: true, minify: true, format: 'esm', target: 'es2020', legalComments: 'none', logLevel: 'warning' });
// APP fallback CSS for page-level classes (case/pack/status/actions/docs). LANDING's styles.css wins on conflicts: it is loaded by the same <link> (merged after this file).
const base = path.join(root, 'web/src/pages/pages-base.css');
const sty = path.join(dist, 'styles.css');
if (fs.existsSync(base) && fs.existsSync(sty)) {
  const mine = await build({ entryPoints: [base], write: false, minify: true, logLevel: 'warning' });
  const cur = fs.readFileSync(sty, 'utf8');
  if (!cur.includes('/*fw-pages-base*/')) fs.writeFileSync(sty, '/*fw-pages-base*/' + mine.outputFiles[0].text + '\n' + cur);
}
console.log('web built:', fs.readdirSync(dist).join(' '));

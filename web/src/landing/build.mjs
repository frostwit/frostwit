// LANDING build step, called from scripts/build-web.mjs: `await (await import('../web/src/landing/build.mjs')).buildLanding({ root, dist })`.
// Writes into web/dist: index.html, landing.js, scene-gl.js, scene.js (mountScene for other pages, optional),
// styles.css, fonts/, vendor/three.module.min.js, art/ (no drafts), icons + manifest + 404.html + og.jpg (if rendered).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const THREE_URL = '/dist/vendor/three.module.min.js';
const threeExternal = { name: 'three-external', setup(b) { b.onResolve({ filter: /^three$/ }, () => ({ path: THREE_URL, external: true })); } };

export async function buildLanding({ root, dist, quiet = false }) {
  const at = (...p) => path.join(root, ...p);
  const out = (...p) => path.join(dist, ...p);
  for (const d of ['fonts', 'vendor', 'art']) fs.mkdirSync(out(d), { recursive: true });
  const common = { bundle: true, minify: true, format: 'esm', target: 'es2020', legalComments: 'none', logLevel: 'warning' };

  await build({ ...common, entryPoints: [at('web/src/landing/main.js')], outfile: out('landing.js') });
  await build({ ...common, entryPoints: [at('web/src/scene/gl.mjs')], outfile: out('scene-gl.js'), plugins: [threeExternal] });
  // mountScene as a standalone module for pages that do not bundle it themselves (APP may import web/src/scene/index.mjs instead)
  await build({ ...common, entryPoints: [at('web/src/scene/index.mjs')], outfile: out('scene.js') });
  fs.copyFileSync(at('web/vendor/three.module.min.js'), out('vendor/three.module.min.js'));

  const css = ['web/src/styles/tokens.css', 'web/src/styles/base.css', 'web/src/styles/scene.css', 'web/src/styles/pages.css', 'web/src/landing/landing.css']
    .filter((f) => fs.existsSync(at(f))).map((f) => fs.readFileSync(at(f), 'utf8')).join('\n');
  const min = await build({ stdin: { contents: css, loader: 'css' }, write: false, minify: true, logLevel: 'warning' });
  fs.writeFileSync(out('styles.css'), min.outputFiles[0].text);

  for (const f of fs.readdirSync(at('web/src/styles/fonts'))) fs.copyFileSync(at('web/src/styles/fonts', f), out('fonts', f));
  const artDir = at('web/art');
  if (fs.existsSync(artDir)) for (const f of fs.readdirSync(artDir)) {
    const p = path.join(artDir, f);
    if (fs.statSync(p).isFile() && !f.startsWith('.')) fs.copyFileSync(p, out('art', f));
  }
  // site-root files (served at /<name> by the server from web/dist)
  const icons = at('web/art/icons');
  if (fs.existsSync(icons)) for (const f of fs.readdirSync(icons)) fs.copyFileSync(path.join(icons, f), out(f));
  fs.copyFileSync(at('web/src/landing/index.html'), out('index.html'));
  if (fs.existsSync(at('web/src/landing/404.html'))) fs.copyFileSync(at('web/src/landing/404.html'), out('404.html'));
  if (!quiet) console.log('landing built:', ['index.html', 'landing.js', 'scene-gl.js', 'styles.css'].map((f) => `${f} ${(fs.statSync(out(f)).size / 1024).toFixed(1)}K`).join(' · '));
}

// standalone: node web/src/landing/build.mjs  (dev; does not touch APP's files)
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  await buildLanding({ root, dist: path.join(root, 'web/dist') });
}

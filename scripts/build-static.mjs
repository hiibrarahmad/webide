// Builds the static IDE (for GitHub Pages) into dist/, bundling the vendor libraries.
// COMPILE_SERVER_URL sets the default compile server the page talks to.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const dist = path.join(root, 'dist');
const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(dist, to), { recursive: true });

fs.rmSync(dist, { recursive: true, force: true });
copy('public', '.');
copy('node_modules/monaco-editor/min', 'vendor/monaco');
copy('node_modules/esptool-js/bundle.js', 'vendor/esptool.js');
copy('node_modules/jszip/dist/jszip.min.js', 'vendor/jszip.min.js');

const apiBase = (process.env.COMPILE_SERVER_URL || '').replace(/\/+$/, '');
// Repository whose GitHub Actions compile sketches when no compile server is reachable
const buildRepo = process.env.GITHUB_REPOSITORY || '';
fs.writeFileSync(path.join(dist, 'config.js'), `window.WEBIDE_CONFIG = ${JSON.stringify({ apiBase, buildRepo })};\n`);
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

// Cache-bust so visitors get new versions right after a deploy
const v = (process.env.GITHUB_SHA || String(Date.now())).slice(0, 8);
const html = path.join(dist, 'index.html');
fs.writeFileSync(html, fs.readFileSync(html, 'utf8')
  .replace(/(href|src)="(style\.css|config\.js|js\/app\.js)"/g, (_m, attr, file) => `${attr}="${file}?v=${v}"`));
// Compact Arduino Library Manager index for the Libraries panel:
// [name, latest version, author, sentence, category, architectures]
const cmpVer = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};
let libs = [];
try {
  const r = await fetch('https://downloads.arduino.cc/libraries/library_index.json.gz');
  if (!r.ok) throw new Error(r.status);
  const index = JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())));
  const latest = new Map();
  for (const l of index.libraries) {
    const prev = latest.get(l.name);
    if (!prev || cmpVer(l.version, prev.version) > 0) latest.set(l.name, l);
  }
  libs = [...latest.values()].map(l => [
    l.name, l.version,
    (l.author || '').replace(/<[^>]*>/g, '').split(',')[0].trim().slice(0, 40),
    (l.sentence || '').slice(0, 160), l.category || '', (l.architectures || []).join(','),
  ]);
} catch (e) {
  console.warn('Library index download failed; Libraries panel will be empty:', e.message);
}
fs.writeFileSync(path.join(dist, 'libraries.json'), JSON.stringify(libs));

console.log(`Built dist/ (${libs.length} libraries, compile server: ${apiBase || 'same origin'})`);

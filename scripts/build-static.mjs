// Builds the static IDE (for GitHub Pages) into dist/, bundling the vendor libraries.
// COMPILE_SERVER_URL sets the default compile server the page talks to.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const dist = path.join(root, 'dist');
const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(dist, to), { recursive: true });

fs.rmSync(dist, { recursive: true, force: true });
copy('public', '.');
copy('node_modules/monaco-editor/min', 'vendor/monaco');
copy('node_modules/esptool-js/bundle.js', 'vendor/esptool.js');
copy('node_modules/jszip/dist/jszip.min.js', 'vendor/jszip.min.js');

const apiBase = (process.env.COMPILE_SERVER_URL || '').replace(/\/+$/, '');
fs.writeFileSync(path.join(dist, 'config.js'), `window.WEBIDE_CONFIG = ${JSON.stringify({ apiBase })};\n`);
fs.writeFileSync(path.join(dist, '.nojekyll'), '');
console.log(`Built dist/ (compile server: ${apiBase || 'same origin'})`);

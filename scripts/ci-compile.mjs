// Runs inside the "Compile sketch" GitHub Actions job.
// Reads the sketch from the workflow input, compiles it, and publishes result.json on the
// branch ide-build/<id>, where the browser IDE picks it up through the GitHub API.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { cli, compileSketch } from '../compile.js';

const { BUILD_ID, FQBN, SKETCH, OPTIONS, GH_TOKEN, REPO } = process.env;
if (!/^[a-z0-9]{6,40}$/.test(BUILD_ID || '')) throw new Error('Invalid build id');

async function gh(p, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${p}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub API ${p}: ${r.status} ${await r.text()}`);
  return r.json();
}

// libraries.txt in the sketch, one entry per line:
//   Library Manager name (optionally name@version), a git URL (https://github.com/user/lib.git),
//   or a link to a .zip of the library
async function installLibraries(text) {
  let out = '';
  for (const entry of text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
    try {
      if (/^https:\/\/\S+\.zip$/i.test(entry)) {
        const r = await fetch(entry);
        if (!r.ok) throw new Error(`download failed (${r.status})`);
        const zip = path.join(os.tmpdir(), `lib-${Date.now()}.zip`);
        await fs.writeFile(zip, Buffer.from(await r.arrayBuffer()));
        await cli(['lib', 'install', '--zip-path', zip]);
      } else if (/^https:\/\/\S+$/i.test(entry)) {
        await cli(['lib', 'install', '--git-url', entry]);
      } else if (/^[\w .@+-]+$/.test(entry)) {
        await cli(['lib', 'install', entry]);
      } else {
        out += `Skipped invalid libraries.txt entry: ${entry}\n`;
        continue;
      }
      out += `Installed library ${entry}\n`;
    } catch (e) {
      out += `Could not install library ${entry}: ${String(e.stderr || e.message).trim()}\n`;
    }
  }
  return out;
}

let body;
try {
  const { files } = JSON.parse(zlib.gunzipSync(Buffer.from(SKETCH, 'base64')).toString('utf8'));
  let options = {};
  try { options = JSON.parse(OPTIONS || '{}'); } catch {}

  const libFile = files.find(f => f.path === 'libraries.txt');
  const libLog = libFile ? await installLibraries(libFile.content || '') : '';

  const r = await compileSketch({ fqbn: FQBN, files, debug: !!options.debug });
  body = r.body;
  if (libLog) body.log = libLog + (body.log || '');
} catch (e) {
  body = { error: e.message };
}

const blob = await gh('/git/blobs', { content: Buffer.from(JSON.stringify(body)).toString('base64'), encoding: 'base64' });
const tree = await gh('/git/trees', { tree: [{ path: 'result.json', mode: '100644', type: 'blob', sha: blob.sha }] });
const commit = await gh('/git/commits', { message: `Build ${BUILD_ID}`, tree: tree.sha });
await gh('/git/refs', { ref: `refs/heads/ide-build/${BUILD_ID}`, sha: commit.sha });
console.log(body.error ? `Compile failed: ${body.error}` : `Compiled ${body.filename}`);
console.log(body.log || '');

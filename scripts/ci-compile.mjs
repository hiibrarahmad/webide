// Runs inside the "Compile sketch" GitHub Actions job.
// Reads the sketch from the workflow input, compiles it, and publishes result.json on the
// branch ide-build/<id>, where the browser IDE picks it up through the GitHub API.
import zlib from 'node:zlib';
import { cli, compileSketch } from '../compile.js';

const { BUILD_ID, FQBN, SKETCH, GH_TOKEN, REPO } = process.env;
if (!/^[a-z0-9]{6,40}$/.test(BUILD_ID || '')) throw new Error('Invalid build id');

async function gh(path, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`GitHub API ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

let body;
try {
  const { files } = JSON.parse(zlib.gunzipSync(Buffer.from(SKETCH, 'base64')).toString('utf8'));

  // libraries.txt in the sketch: one Library Manager name per line
  let libLog = '';
  const libFile = files.find(f => f.path === 'libraries.txt');
  for (const name of (libFile?.content || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'))) {
    if (!/^[\w .@+-]+$/.test(name)) { libLog += `Skipped invalid library name: ${name}\n`; continue; }
    try {
      await cli(['lib', 'install', name]);
      libLog += `Installed library ${name}\n`;
    } catch (e) {
      libLog += `Could not install library ${name}: ${(e.stderr || e.message).trim()}\n`;
    }
  }

  const r = await compileSketch({ fqbn: FQBN, files });
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

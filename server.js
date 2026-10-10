// Web IDE backend: compiles Arduino sketches with arduino-cli and manages libraries.
// Flashing and serial happen in the browser via Web Serial, so the board stays on the user's PC.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, compileSketch, FQBN_RE } from './compile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const JOBS = process.env.COMPILE_JOBS || '0';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_COMPILES || 2);
const ALLOW_LIB_INSTALL = process.env.ALLOW_LIB_INSTALL !== 'false';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10mb' }));

// CORS so the GitHub Pages frontend can call this server
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin))) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Simple per-IP rate limit for expensive endpoints
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip + req.path;
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'Too many requests, slow down a little' });
    list.push(now);
    hits.set(key, list);
    next();
  };
}
setInterval(() => hits.clear(), 60 * 60 * 1000).unref();

// Limit parallel compiles so a small server does not run out of memory
let running = 0;
const waiting = [];
async function withCompileSlot(fn) {
  if (running >= MAX_CONCURRENT) await new Promise(r => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, queue: waiting.length, running, libInstall: ALLOW_LIB_INSTALL }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor/monaco', express.static(path.join(__dirname, 'node_modules/monaco-editor/min')));
app.get('/vendor/esptool.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/esptool-js/bundle.js')));
app.get('/vendor/jszip.min.js', (_req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/jszip/dist/jszip.min.js')));

// Boards from installed cores
let boardsCache = null;
app.get('/api/boards', async (_req, res) => {
  try {
    if (!boardsCache) {
      const { stdout } = await cli(['board', 'listall', '--format', 'json']);
      boardsCache = (JSON.parse(stdout).boards || [])
        .map(b => ({ name: b.name, fqbn: b.fqbn, platform: b.platform?.release?.name || b.platform?.metadata?.id }))
        .sort((a, b) => a.platform.localeCompare(b.platform) || a.name.localeCompare(b.name));
    }
    res.json(boardsCache);
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

// Board menu options (e.g. Nano "Old Bootloader") + how the browser should flash it
app.get('/api/board', async (req, res) => {
  const fqbn = String(req.query.fqbn || '');
  if (!FQBN_RE.test(fqbn)) return res.status(400).json({ error: 'bad fqbn' });
  try {
    const [{ stdout: json }, { stdout: props }] = await Promise.all([
      cli(['board', 'details', '--fqbn', fqbn, '--format', 'json']),
      cli(['board', 'details', '--fqbn', fqbn, '--show-properties=expanded']),
    ]);
    const p = Object.fromEntries(props.split(/\r?\n/).filter(l => l.includes('='))
      .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    res.json({
      options: JSON.parse(json).config_options || [],
      upload: uploadInfo(fqbn, p),
    });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

function uploadInfo(fqbn, p) {
  const tool = p['upload.tool'] || '';
  if (tool.startsWith('esptool')) return { method: 'esptool', speed: Number(p['upload.speed']) || 460800 };
  if (tool.startsWith('avrdude') && ['arduino', 'wiring'].includes(p['upload.protocol']))
    return {
      method: p['upload.protocol'] === 'wiring' ? 'stk500v2' : 'stk500v1',
      speed: Number(p['upload.speed']) || 115200,
      pageSize: /atmega(1280|2560|1284|644)/.test(p['build.mcu'] || '') ? 256 : 128,
    };
  return { method: 'download', note: `Browser upload is not supported for ${fqbn} (${tool || 'unknown tool'}); download the binary instead.` };
}

// Compile: { fqbn, files: [{ path, content }] } -> { log, binary(base64), format, address }
app.post('/api/compile', rateLimit(20, 60 * 1000), async (req, res) => {
  const { fqbn, files, debug } = req.body || {};
  const { status, body } = await compileSketch({ fqbn, files, debug: !!debug, jobs: JOBS, slot: withCompileSlot });
  res.status(status).json(body);
});

// Libraries
app.get('/api/libs/search', rateLimit(30, 60 * 1000), async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  try {
    const { stdout } = await cli(['lib', 'search', q, '--format', 'json', '--omit-releases-details']);
    const libs = (JSON.parse(stdout).libraries || []).slice(0, 30).map(l => ({
      name: l.name,
      version: l.latest?.version,
      author: l.latest?.author,
      sentence: l.latest?.sentence,
    }));
    res.json(libs);
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

app.get('/api/libs/installed', async (_req, res) => {
  try {
    const { stdout } = await cli(['lib', 'list', '--format', 'json']);
    const libs = (JSON.parse(stdout).installed_libraries || []).map(l => ({ name: l.library.name, version: l.library.version }));
    res.json(libs);
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

app.post('/api/libs/install', rateLimit(10, 60 * 1000), async (req, res) => {
  if (!ALLOW_LIB_INSTALL) return res.status(403).json({ error: 'Library install is disabled on this server' });
  const name = String(req.body?.name || '');
  if (!/^[\w .@+-]+$/.test(name)) return res.status(400).json({ error: 'bad library name' });
  try {
    const { stdout, stderr } = await cli(['lib', 'install', name]);
    res.json({ log: stdout + stderr });
  } catch (e) {
    res.status(500).json({ error: e.stderr || e.message });
  }
});

app.listen(PORT, () => console.log(`Web IDE running at http://localhost:${PORT}`));

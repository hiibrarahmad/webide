// Web IDE backend: compiles Arduino sketches with arduino-cli and manages libraries.
// Flashing and serial happen in the browser via Web Serial, so the board stays on the user's PC.
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CLI = process.env.ARDUINO_CLI || 'arduino-cli';
const JOBS = process.env.COMPILE_JOBS || '0';
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_COMPILES || 2);
const ALLOW_LIB_INSTALL = process.env.ALLOW_LIB_INSTALL !== 'false';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
const FQBN_RE = /^[\w.-]+:[\w.-]+:[\w.-]+(:[\w.=,-]+)?$/;

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

async function cli(args, opts = {}) {
  return run(CLI, [...args, '--no-color'], { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, ...opts });
}

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

function safeRel(p) {
  const norm = path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!norm || norm.startsWith('..') || norm.includes('/../')) throw new Error(`bad path: ${p}`);
  return norm;
}

// Compile: { fqbn, files: [{ path, content }] } -> { log, binary(base64), format, address }
app.post('/api/compile', rateLimit(20, 60 * 1000), async (req, res) => {
  const { fqbn, files } = req.body || {};
  if (!FQBN_RE.test(fqbn || '')) return res.status(400).json({ error: 'Select a valid board' });
  if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: 'No files' });

  try { files.forEach(f => safeRel(f.path)); } catch (e) { return res.status(400).json({ error: e.message }); }
  // The sketch folder must be named after the main .ino
  const inos = files.filter(f => /^[^/]+\.ino$/i.test(safeRel(f.path)));
  if (!inos.length) return res.status(400).json({ error: 'Project needs a .ino file at the top level' });
  // build_opt.h is passed straight to the compiler; block flags that can run arbitrary programs
  const opt = files.find(f => safeRel(f.path) === 'build_opt.h');
  if (opt && /-(specs|fplugin|wrapper|B|iplugindir)|@/.test(opt.content || ''))
    return res.status(400).json({ error: 'build_opt.h contains flags that are not allowed on this server' });
  const main = path.posix.basename(inos[0].path, '.ino').replace(/[^\w-]/g, '_') || 'sketch';

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'webide-'));
  const sketchDir = path.join(work, main);
  const outDir = path.join(work, 'out');
  try {
    for (const f of files) {
      let rel = safeRel(f.path);
      if (f === inos[0]) rel = `${main}.ino`;
      const dest = path.join(sketchDir, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, f.content ?? '');
    }
    let log;
    try {
      const r = await withCompileSlot(() =>
        cli(['compile', '--fqbn', fqbn, '--output-dir', outDir, '--warnings', 'default', '--jobs', JOBS, sketchDir]));
      log = r.stdout + r.stderr;
    } catch (e) {
      const msg = String((e.stdout || '') + (e.stderr || e.message)).split(sketchDir).join('');
      return res.status(422).json({ error: 'Compilation failed', log: msg });
    }
    log = log.split(sketchDir).join('');

    const out = await fs.readdir(outDir);
    const hex = out.find(f => f.endsWith('.ino.hex'));
    const merged = out.find(f => f.endsWith('.ino.merged.bin'));
    const bin = out.find(f => f.endsWith('.ino.bin'));
    let result;
    if (merged) {
      // Merged image is padded to full flash size; drop the trailing 0xFF so uploads are fast
      const buf = await fs.readFile(path.join(outDir, merged));
      let end = buf.length;
      while (end > 0 && buf[end - 1] === 0xff) end--;
      end = Math.ceil(end / 4) * 4;
      result = { format: 'bin', address: 0, binary: buf.subarray(0, end).toString('base64'), filename: `${main}.merged.bin` };
    } else if (hex) {
      result = { format: 'hex', binary: Buffer.from(await fs.readFile(path.join(outDir, hex))).toString('base64'), filename: `${main}.hex` };
    } else if (bin) {
      result = { format: 'bin', address: 0x10000, binary: (await fs.readFile(path.join(outDir, bin))).toString('base64'), filename: `${main}.bin` };
    } else {
      return res.status(500).json({ error: 'No firmware produced', log });
    }
    res.json({ log, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
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

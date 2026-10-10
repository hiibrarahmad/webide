// Shared sketch compiler used by the web server and by the GitHub Actions compile job.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const CLI = process.env.ARDUINO_CLI || 'arduino-cli';
export const FQBN_RE = /^[\w.-]+:[\w.-]+:[\w.-]+(:[\w.=,-]+)?$/;

export async function cli(args, opts = {}) {
  return run(CLI, [...args, '--no-color'], { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000, ...opts });
}

export function safeRel(p) {
  const norm = path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!norm || norm.startsWith('..') || norm.includes('/../')) throw new Error(`bad path: ${p}`);
  return norm;
}

// Compile { fqbn, files: [{ path, content }] }.
// Returns { status, body } where body is { log, binary(base64), format, address, filename } or { error, log }.
export async function compileSketch({ fqbn, files, jobs = '0', slot = fn => fn() }) {
  if (!FQBN_RE.test(fqbn || '')) return { status: 400, body: { error: 'Select a valid board' } };
  if (!Array.isArray(files) || !files.length) return { status: 400, body: { error: 'No files' } };

  try { files.forEach(f => safeRel(f.path)); } catch (e) { return { status: 400, body: { error: e.message } }; }
  // The sketch folder must be named after the main .ino
  const inos = files.filter(f => /^[^/]+\.ino$/i.test(safeRel(f.path)));
  if (!inos.length) return { status: 400, body: { error: 'Project needs a .ino file at the top level' } };
  // build_opt.h is passed straight to the compiler; block flags that can run arbitrary programs
  const opt = files.find(f => safeRel(f.path) === 'build_opt.h');
  if (opt && /-(specs|fplugin|wrapper|B|iplugindir)|@/.test(opt.content || ''))
    return { status: 400, body: { error: 'build_opt.h contains flags that are not allowed on this server' } };
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
      const r = await slot(() =>
        cli(['compile', '--fqbn', fqbn, '--output-dir', outDir, '--warnings', 'default', '--jobs', String(jobs), sketchDir]));
      log = r.stdout + r.stderr;
    } catch (e) {
      const msg = String((e.stdout || '') + (e.stderr || e.message)).split(sketchDir).join('');
      return { status: 422, body: { error: 'Compilation failed', log: msg } };
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
      result = { format: 'hex', binary: (await fs.readFile(path.join(outDir, hex))).toString('base64'), filename: `${main}.hex` };
    } else if (bin) {
      result = { format: 'bin', address: 0x10000, binary: (await fs.readFile(path.join(outDir, bin))).toString('base64'), filename: `${main}.bin` };
    } else {
      return { status: 500, body: { error: 'No firmware produced', log } };
    }
    return { status: 200, body: { log, ...result } };
  } catch (e) {
    return { status: 500, body: { error: e.message } };
  } finally {
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

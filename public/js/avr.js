// In-browser AVR flasher over Web Serial.
// stk500v1 = Optiboot (Uno, Nano, Pro Mini); stk500v2 = Mega 2560 bootloader ("wiring").

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function parseIntelHex(text) {
  const chunks = [];
  let base = 0, max = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error('Invalid HEX line: ' + line);
    const bytes = line.slice(1).match(/../g).map(h => parseInt(h, 16));
    const [len, hi, lo, type] = bytes;
    const data = bytes.slice(4, 4 + len);
    const sum = bytes.reduce((a, b) => a + b, 0) & 0xff;
    if (sum !== 0) throw new Error('HEX checksum error');
    if (type === 0x00) {
      const addr = base + ((hi << 8) | lo);
      chunks.push([addr, data]);
      max = Math.max(max, addr + len);
    } else if (type === 0x01) break;
    else if (type === 0x02) base = ((data[0] << 8) | data[1]) << 4;
    else if (type === 0x04) base = ((data[0] << 8) | data[1]) << 16;
  }
  const image = new Uint8Array(max).fill(0xff);
  for (const [addr, data] of chunks) image.set(data, addr);
  return image;
}

// Buffered reader with timeouts on top of an open SerialPort
class PortIO {
  constructor(port) {
    this.port = port;
    this.buf = [];
    this.waiters = [];
    this.reader = port.readable.getReader();
    this.done = this.pump();
  }
  async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const b of value) this.buf.push(b);
        this.waiters.splice(0).forEach(w => w());
      }
    } catch { /* port closed */ }
  }
  async write(bytes) {
    const w = this.port.writable.getWriter();
    try { await w.write(new Uint8Array(bytes)); } finally { w.releaseLock(); }
  }
  drain() { this.buf.length = 0; }
  async read(n, timeout = 1000) {
    const deadline = Date.now() + timeout;
    while (this.buf.length < n) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Timeout waiting for board response');
      await Promise.race([new Promise(r => this.waiters.push(r)), sleep(left)]);
    }
    return this.buf.splice(0, n);
  }
  async close() {
    try { await this.reader.cancel(); } catch {}
    this.reader.releaseLock();
    await this.done;
  }
}

async function resetBoard(port) {
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  await sleep(250);
  await port.setSignals({ dataTerminalReady: true, requestToSend: true });
  await sleep(50);
}

const OK = 0x10, INSYNC = 0x14, EOP = 0x20;

async function v1cmd(io, bytes, respLen = 0, timeout = 1000) {
  await io.write([...bytes, EOP]);
  const head = await io.read(1, timeout);
  if (head[0] !== INSYNC) throw new Error(`Not in sync (got 0x${head[0].toString(16)})`);
  const data = respLen ? await io.read(respLen, timeout) : [];
  const tail = await io.read(1, timeout);
  if (tail[0] !== OK) throw new Error('Board did not acknowledge command');
  return data;
}

async function flashV1(io, port, image, pageSize, log, progress) {
  let synced = false;
  for (let attempt = 0; attempt < 3 && !synced; attempt++) {
    await resetBoard(port);
    for (let i = 0; i < 10 && !synced; i++) {
      io.drain();
      try { await v1cmd(io, [0x30], 0, 200); synced = true; } catch {}
    }
  }
  if (!synced) throw new Error('Could not sync with bootloader. Check the board/port and the "Processor" option (old bootloader?).');
  log('Bootloader in sync');
  const sig = await v1cmd(io, [0x75], 3).catch(() => null);
  if (sig) log('Signature: ' + sig.map(b => b.toString(16).padStart(2, '0')).join(' '));
  await v1cmd(io, [0x50]);

  const pages = Math.ceil(image.length / pageSize);
  for (let p = 0; p < pages; p++) {
    const addr = p * pageSize, word = addr >> 1;
    const page = image.subarray(addr, addr + pageSize);
    await v1cmd(io, [0x55, word & 0xff, (word >> 8) & 0xff]);
    await v1cmd(io, [0x64, page.length >> 8, page.length & 0xff, 0x46, ...page], 0, 2000);
    progress((p + 1) / pages / 2);
  }
  log('Verifying...');
  for (let p = 0; p < pages; p++) {
    const addr = p * pageSize, word = addr >> 1;
    const page = image.subarray(addr, addr + pageSize);
    await v1cmd(io, [0x55, word & 0xff, (word >> 8) & 0xff]);
    const got = await v1cmd(io, [0x74, page.length >> 8, page.length & 0xff, 0x46], page.length, 2000);
    for (let i = 0; i < page.length; i++)
      if (got[i] !== page[i]) throw new Error(`Verify failed at 0x${(addr + i).toString(16)}`);
    progress(0.5 + (p + 1) / pages / 2);
  }
  await v1cmd(io, [0x51]);
}

class V2 {
  constructor(io) { this.io = io; this.seq = 0; }
  async cmd(body, timeout = 1000) {
    const seq = this.seq++ & 0xff;
    const msg = [0x1b, seq, body.length >> 8, body.length & 0xff, 0x0e, ...body];
    msg.push(msg.reduce((a, b) => a ^ b, 0));
    await this.io.write(msg);
    // Skip noise until message start
    let start;
    do { [start] = await this.io.read(1, timeout); } while (start !== 0x1b);
    const [rseq, sh, sl, tok] = await this.io.read(4, timeout);
    const len = (sh << 8) | sl;
    const resp = await this.io.read(len + 1, timeout);
    const sum = [0x1b, rseq, sh, sl, tok, ...resp].reduce((a, b) => a ^ b, 0);
    if (tok !== 0x0e || sum !== 0 || rseq !== seq) throw new Error('Bad STK500v2 response');
    if (resp[0] !== body[0] || resp[1] !== 0x00) throw new Error(`Command 0x${body[0].toString(16)} failed (status ${resp[1]})`);
    return resp.slice(2, len);
  }
  loadAddress(byteAddr) {
    const w = (byteAddr >> 1) | 0x80000000; // high bit: extended addressing (needed >128KB)
    return this.cmd([0x06, (w >>> 24) & 0xff, (w >> 16) & 0xff, (w >> 8) & 0xff, w & 0xff]);
  }
}

async function flashV2(io, port, image, pageSize, log, progress) {
  const v2 = new V2(io);
  let ok = false;
  for (let attempt = 0; attempt < 3 && !ok; attempt++) {
    await resetBoard(port);
    for (let i = 0; i < 8 && !ok; i++) {
      io.drain();
      try { await v2.cmd([0x01], 300); ok = true; } catch {}
    }
  }
  if (!ok) throw new Error('Could not sync with STK500v2 bootloader');
  log('Bootloader in sync');
  await v2.cmd([0x10, 0xc8, 0x64, 0x19, 0x20, 0x00, 0x53, 0x03, 0xac, 0x53, 0x00, 0x00]);

  const pages = Math.ceil(image.length / pageSize);
  for (let p = 0; p < pages; p++) {
    const addr = p * pageSize;
    const page = image.subarray(addr, addr + pageSize);
    await v2.loadAddress(addr);
    await v2.cmd([0x13, page.length >> 8, page.length & 0xff, 0xc1, 0x0a, 0x40, 0x4c, 0x20, 0x00, 0x00, ...page], 2000);
    progress((p + 1) / pages / 2);
  }
  log('Verifying...');
  for (let p = 0; p < pages; p++) {
    const addr = p * pageSize;
    const page = image.subarray(addr, addr + pageSize);
    await v2.loadAddress(addr);
    const got = await v2.cmd([0x14, page.length >> 8, page.length & 0xff, 0x20], 2000);
    for (let i = 0; i < page.length; i++)
      if (got[i] !== page[i]) throw new Error(`Verify failed at 0x${(addr + i).toString(16)}`);
    progress(0.5 + (p + 1) / pages / 2);
  }
  await v2.cmd([0x11, 0x01, 0x01]);
}

export async function flashAvr(port, hexText, { method, speed, pageSize }, log, progress) {
  const image = parseIntelHex(hexText);
  log(`Firmware: ${image.length} bytes, ${method} @ ${speed} baud`);
  await port.open({ baudRate: speed });
  const io = new PortIO(port);
  try {
    if (method === 'stk500v2') await flashV2(io, port, image, pageSize || 256, log, progress);
    else await flashV1(io, port, image, pageSize || 128, log, progress);
    log('Upload complete');
  } finally {
    await io.close();
    await port.close();
  }
}

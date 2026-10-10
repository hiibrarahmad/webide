// Serial debugger: reads "@dbg …" lines from WebIDEDebug.h and ESP32 crash dumps.
//   @dbg watch name=value | @dbg log text | @dbg break file:line | @dbg resume
//   @dbg assert expr file:line | @dbg trace func file:line

const MAX_EVENTS = 300;

// Symbol table from the compile result: "addr size name[\tfile:line]" lines
export function parseSymbols(text) {
  const syms = [];
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^([0-9a-f]+) ([0-9a-f]+) ([^\t]+)(?:\t(.+))?$/);
    if (m) syms.push({ addr: parseInt(m[1], 16), size: parseInt(m[2], 16), name: m[3], loc: m[4] || '' });
  }
  return syms.sort((a, b) => a.addr - b.addr);
}

function lookup(syms, addr) {
  let lo = 0, hi = syms.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (syms[mid].addr <= addr) { best = syms[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best && addr < best.addr + Math.max(best.size, 1) ? best : null;
}

export class Debugger {
  // els: { state, continueBtn, runBtn, watches, events }
  // hooks: { send(text), onBreak(file, line), onResume(), plot(name, value), symbols(), openLocation(file, line) }
  constructor(els, hooks) {
    this.els = els;
    this.hooks = hooks;
    this.watches = new Map();
    this.events = [];
    this.paused = null;
    this.crash = null;
    els.continueBtn.onclick = () => this.resume('c');
    els.runBtn.onclick = () => this.resume('r');
    this.renderState();
  }

  reset() {
    this.watches.clear();
    this.events = [];
    this.paused = null;
    this.crash = null;
    this.els.watches.innerHTML = '';
    this.els.events.innerHTML = '';
    this.renderState();
  }

  // Returns true if the line is debugger protocol (so the monitor can hide it)
  handleLine(raw) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^@dbg (\w+)(?: (.*))?$/);
    if (m) {
      this.handleCommand(m[1], m[2] || '');
      return true;
    }
    this.watchCrash(line);
    return false;
  }

  handleCommand(cmd, arg) {
    if (cmd === 'watch') {
      const i = arg.indexOf('=');
      if (i < 0) return;
      const name = arg.slice(0, i).trim(), value = arg.slice(i + 1).trim();
      const w = this.watches.get(name) || { count: 0 };
      w.prev = w.value;
      w.value = value;
      w.count++;
      w.time = new Date();
      this.watches.set(name, w);
      const n = parseFloat(value);
      if (Number.isFinite(n) && /^-?[\d.]+(e[-+]?\d+)?$/i.test(value)) this.hooks.plot(name, n);
      this.renderWatch(name, w);
    } else if (cmd === 'log') {
      this.addEvent('log', arg);
    } else if (cmd === 'trace') {
      const m = arg.match(/^(.*) (\S+):(\d+)$/);
      this.addEvent('trace', m ? `${m[1]}()` : arg, m && { file: m[2], line: +m[3] });
    } else if (cmd === 'assert') {
      const m = arg.match(/^(.*) (\S+):(\d+)$/);
      this.addEvent('assert', `Assertion failed: ${m ? m[1] : arg}`, m && { file: m[2], line: +m[3] });
    } else if (cmd === 'break') {
      const m = arg.match(/^(\S+):(\d+)$/);
      this.paused = m ? { file: m[1], line: +m[2] } : { file: '', line: 0 };
      this.addEvent('break', `Paused at ${arg}`, this.paused);
      this.renderState();
      this.hooks.onBreak(this.paused.file, this.paused.line);
    } else if (cmd === 'resume') {
      if (this.paused) { this.paused = null; this.renderState(); this.hooks.onResume(); }
    }
  }

  resume(ch) {
    if (!this.paused) return;
    this.hooks.send(ch);
    this.addEvent('log', ch === 'r' ? 'Running: further breakpoints are skipped until the board resets' : 'Continue');
  }

  // ESP32 panic output → decoded crash report
  watchCrash(line) {
    if (/Guru Meditation Error|panic'ed|abort\(\) was called|Unhandled debug exception|Stack (canary|smashing)/.test(line)) {
      this.crash = { title: line.trim(), pcs: [] };
    }
    if (!this.crash) return;
    const reg = line.match(/\b(PC|MEPC|RA)\s*:\s*0x([0-9a-f]{8})/i);
    if (reg) this.crash.pcs.push({ label: reg[1].toUpperCase(), addr: parseInt(reg[2], 16) });
    const at = line.match(/at PC 0x([0-9a-f]{8})/i);
    if (at) this.crash.pcs.push({ label: 'PC', addr: parseInt(at[1], 16) });
    if (/^Backtrace:/.test(line.trim())) {
      for (const m of line.matchAll(/0x([0-9a-f]{8}):0x[0-9a-f]{8}/gi)) this.crash.pcs.push({ label: 'frame', addr: parseInt(m[1], 16) });
      this.finishCrash();
    } else if (/^Rebooting|^ELF file SHA256|^ets |^ESP-ROM:/.test(line.trim()) && this.crash.pcs.length) {
      this.finishCrash();
    }
  }

  finishCrash() {
    const crash = this.crash;
    this.crash = null;
    const syms = this.hooks.symbols();
    const frames = crash.pcs.map(p => ({ ...p, sym: syms.length ? lookup(syms, p.addr) : null }));
    this.addEvent('crash', crash.title, null, frames, !syms.length);
  }

  addEvent(kind, text, loc, frames, noSymbols) {
    const ev = { kind, text, loc, frames, noSymbols, time: new Date() };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
      this.els.events.firstElementChild?.remove();
    }
    this.els.events.appendChild(this.renderEvent(ev));
    this.els.events.scrollTop = this.els.events.scrollHeight;
  }

  renderEvent(ev) {
    const li = document.createElement('li');
    li.className = `ev ev-${ev.kind}`;
    const time = document.createElement('time');
    time.textContent = ev.time.toTimeString().slice(0, 8);
    const label = document.createElement('b');
    label.textContent = { log: 'LOG', trace: 'TRACE', assert: 'ASSERT', break: 'BREAK', crash: 'CRASH' }[ev.kind];
    const text = document.createElement('span');
    text.textContent = ev.text;
    li.append(time, label, text);
    if (ev.loc?.file) li.appendChild(this.locLink(ev.loc.file, ev.loc.line));
    if (ev.frames) {
      const ol = document.createElement('ol');
      ol.className = 'frames';
      for (const f of ev.frames) {
        const fl = document.createElement('li');
        const addr = '0x' + f.addr.toString(16).padStart(8, '0');
        fl.append(`${f.label === 'frame' ? '' : f.label + ' '}${addr}  `);
        const name = document.createElement('code');
        name.textContent = f.sym ? `${f.sym.name} + 0x${(f.addr - f.sym.addr).toString(16)}` : '??';
        fl.appendChild(name);
        const loc = f.sym?.loc?.match(/^(.*):(\d+)$/);
        if (loc) fl.appendChild(this.locLink(loc[1], +loc[2]));
        ol.appendChild(fl);
      }
      li.appendChild(ol);
      if (ev.noSymbols) {
        const p = document.createElement('p');
        p.textContent = 'Compile this sketch in this session to decode the addresses into function names.';
        li.appendChild(p);
      }
    }
    return li;
  }

  locLink(file, line) {
    const a = document.createElement('button');
    a.className = 'loc';
    a.textContent = `${file}:${line}`;
    a.onclick = () => this.hooks.openLocation(file, line);
    return a;
  }

  renderWatch(name, w) {
    let row = this.els.watches.querySelector(`tr[data-name="${CSS.escape(name)}"]`);
    if (!row) {
      row = document.createElement('tr');
      row.dataset.name = name;
      row.innerHTML = '<td class="w-name"></td><td class="w-val"></td><td class="w-prev"></td><td class="w-count"></td><td class="w-time"></td>';
      row.querySelector('.w-name').textContent = name;
      this.els.watches.appendChild(row);
    }
    const val = row.querySelector('.w-val');
    val.textContent = w.value;
    row.querySelector('.w-prev').textContent = w.prev ?? '';
    row.querySelector('.w-count').textContent = w.count;
    row.querySelector('.w-time').textContent = w.time.toTimeString().slice(0, 8);
    if (w.prev !== undefined && w.prev !== w.value) {
      val.classList.remove('changed');
      void val.offsetWidth; // restart the highlight animation
      val.classList.add('changed');
    }
  }

  renderState() {
    const { state, continueBtn, runBtn } = this.els;
    continueBtn.disabled = runBtn.disabled = !this.paused;
    if (this.paused) {
      state.className = 'pill paused';
      state.textContent = `Paused at ${this.paused.file}:${this.paused.line}`;
    } else {
      state.className = 'pill running';
      state.textContent = 'Running';
    }
  }
}

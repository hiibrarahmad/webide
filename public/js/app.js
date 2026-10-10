import { flashAvr } from './avr.js';
import { importRepo } from './github.js';

const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem('webide.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem('webide.' + k, JSON.stringify(v)); }
    catch { log('Could not save to browser storage (quota full?). Download your project as .zip.', 'err'); }
  },
};

// Compile server: same origin by default; GitHub Pages builds set config.js, users can override
function apiBase() {
  let v = '';
  try { v = localStorage.getItem('webide.apiBase') || ''; } catch {}
  return (v || window.WEBIDE_CONFIG?.apiBase || '').replace(/\/+$/, '');
}
function serverHelp(detail) {
  const where = apiBase() || location.origin;
  return `No compile server reachable at ${where}${detail ? ` (${detail})` : ''}.\n` +
    'GitHub Pages only hosts the editor; compiling needs the compile server. Deploy it (README → "Deploy to Render"), ' +
    'then click the status bar at the bottom to set its URL.';
}

async function api(path, opts) {
  let r;
  try { r = await fetch(apiBase() + path, opts); } catch { throw new Error(serverHelp()); }
  // Anything that is not JSON (e.g. a GitHub Pages 404/405 page) means there is no API here
  if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error(serverHelp(`HTTP ${r.status}`));
  return r;
}

async function checkServer() {
  const el = $('serverStatus');
  el.textContent = '● Compile server: connecting…';
  el.title = (apiBase() || location.origin) + ' (click to change)';
  // Free hosting tiers sleep when idle; the first request can take up to a minute
  const slow = setTimeout(() => (el.textContent = '● Compile server: waking up (can take ~1 min)…'), 4000);
  try {
    const r = await api('/api/health');
    if (!r.ok) throw new Error(r.status);
    el.textContent = '● Compile server: online';
    el.className = 'online';
    return true;
  } catch {
    el.textContent = '● Compile server: offline (click to set URL)';
    el.className = 'offline';
    return false;
  } finally {
    clearTimeout(slow);
  }
}

function configureServer() {
  const v = prompt('Compile server URL (empty = default):', apiBase());
  if (v === null) return;
  try { v.trim() ? localStorage.setItem('webide.apiBase', v.trim()) : localStorage.removeItem('webide.apiBase'); } catch {}
  checkServer().then(ok => ok && loadBoards());
}

const BLINK = `// Blink the built-in LED and print to the serial monitor

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED on");
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED off");
  delay(500);
}
`;

// ---------- Output / status ----------
function log(text, cls = '') {
  const out = $('output');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text.endsWith('\n') ? text : text + '\n';
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}
const setStatus = t => { $('status').textContent = t; };
function progress(frac) {
  const el = $('progress');
  if (frac == null) return el.classList.add('hidden');
  el.classList.remove('hidden');
  el.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}
function showBottom(name) {
  document.querySelectorAll('.bottom-tabs > button').forEach(b => b.classList.toggle('active', b.dataset.bpanel === name));
  document.querySelectorAll('.bpanel').forEach(p => p.classList.toggle('active', p.id === 'bpanel-' + name));
}

// ---------- Projects ----------
let projects = store.get('projects', null);
if (!projects || !Object.keys(projects).length) {
  projects = { blink: { name: 'Blink', files: { 'Blink.ino': BLINK }, open: ['Blink.ino'], active: 'Blink.ino' } };
}
let currentId = store.get('current', Object.keys(projects)[0]);
if (!projects[currentId]) currentId = Object.keys(projects)[0];
const project = () => projects[currentId];
const saveProjects = () => { store.set('projects', projects); store.set('current', currentId); };
const newId = () => Math.random().toString(36).slice(2, 10);

function renderProjectSelect() {
  const sel = $('projectSelect');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(projects).sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    sel.add(new Option(p.name, id, false, id === currentId));
  }
}

function createProject(name, files, active) {
  const id = newId();
  const paths = Object.keys(files);
  active ||= paths.find(p => p.endsWith('.ino')) || paths[0];
  projects[id] = { name, files, open: active ? [active] : [], active };
  switchProject(id);
}

function switchProject(id) {
  currentId = id;
  disposeModels();
  saveProjects();
  renderProjectSelect();
  renderTree();
  renderTabs();
  openFile(project().active);
}

// ---------- Editor ----------
let editor = null;
const models = new Map();

function languageFor(path) {
  if (/\.(ino|pde|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(path)) return 'cpp';
  if (/\.json$/i.test(path)) return 'json';
  if (/\.md$/i.test(path)) return 'markdown';
  if (/\.py$/i.test(path)) return 'python';
  if (/\.html?$/i.test(path)) return 'html';
  if (/\.js$/i.test(path)) return 'javascript';
  if (/\.css$/i.test(path)) return 'css';
  if (/\.ya?ml$/i.test(path)) return 'yaml';
  return 'plaintext';
}

function getModel(path) {
  if (models.has(path)) return models.get(path);
  const uri = monaco.Uri.parse(`file:///${currentId}/${path.split('/').map(encodeURIComponent).join('/')}`);
  const model = monaco.editor.createModel(project().files[path] ?? '', languageFor(path), uri);
  let timer;
  model.onDidChangeContent(() => {
    project().files[path] = model.getValue();
    clearTimeout(timer);
    timer = setTimeout(saveProjects, 400);
  });
  models.set(path, model);
  return model;
}

function disposeModels() {
  for (const m of models.values()) m.dispose();
  models.clear();
}

function openFile(path) {
  const p = project();
  if (!path || !(path in p.files)) {
    path = p.open.find(f => f in p.files) || Object.keys(p.files)[0];
  }
  $('emptyEditor').classList.toggle('hidden', !!path);
  if (!path) { editor?.setModel(null); p.active = null; renderTabs(); renderTree(); return; }
  if (!p.open.includes(path)) p.open.push(path);
  p.active = path;
  editor?.setModel(getModel(path));
  editor?.focus();
  saveProjects();
  renderTabs();
  renderTree();
}

function closeFile(path) {
  const p = project();
  p.open = p.open.filter(f => f !== path);
  if (p.active === path) p.active = p.open[p.open.length - 1] || null;
  openFile(p.active);
}

function renderTabs() {
  const el = $('editorTabs');
  el.innerHTML = '';
  const p = project();
  p.open = p.open.filter(f => f in p.files);
  for (const path of p.open) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === p.active ? ' active' : '');
    tab.title = path;
    tab.innerHTML = `<span class="label"></span><span class="x" title="Close">×</span>`;
    tab.querySelector('.label').textContent = path.split('/').pop();
    tab.onclick = e => e.target.classList.contains('x') ? closeFile(path) : openFile(path);
    el.appendChild(tab);
  }
}

// ---------- File tree ----------
function sketchRoot() {
  const p = project();
  const paths = Object.keys(p.files);
  const dirOf = f => f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '';
  if (p.active?.endsWith('.ino')) return { dir: dirOf(p.active), main: p.active };
  // If the open file lives in a sketch folder, use that folder
  if (p.active) {
    const d = dirOf(p.active);
    const ino = paths.find(f => dirOf(f) === d && f.endsWith('.ino'));
    if (ino) return { dir: d, main: ino };
  }
  const inos = paths.filter(f => f.endsWith('.ino')).sort((a, b) => a.split('/').length - b.split('/').length);
  return inos.length ? { dir: dirOf(inos[0]), main: inos[0] } : null;
}

function renderTree() {
  const el = $('fileTree');
  el.innerHTML = '';
  const p = project();
  const root = sketchRoot();
  const paths = Object.keys(p.files).sort((a, b) => {
    const da = a.split('/'), db = b.split('/');
    for (let i = 0; i < Math.min(da.length, db.length); i++) {
      if (da[i] === db[i]) continue;
      const aDir = i < da.length - 1, bDir = i < db.length - 1;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return da[i].localeCompare(db[i]);
    }
    return da.length - db.length;
  });
  const shownDirs = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/');
      if (shownDirs.has(dir)) continue;
      shownDirs.add(dir);
      const li = document.createElement('li');
      li.className = 'dir';
      li.style.paddingLeft = `${6 + i * 12}px`;
      li.textContent = '▾ ' + parts[i];
      el.appendChild(li);
    }
    const li = document.createElement('li');
    li.className = (path === p.active ? 'active ' : '') + (root?.main === path ? 'main' : '');
    li.style.paddingLeft = `${6 + (parts.length - 1) * 12}px`;
    li.title = path;
    li.innerHTML = `<span class="name"></span><span class="ops"><button data-op="rename" title="Rename">✎</button><button data-op="delete" title="Delete">🗑</button></span>`;
    li.querySelector('.name').textContent = parts[parts.length - 1];
    li.onclick = e => {
      const op = e.target.dataset?.op;
      if (op === 'rename') renameFile(path);
      else if (op === 'delete') deleteFile(path);
      else openFile(path);
    };
    el.appendChild(li);
  }
}

function cleanPath(s) {
  return s.replace(/\\/g, '/').split('/').filter(x => x && x !== '.' && x !== '..').join('/');
}

function newFile() {
  const p = project();
  const root = sketchRoot();
  const suggestion = (root?.dir ? root.dir + '/' : '') + 'new.h';
  const name = cleanPath(prompt('File name (use / for folders):', suggestion) || '');
  if (!name) return;
  if (name in p.files) return alert('A file with that name already exists');
  p.files[name] = '';
  saveProjects();
  renderTree();
  openFile(name);
}

function renameFile(path) {
  const p = project();
  const name = cleanPath(prompt('Rename to:', path) || '');
  if (!name || name === path) return;
  if (name in p.files) return alert('A file with that name already exists');
  p.files[name] = models.has(path) ? models.get(path).getValue() : p.files[path];
  delete p.files[path];
  models.get(path)?.dispose();
  models.delete(path);
  p.open = p.open.map(f => (f === path ? name : f));
  if (p.active === path) p.active = name;
  saveProjects();
  openFile(p.active);
}

function deleteFile(path) {
  if (!confirm(`Delete ${path}?`)) return;
  const p = project();
  delete p.files[path];
  models.get(path)?.dispose();
  models.delete(path);
  saveProjects();
  closeFile(path);
}

async function addLocalFiles(fileList) {
  const p = project();
  let last = null;
  for (const f of fileList) {
    if (f.size > 1024 * 1024) { log(`Skipped ${f.name} (larger than 1 MB)`, 'warn'); continue; }
    const rel = cleanPath(f.webkitRelativePath || f.name);
    p.files[rel] = await f.text();
    models.get(rel)?.setValue(p.files[rel]);
    last = rel;
  }
  saveProjects();
  renderTree();
  if (last) openFile(last);
}

async function downloadZip() {
  const zip = new JSZip();
  const p = project();
  for (const [path, content] of Object.entries(p.files)) zip.file(`${p.name}/${path}`, content);
  const blob = await zip.generateAsync({ type: 'blob' });
  downloadBlob(blob, `${p.name}.zip`);
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- Boards ----------
let boardInfo = null; // { options, upload }
let boardOpts = store.get('boardOpts', {});

async function loadBoards() {
  const sel = $('boardSelect');
  try {
    const boards = await (await api('/api/boards')).json();
    if (boards.error) throw new Error(boards.error);
    const groups = {};
    for (const b of boards) (groups[b.platform] ||= []).push(b);
    sel.innerHTML = '';
    for (const [platform, list] of Object.entries(groups)) {
      const og = document.createElement('optgroup');
      og.label = platform;
      for (const b of list) og.appendChild(new Option(b.name, b.fqbn));
      sel.appendChild(og);
    }
    const saved = store.get('board', 'arduino:avr:uno');
    sel.value = boards.some(b => b.fqbn === saved) ? saved : (boards.find(b => b.fqbn === 'arduino:avr:uno') || boards[0])?.fqbn;
    await onBoardChange();
  } catch (e) {
    log('Could not load boards: ' + e.message, 'err');
  }
}

function fullFqbn() {
  const base = $('boardSelect').value;
  const opts = boardOpts[base] || {};
  const parts = Object.entries(opts).map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${base}:${parts.join(',')}` : base;
}

async function onBoardChange() {
  const base = $('boardSelect').value;
  store.set('board', base);
  const box = $('boardOptions');
  box.innerHTML = '';
  try {
    boardInfo = await (await api('/api/board?fqbn=' + encodeURIComponent(fullFqbn()))).json();
    if (boardInfo.error) throw new Error(boardInfo.error);
  } catch (e) {
    boardInfo = null;
    return log('Board details failed: ' + e.message, 'err');
  }
  // Show only the options that matter most to keep the toolbar compact
  const important = /^(cpu|PartitionScheme|FlashSize|UploadSpeed|CDCOnBoot|USBMode)$/;
  for (const opt of boardInfo.options) {
    if (!important.test(opt.option)) continue;
    const s = document.createElement('select');
    s.title = opt.option_label;
    for (const v of opt.values) s.add(new Option(`${opt.option_label}: ${v.value_label}`, v.value));
    s.value = boardOpts[base]?.[opt.option] || opt.values.find(v => v.selected)?.value || opt.values[0].value;
    s.onchange = async () => {
      (boardOpts[base] ||= {})[opt.option] = s.value;
      store.set('boardOpts', boardOpts);
      await refreshUploadInfo();
    };
    box.appendChild(s);
  }
}

async function refreshUploadInfo() {
  try {
    const info = await (await api('/api/board?fqbn=' + encodeURIComponent(fullFqbn()))).json();
    if (!info.error) boardInfo.upload = info.upload;
  } catch {}
}

// ---------- Compile ----------
let lastBuild = null;
let busy = false;

function setBusy(b) {
  busy = b;
  $('btnVerify').disabled = b;
  $('btnUpload').disabled = b;
}

function setMarkers(logText, root) {
  for (const m of models.values()) monaco.editor.setModelMarkers(m, 'arduino', []);
  const byFile = {};
  const re = /([^\s:"']+\.(?:ino|cpp|c|h|hpp|cc|S)):(\d+):(?:(\d+):)?\s+(fatal error|error|warning):\s+(.*)/g;
  for (const m of logText.matchAll(re)) {
    let rel = m[1].replace(/\\/g, '/').replace(/^\/+/, '');
    // The server renames the main .ino to its sanitised name; map it back
    if (!rel.includes('/') && rel.endsWith('.ino') && !(joinRoot(root.dir, rel) in project().files)) rel = root.main.split('/').pop();
    let path = joinRoot(root.dir, rel);
    if (!(path in project().files)) path = joinRoot(root.dir, rel.split('/').pop());
    if (!(path in project().files)) continue;
    (byFile[path] ||= []).push({
      startLineNumber: +m[2], endLineNumber: +m[2],
      startColumn: +(m[3] || 1), endColumn: 1000,
      message: m[5],
      severity: m[4] === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
    });
  }
  for (const [path, markers] of Object.entries(byFile)) monaco.editor.setModelMarkers(getModel(path), 'arduino', markers);
  return Object.keys(byFile)[0];
}
const joinRoot = (dir, rel) => (dir ? dir + '/' + rel : rel);

async function compile() {
  const root = sketchRoot();
  if (!root) { log('No .ino file in this project.', 'err'); return null; }
  const p = project();
  const prefix = root.dir ? root.dir + '/' : '';
  const files = Object.entries(p.files)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, content]) => ({ path: path.slice(prefix.length), content }));
  // Put the main sketch first so the server names the sketch folder after it
  files.sort((a, b) => (a.path === root.main.slice(prefix.length) ? -1 : b.path === root.main.slice(prefix.length) ? 1 : 0));

  const fqbn = fullFqbn();
  showBottom('output');
  $('output').textContent = '';
  if (!fqbn) {
    log('No board list: the compile server is not connected.\n' + serverHelp(), 'err');
    return null;
  }
  log(`Compiling ${root.main} for ${fqbn}…`, 'info');
  setStatus('Compiling…');
  const t0 = performance.now();
  try {
    const res = await api('/api/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fqbn, files }),
    });
    const data = await res.json();
    const out = data.log || '';
    const firstErr = setMarkers(out, root);
    if (!res.ok) {
      log(out, 'err');
      log(data.error || 'Compilation failed', 'err');
      setStatus('Compilation failed');
      if (firstErr) openFile(firstErr);
      return null;
    }
    log(out);
    log(`Done in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'ok');
    setStatus('Compiled');
    lastBuild = data;
    $('btnDownloadFw').disabled = false;
    return data;
  } catch (e) {
    log('Compile request failed: ' + e.message, 'err');
    setStatus('Error');
    return null;
  }
}

async function verify() {
  if (busy) return;
  setBusy(true);
  try { await compile(); } finally { setBusy(false); }
}

const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

function downloadFirmware() {
  if (!lastBuild) return;
  downloadBlob(new Blob([b64ToBytes(lastBuild.binary)]), lastBuild.filename);
}

// ---------- Serial port ----------
const serial = { port: null, open: false, reader: null, loop: null, decoder: null, lineStart: true };

function portName(port) {
  const i = port.getInfo();
  const known = { 0x2341: 'Arduino', 0x2a03: 'Arduino', 0x1a86: 'CH340', 0x10c4: 'CP210x', 0x0403: 'FTDI', 0x303a: 'Espressif' };
  return i.usbVendorId ? `${known[i.usbVendorId] || 'USB'} ${i.usbVendorId.toString(16).padStart(4, '0')}:${(i.usbProductId || 0).toString(16).padStart(4, '0')}` : 'Serial port';
}

function setPort(port) {
  serial.port = port;
  $('portLabel').textContent = port ? portName(port) : 'Select port';
}

async function selectPort() {
  if (!('serial' in navigator)) {
    alert('Web Serial is not available. Use Chrome or Edge on desktop, over http://localhost or https.');
    return null;
  }
  try {
    if (serial.open) await closeMonitor();
    setPort(await navigator.serial.requestPort());
    return serial.port;
  } catch {
    return null; // user cancelled
  }
}

async function ensurePort() {
  return serial.port || selectPort();
}

function writeSerial(text) {
  const out = $('serialOut');
  if ($('chkTimestamp').checked) {
    let res = '';
    for (const ch of text) {
      if (serial.lineStart) res += new Date().toTimeString().slice(0, 8) + ' -> ';
      res += ch;
      serial.lineStart = ch === '\n';
    }
    text = res;
  }
  out.append(text);
  // Keep the monitor responsive with chatty boards
  if (out.textContent.length > 200000) out.textContent = out.textContent.slice(-150000);
  if ($('chkAutoscroll').checked) out.scrollTop = out.scrollHeight;
}

async function openMonitor() {
  const port = await ensurePort();
  if (!port) return;
  const baud = +$('baudSelect').value;
  try {
    await port.open({ baudRate: baud });
  } catch (e) {
    writeSerial(`\n[Could not open port: ${e.message}]\n`);
    return;
  }
  serial.open = true;
  serial.decoder = new TextDecoder();
  $('btnSerial').textContent = 'Disconnect';
  $('serialDot').classList.add('on');
  writeSerial(`\n[Connected @ ${baud} baud]\n`);
  serial.loop = (async () => {
    while (serial.open && port.readable) {
      serial.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await serial.reader.read();
          if (done) break;
          writeSerial(serial.decoder.decode(value, { stream: true }));
        }
      } catch (e) {
        if (serial.open) writeSerial(`\n[Read error: ${e.message}]\n`);
      } finally {
        serial.reader.releaseLock();
        serial.reader = null;
      }
    }
  })();
}

async function closeMonitor() {
  if (!serial.open) return;
  serial.open = false;
  try { await serial.reader?.cancel(); } catch {}
  await serial.loop;
  try { await serial.port.close(); } catch {}
  $('btnSerial').textContent = 'Connect';
  $('serialDot').classList.remove('on');
  writeSerial('\n[Disconnected]\n');
}

async function sendSerial() {
  const input = $('serialInput');
  if (!serial.open) return writeSerial('\n[Not connected]\n');
  const ending = $('lineEnding').value.replace('\\r', '\r').replace('\\n', '\n');
  const w = serial.port.writable.getWriter();
  try { await w.write(new TextEncoder().encode(input.value + ending)); } finally { w.releaseLock(); }
  input.value = '';
}

async function resetBoard() {
  const port = serial.port;
  if (!port) return;
  const wasOpen = serial.open;
  if (!wasOpen) await port.open({ baudRate: +$('baudSelect').value });
  await port.setSignals({ dataTerminalReady: false, requestToSend: true });
  await new Promise(r => setTimeout(r, 100));
  await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  if (!wasOpen) await port.close();
}

// ---------- Upload ----------
async function flashEsp(port, build, upload) {
  const { ESPLoader, Transport } = await import(new URL('../vendor/esptool.js', import.meta.url).href);
  const transport = new Transport(port, false);
  const terminal = {
    clean() {},
    writeLine: s => log(s),
    write: s => log(s),
  };
  const loader = new ESPLoader({ transport, baudrate: upload.speed, romBaudrate: 115200, terminal });
  try {
    const chip = await loader.main();
    log(`Connected to ${chip}`, 'info');
    await loader.writeFlash({
      fileArray: [{ data: b64ToBytes(build.binary), address: build.address }],
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep',
      eraseAll: false, compress: true,
      reportProgress: (_i, written, total) => progress(written / total),
    });
    await loader.after('hard_reset');
  } finally {
    await transport.disconnect().catch(() => {});
  }
}

async function upload() {
  if (busy) return;
  setBusy(true);
  const wasMonitoring = serial.open;
  try {
    const build = await compile();
    if (!build) return;
    const info = boardInfo?.upload;
    if (!info || info.method === 'download') {
      log(info?.note || 'Browser upload is not supported for this board; downloading the binary.', 'warn');
      downloadFirmware();
      return;
    }
    const port = await ensurePort();
    if (!port) { log('No port selected.', 'err'); return; }
    if (serial.open) await closeMonitor();

    log(`Uploading via ${info.method}…`, 'info');
    setStatus('Uploading…');
    progress(0);
    if (info.method === 'esptool') await flashEsp(port, build, info);
    else await flashAvr(port, atob(build.binary), info, s => log(s), progress);
    log('Upload finished ✔', 'ok');
    setStatus('Uploaded');
  } catch (e) {
    log('Upload failed: ' + (e.message || e), 'err');
    if (/Failed to open serial port/i.test(e.message || '')) {
      log('The operating system refused to open the port. Check that:\n' +
        '  • the right port is selected (🔌), not COM1 or a Bluetooth port\n' +
        '  • no other program or tab has it open (Arduino IDE serial monitor, another Web IDE tab)\n' +
        '  • the USB driver works: CH340 clones may need an older WCH driver (3.x) on Windows; replug the board', 'warn');
    } else {
      log('Tip: check the board type and Processor option, press Reset on the board, then try again.', 'warn');
    }
    setStatus('Upload failed');
  } finally {
    progress(null);
    setBusy(false);
    if (wasMonitoring) { showBottom('serial'); await openMonitor(); }
  }
}

// ---------- Libraries ----------
async function searchLibs() {
  const q = $('libQuery').value.trim();
  const ul = $('libResults');
  if (!q) return;
  ul.innerHTML = '<li>Searching…</li>';
  try {
    const libs = await (await api('/api/libs/search?q=' + encodeURIComponent(q))).json();
    if (libs.error) throw new Error(libs.error);
    ul.innerHTML = libs.length ? '' : '<li>No results</li>';
    for (const l of libs) {
      const li = document.createElement('li');
      li.innerHTML = '<b></b><p></p><button>Install</button>';
      li.querySelector('b').textContent = `${l.name} ${l.version || ''}`;
      li.querySelector('p').textContent = `${l.sentence || ''} — ${l.author || ''}`;
      li.querySelector('button').onclick = async e => {
        e.target.disabled = true;
        e.target.textContent = 'Installing…';
        const r = await (await api('/api/libs/install', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: l.name }),
        })).json();
        e.target.textContent = r.error ? 'Failed' : 'Installed';
        log(r.error || r.log, r.error ? 'err' : 'ok');
        loadInstalledLibs();
      };
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = '';
    log('Library search failed: ' + e.message, 'err');
  }
}

async function loadInstalledLibs() {
  const ul = $('libInstalled');
  try {
    const libs = await (await api('/api/libs/installed')).json();
    ul.innerHTML = '';
    for (const l of libs) {
      const li = document.createElement('li');
      li.textContent = `${l.name} ${l.version}`;
      ul.appendChild(li);
    }
  } catch {}
}

// ---------- GitHub ----------
async function ghImport() {
  const status = $('ghStatus');
  const btn = $('btnGhImport');
  const token = $('ghToken').value.trim();
  try { token ? sessionStorage.setItem('webide.ghToken', token) : sessionStorage.removeItem('webide.ghToken'); } catch {}
  status.className = 'status';
  btn.disabled = true;
  try {
    const { name, files, source } = await importRepo($('ghUrl').value, token, s => (status.textContent = s));
    createProject(name, files);
    status.textContent = `Imported ${Object.keys(files).length} files from ${source}`;
    store.set('ghLast', $('ghUrl').value);
    const root = sketchRoot();
    if (!root) log('Imported project has no .ino file; add one or link to a sketch folder.', 'warn');
    document.querySelector('.side-tabs [data-panel=files]').click();
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Wiring ----------
function wireUi() {
  document.querySelectorAll('.side-tabs button').forEach(b => (b.onclick = () => {
    document.querySelectorAll('.side-tabs button').forEach(x => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + b.dataset.panel));
    if (b.dataset.panel === 'libs') loadInstalledLibs();
  }));
  document.querySelectorAll('.bottom-tabs > button').forEach(b => (b.onclick = () => showBottom(b.dataset.bpanel)));

  $('btnVerify').onclick = verify;
  $('btnUpload').onclick = upload;
  $('btnPort').onclick = selectPort;
  $('btnDownloadFw').onclick = downloadFirmware;
  $('serverStatus').onclick = configureServer;
  $('boardSelect').onchange = onBoardChange;

  $('projectSelect').onchange = e => switchProject(e.target.value);
  $('btnProjectMenu').onclick = e => { e.stopPropagation(); $('projectMenu').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('projectMenu').classList.add('hidden'));
  $('projectMenu').onclick = e => {
    const act = e.target.dataset.act;
    if (act === 'new') {
      const name = prompt('Project name:', 'MySketch')?.trim();
      if (name) createProject(name, { [`${name.replace(/[^\w-]/g, '_')}.ino`]: 'void setup() {\n  \n}\n\nvoid loop() {\n  \n}\n' });
    } else if (act === 'rename') {
      const name = prompt('New name:', project().name)?.trim();
      if (name) { project().name = name; saveProjects(); renderProjectSelect(); }
    } else if (act === 'zip') downloadZip();
    else if (act === 'delete') {
      if (Object.keys(projects).length === 1) return alert('Cannot delete the only project');
      if (!confirm(`Delete project "${project().name}"? This cannot be undone.`)) return;
      delete projects[currentId];
      switchProject(Object.keys(projects)[0]);
    }
  };

  $('btnNewFile').onclick = newFile;
  $('fileInput').onchange = e => { addLocalFiles(e.target.files); e.target.value = ''; };
  $('folderInput').onchange = e => { addLocalFiles(e.target.files); e.target.value = ''; };

  $('btnGhImport').onclick = ghImport;
  $('ghUrl').value = store.get('ghLast', '');
  try { $('ghToken').value = sessionStorage.getItem('webide.ghToken') || ''; } catch {}
  $('ghUrl').onkeydown = e => e.key === 'Enter' && ghImport();

  $('btnLibSearch').onclick = searchLibs;
  $('libQuery').onkeydown = e => e.key === 'Enter' && searchLibs();

  $('btnSerial').onclick = () => (serial.open ? closeMonitor() : openMonitor());
  $('baudSelect').value = store.get('baud', '115200');
  $('baudSelect').onchange = async () => {
    store.set('baud', $('baudSelect').value);
    if (serial.open) { await closeMonitor(); await openMonitor(); }
  };
  $('btnSerialClear').onclick = () => { $('serialOut').textContent = ''; serial.lineStart = true; };
  $('btnSerialSend').onclick = sendSerial;
  $('serialInput').onkeydown = e => e.key === 'Enter' && sendSerial();
  $('btnResetBoard').onclick = resetBoard;

  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); verify(); }
    else if (k === 'u') { e.preventDefault(); upload(); }
    else if (k === 's') { e.preventDefault(); saveProjects(); setStatus('Saved'); }
  });

  if ('serial' in navigator) {
    // Prefer USB ports; built-in COM1 and Bluetooth ports are usually not the board
    navigator.serial.getPorts().then(ports => {
      const usb = ports.find(p => p.getInfo().usbVendorId);
      if (usb && !serial.port) setPort(usb);
    });
    navigator.serial.addEventListener('disconnect', e => {
      if (e.target === serial.port) {
        serial.open = false;
        $('serialDot').classList.remove('on');
        $('btnSerial').textContent = 'Connect';
        setPort(null);
        writeSerial('\n[Board disconnected]\n');
      }
    });
  } else {
    log('Web Serial is not supported in this browser — upload and serial monitor need Chrome or Edge.', 'warn');
  }
}

// ---------- Boot ----------
require.config({ paths: { vs: new URL('vendor/monaco/vs', document.baseURI).href } });
require(['vs/editor/editor.main'], () => {
  editor = monaco.editor.create($('editor'), {
    theme: 'vs-dark',
    automaticLayout: true,
    fontSize: 14,
    minimap: { enabled: false },
    tabSize: 2,
    scrollBeyondLastLine: false,
  });
  editor.onDidChangeCursorPosition(e => {
    $('cursorPos').textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyR, verify);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyU, upload);
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveProjects(); setStatus('Saved'); });
  wireUi();
  renderProjectSelect();
  renderTree();
  openFile(project().active);
  checkServer().then(() => loadBoards());
});

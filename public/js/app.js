import { flashAvr, readAvrSignature } from './avr.js';
import { importRepo } from './github.js';
import { allBoards, customBoards, saveCustomBoards, boardUrls, UPLOAD_METHODS, avrChipName } from './boards.js';
import { EXAMPLES, DEBUG_HEADER, DEFAULT_SKETCH } from './examples.js';
import { Plotter } from './plotter.js';
import { Debugger, parseSymbols } from './debugger.js';

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const store = {
  get(k, d) { try { const v = localStorage.getItem('webide.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) {
    try { localStorage.setItem('webide.' + k, JSON.stringify(v)); }
    catch { log('Could not save to browser storage (quota full?). Download your project as .zip.', 'err'); }
  },
};
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const fmtBytes = n => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

// ---------- Output / status ----------
function log(text, cls = '') {
  const out = $('output');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text.endsWith('\n') ? text : text + '\n';
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}
// A clickable action inside the Output log (for steps that need a fresh user click)
function logAction(text, label, fn) {
  const out = $('output');
  const span = document.createElement('span');
  span.className = 'info';
  span.textContent = text + ' ';
  const btn = document.createElement('button');
  btn.className = 'btn sm primary';
  btn.textContent = label;
  btn.onclick = () => { btn.disabled = true; fn(); };
  span.append(btn, '\n');
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

// ---------- Compile backends ----------
function apiBase() {
  let v = '';
  try { v = localStorage.getItem('webide.apiBase') || ''; } catch {}
  return (v || window.WEBIDE_CONFIG?.apiBase || '').replace(/\/+$/, '');
}
async function api(path, opts) {
  let r;
  try { r = await fetch(apiBase() + path, opts); } catch { throw new Error(`No compile server reachable at ${apiBase() || location.origin}`); }
  // Anything that is not JSON (e.g. a GitHub Pages 404 page) means there is no API here
  if (!(r.headers.get('content-type') || '').includes('application/json')) throw new Error(`No compile server at ${apiBase() || location.origin} (HTTP ${r.status})`);
  return r;
}

let serverOnline = false;
async function checkServer() {
  const el = $('serverStatus');
  el.textContent = '● Connecting…';
  const slow = setTimeout(() => (el.textContent = '● Waking up compile server…'), 4000);
  try {
    const r = await api('/api/health');
    serverOnline = r.ok;
  } catch {
    serverOnline = false;
  } finally {
    clearTimeout(slow);
  }
  renderBackendStatus();
  return serverOnline;
}

function ghBuild() {
  const get = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  return { repo: get('webide.ghBuildRepo') || window.WEBIDE_CONFIG?.buildRepo || '', token: get('webide.ghBuildToken') };
}

function renderBackendStatus() {
  const el = $('serverStatus');
  const gh = ghBuild();
  if (serverOnline) {
    el.textContent = '● Compile server';
    el.className = 'sb-item online';
  } else if (gh.token && gh.repo) {
    el.textContent = '● GitHub Actions';
    el.className = 'sb-item online';
    el.title = `Compiling on GitHub Actions (${gh.repo}). Click to change.`;
  } else {
    el.textContent = '● Compiling not set up';
    el.className = 'sb-item offline';
  }
}

function configureServer() {
  const dlg = $('backendDialog');
  const gh = ghBuild();
  $('ghBuildRepo').value = gh.repo;
  $('ghBuildToken').value = gh.token;
  try { $('serverUrl').value = localStorage.getItem('webide.apiBase') || ''; } catch {}
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') return;
    const set = (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} };
    set('webide.ghBuildRepo', $('ghBuildRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, ''));
    set('webide.ghBuildToken', $('ghBuildToken').value.trim());
    set('webide.apiBase', $('serverUrl').value.trim());
    checkServer().then(() => loadBoards());
  };
}

async function githubCompile(fqbn, files, options) {
  const { repo, token } = ghBuild();
  const gh = (path, opts = {}) => fetch(`https://api.github.com/repos/${repo}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...opts.headers },
  });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const gz = await new Response(new Blob([JSON.stringify({ files })]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const sketch = bytesToB64(new Uint8Array(gz));
  if (sketch.length > 60000) throw new Error('Sketch is too large for a GitHub Actions build (about 45 KB compressed at most).');

  const start = await gh('/actions/workflows/compile.yml/dispatches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { build_id: id, fqbn, sketch, options: JSON.stringify(options) } }),
  });
  if (!start.ok) {
    const msg = (await start.json().catch(() => ({}))).message || start.statusText;
    const hint = start.status === 401 ? 'The GitHub token is invalid or expired.'
      : start.status === 403 || start.status === 404 ? `The token cannot run workflows on ${repo}. Check the repository name and that the token has Actions and Contents set to "Read and write".`
      : start.status === 422 ? 'The repository\'s compile workflow is out of date; update your fork from hiibrarahmad/webide.'
      : '';
    throw new Error(`Could not start the GitHub build (${start.status} ${msg}). ${hint}`);
  }
  log(`Build queued on GitHub Actions (${repo})…`, 'info');

  const t0 = Date.now();
  let runUrl = null;
  for (let i = 0; ; i++) {
    await sleep(i < 4 ? 3000 : 4000);
    setStatus(`Compiling on GitHub Actions… ${Math.round((Date.now() - t0) / 1000)}s`);
    const res = await gh(`/contents/result.json?ref=ide-build/${id}`, { headers: { Accept: 'application/vnd.github.raw' } });
    if (res.ok) {
      const data = JSON.parse(await res.text());
      gh(`/git/refs/heads/ide-build/${id}`, { method: 'DELETE' }).catch(() => {});
      return data;
    }
    if (i % 3 === 2) {
      const runs = await gh('/actions/workflows/compile.yml/runs?event=workflow_dispatch&per_page=20').then(r => r.json()).catch(() => null);
      const run = runs?.workflow_runs?.find(r => r.display_title === `Compile ${id}`);
      if (run && !runUrl) {
        runUrl = run.html_url;
        log(`Follow the build: ${runUrl}`);
      }
      // The job publishes result.json even for sketch errors, so a failed job means the build itself broke
      if (run?.status === 'completed' && run.conclusion !== 'success') throw new Error(`The GitHub build job ${run.conclusion}: ${run.html_url}`);
    }
    if (Date.now() - t0 > 20 * 60 * 1000) throw new Error('Timed out waiting for the GitHub build' + (runUrl ? `: ${runUrl}` : ''));
  }
}

// ---------- Projects ----------
let projects = store.get('projects', null);
if (!projects || !Object.keys(projects).length) {
  projects = { blink: { name: 'Blink', files: { 'Blink.ino': DEFAULT_SKETCH }, open: ['Blink.ino'], active: 'Blink.ino' } };
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
  projects[id] = { name, files: { ...files }, open: active ? [active] : [], active };
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
  renderSketchLibs();
}

// ---------- Editor ----------
let editor = null;
const models = new Map();
let breakDecorations = null;

function languageFor(path) {
  if (/\.(ino|pde|c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(path)) return 'cpp';
  const map = { json: 'json', md: 'markdown', py: 'python', html: 'html', htm: 'html', js: 'javascript', css: 'css', yml: 'yaml', yaml: 'yaml' };
  return map[path.split('.').pop().toLowerCase()] || 'plaintext';
}

function getModel(path) {
  if (models.has(path)) return models.get(path);
  const uri = monaco.Uri.parse(`file:///${currentId}/${path.split('/').map(encodeURIComponent).join('/')}`);
  const model = monaco.editor.createModel(project().files[path] ?? '', languageFor(path), uri);
  let timer;
  model.onDidChangeContent(() => {
    project().files[path] = model.getValue();
    clearTimeout(timer);
    timer = setTimeout(() => { saveProjects(); if (path.endsWith('libraries.txt')) renderSketchLibs(); }, 400);
  });
  models.set(path, model);
  return model;
}

function disposeModels() {
  for (const m of models.values()) m.dispose();
  models.clear();
}

function openFile(path, line) {
  const p = project();
  if (!path || !(path in p.files)) path = p.open.find(f => f in p.files) || Object.keys(p.files)[0];
  $('emptyEditor').classList.toggle('hidden', !!path);
  if (!path) { editor?.setModel(null); p.active = null; renderTabs(); renderTree(); return; }
  if (!p.open.includes(path)) p.open.push(path);
  p.active = path;
  if (editor) {
    editor.setModel(getModel(path));
    if (line) {
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
    }
    editor.focus();
  }
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
    tab.innerHTML = '<span class="label"></span><span class="x" title="Close"><svg><use href="#i-x"/></svg></span>';
    tab.querySelector('.label').textContent = path.split('/').pop();
    tab.onclick = e => (e.target.closest('.x') ? closeFile(path) : openFile(path));
    el.appendChild(tab);
  }
}

// Find a project file from a name the board or compiler printed (often just the basename)
function resolveFile(name) {
  const files = Object.keys(project().files);
  const root = sketchRoot();
  const want = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const inRoot = root ? joinRoot(root.dir, want) : want;
  if (inRoot in project().files) return inRoot;
  if (want in project().files) return want;
  const base = want.split('/').pop();
  if (root && /\.ino$/.test(base)) {
    // The build renames the main sketch after its folder; map it back
    const sameDir = files.find(f => f === joinRoot(root.dir, base));
    if (sameDir) return sameDir;
    if (base === root.main.split('/').pop() || !files.some(f => f.endsWith('/' + base) || f === base)) return root.main;
  }
  return files.find(f => f.split('/').pop() === base) || null;
}

function openLocation(file, line) {
  const path = resolveFile(file);
  if (path) openFile(path, line);
}

// ---------- File tree ----------
const joinRoot = (dir, rel) => (dir ? dir + '/' + rel : rel);
function sketchRoot() {
  const p = project();
  const paths = Object.keys(p.files);
  const dirOf = f => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '');
  if (p.active?.endsWith('.ino')) return { dir: dirOf(p.active), main: p.active };
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
      li.style.paddingLeft = `${6 + i * 14}px`;
      li.innerHTML = '<svg class="ficon"><use href="#i-folder"/></svg><span class="name"></span>';
      li.querySelector('.name').textContent = parts[i];
      el.appendChild(li);
    }
    const li = document.createElement('li');
    li.className = (path === p.active ? 'active ' : '') + (root?.main === path ? 'sketch-main' : '');
    li.style.paddingLeft = `${6 + (parts.length - 1) * 14}px`;
    li.title = path;
    li.innerHTML = '<svg class="ficon"><use href="#i-files"/></svg><span class="name"></span><span class="ops"><button data-op="rename" title="Rename">✎</button><button data-op="delete" title="Delete">✕</button></span>';
    li.querySelector('.name').textContent = parts[parts.length - 1];
    li.onclick = e => {
      const op = e.target.closest('button')?.dataset.op;
      if (op === 'rename') renameFile(path);
      else if (op === 'delete') deleteFile(path);
      else openFile(path);
    };
    el.appendChild(li);
  }
}

const cleanPath = s => s.replace(/\\/g, '/').split('/').filter(x => x && x !== '.' && x !== '..').join('/');

function addFile(name, content = '') {
  const p = project();
  p.files[name] = content;
  models.get(name)?.setValue(content);
  saveProjects();
  renderTree();
  openFile(name);
}

function newFile() {
  const root = sketchRoot();
  const name = cleanPath(prompt('File name (use / for folders):', joinRoot(root?.dir || '', 'new.h')) || '');
  if (!name) return;
  if (name in project().files) return alert('A file with that name already exists');
  addFile(name);
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
  delete project().files[path];
  models.get(path)?.dispose();
  models.delete(path);
  saveProjects();
  closeFile(path);
  renderSketchLibs();
}

async function addLocalFiles(fileList) {
  let last = null;
  for (const f of fileList) {
    if (f.size > 1024 * 1024) { log(`Skipped ${f.name} (larger than 1 MB)`, 'warn'); continue; }
    const rel = cleanPath(f.webkitRelativePath || f.name);
    project().files[rel] = await f.text();
    models.get(rel)?.setValue(project().files[rel]);
    last = rel;
  }
  saveProjects();
  renderTree();
  if (last) openFile(last);
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function downloadZip() {
  const zip = new JSZip();
  const p = project();
  for (const [path, content] of Object.entries(p.files)) zip.file(`${p.name}/${path}`, content);
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${p.name}.zip`);
}

// ---------- Boards ----------
let boardList = [];          // [{ name, fqbn, group, options?, upload?, custom?, url? }]
let boardsFromServer = false;
let boardInfo = null;        // { options, upload }
let boardOpts = store.get('boardOpts', {});
const IMPORTANT_OPTS = /^(cpu|PartitionScheme|DebugLevel|CDCOnBoot|USBMode|FlashSize|UploadSpeed)$/;

async function loadBoards() {
  boardsFromServer = false;
  boardList = allBoards();
  if (serverOnline) {
    try {
      const boards = await (await api('/api/boards')).json();
      if (boards.error) throw new Error(boards.error);
      boardList = [...boards.map(b => ({ ...b, group: b.platform })), ...allBoards().filter(b => b.custom)];
      boardsFromServer = true;
    } catch (e) {
      log('Could not load boards from the compile server: ' + e.message, 'warn');
    }
  }
  const sel = $('boardSelect');
  sel.innerHTML = '';
  const groups = {};
  for (const b of boardList) (groups[b.group] ||= []).push(b);
  for (const [group, list] of Object.entries(groups)) {
    const og = document.createElement('optgroup');
    og.label = group;
    for (const b of list) og.appendChild(new Option(b.name, b.fqbn));
    sel.appendChild(og);
  }
  const saved = store.get('board', 'arduino:avr:uno');
  sel.value = boardList.some(b => b.fqbn === saved) ? saved : (boardList.find(b => b.fqbn === 'arduino:avr:uno') || boardList[0])?.fqbn;
  renderBoardList();
  await onBoardChange();
}

const currentBoard = () => boardList.find(b => b.fqbn === $('boardSelect').value);

function fullFqbn() {
  const base = $('boardSelect').value;
  if (!base) return '';
  const parts = Object.entries(boardOpts[base] || {}).map(([k, v]) => `${k}=${v}`);
  return parts.length ? `${base}:${parts.join(',')}` : base;
}

function selectedOpts(base, options) {
  const o = {};
  for (const opt of options) o[opt.option] = boardOpts[base]?.[opt.option] || opt.values.find(v => v.selected)?.value;
  return o;
}

function localDetails() {
  const base = $('boardSelect').value;
  const b = currentBoard();
  const options = b?.options || [];
  return { options, upload: b?.upload ? b.upload(selectedOpts(base, options)) : { method: 'download' } };
}

async function onBoardChange() {
  const base = $('boardSelect').value;
  store.set('board', base);
  const b = currentBoard();
  if (!boardsFromServer || b?.custom) {
    boardInfo = localDetails();
  } else {
    try {
      boardInfo = await (await api('/api/board?fqbn=' + encodeURIComponent(fullFqbn()))).json();
      if (boardInfo.error) throw new Error(boardInfo.error);
    } catch (e) {
      boardInfo = localDetails();
      log('Board details failed: ' + e.message, 'warn');
    }
  }
  const box = $('boardOptions');
  box.innerHTML = '';
  for (const opt of boardInfo.options || []) {
    if (!IMPORTANT_OPTS.test(opt.option)) continue;
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
  $('sbBoard').textContent = b?.name || base;
  $('btnEraseFlash').disabled = boardInfo.upload?.method !== 'esptool';
  renderBoardList();
}

async function refreshUploadInfo() {
  if (!boardsFromServer || currentBoard()?.custom) { boardInfo = localDetails(); return; }
  try {
    const info = await (await api('/api/board?fqbn=' + encodeURIComponent(fullFqbn()))).json();
    if (!info.error) boardInfo.upload = info.upload;
  } catch {}
}

function selectBoard(fqbn) {
  $('boardSelect').value = fqbn;
  onBoardChange();
}

function renderBoardList() {
  const ul = $('boardList');
  const q = $('boardQuery').value.trim().toLowerCase();
  const current = $('boardSelect').value;
  ul.innerHTML = '';
  const shown = boardList.filter(b => !q || b.name.toLowerCase().includes(q) || b.fqbn.toLowerCase().includes(q)).slice(0, 200);
  let group = null;
  for (const b of shown) {
    if (b.group !== group) {
      group = b.group;
      const g = document.createElement('li');
      g.className = 'group';
      g.textContent = group;
      ul.appendChild(g);
    }
    const li = document.createElement('li');
    li.className = b.fqbn === current ? 'selected' : '';
    li.innerHTML = '<b></b><span></span><span class="meta"></span>';
    li.querySelector('b').textContent = b.name;
    li.querySelector('.meta').textContent = b.fqbn;
    const actions = li.querySelector('span');
    if (b.custom) {
      const rm = document.createElement('button');
      rm.className = 'icon-btn sm';
      rm.title = 'Remove this board';
      rm.innerHTML = '<svg><use href="#i-trash"/></svg>';
      rm.onclick = e => {
        e.stopPropagation();
        saveCustomBoards(customBoards().filter(c => c.fqbn !== b.fqbn));
        loadBoards();
      };
      actions.appendChild(rm);
    }
    li.onclick = () => selectBoard(b.fqbn);
    ul.appendChild(li);
  }
  if (!shown.length) ul.innerHTML = '<li class="empty-row">No board matches. Use + to add it.</li>';
}

function addBoardDialog() {
  const dlg = $('boardDialog');
  const sel = $('nbMethod');
  if (!sel.options.length) for (const [k, v] of Object.entries(UPLOAD_METHODS)) sel.add(new Option(v, k));
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'save') return;
    const c = {
      name: $('nbName').value.trim(),
      fqbn: $('nbFqbn').value.trim(),
      url: $('nbUrl').value.trim(),
      method: $('nbMethod').value,
      speed: +$('nbSpeed').value || undefined,
    };
    if (!c.name || !/^[\w.-]+:[\w.-]+:[\w.-]+$/.test(c.fqbn)) return alert('Enter a name and a valid FQBN (vendor:architecture:board).');
    saveCustomBoards([...customBoards().filter(x => x.fqbn !== c.fqbn), c]);
    store.set('board', c.fqbn);
    loadBoards();
    log(`Added board ${c.name} (${c.fqbn}). Its core is installed on the first GitHub Actions build.`, 'ok');
  };
}

// ---------- Compile ----------
let lastBuild = null;
let symbols = [];
let busy = false;
let debugBuild = store.get('debugBuild', false);

function setBusy(b) {
  busy = b;
  $('btnVerify').disabled = b;
  $('btnUpload').disabled = b;
}

function setDebugBuild(on) {
  debugBuild = on;
  store.set('debugBuild', on);
  $('btnDebugBuild').setAttribute('aria-pressed', String(on));
  $('chkDebugBuild').checked = on;
  $('sbDebug').classList.toggle('hidden', !on);
}

function parseProblems(logText, root) {
  const problems = [];
  const re = /([^\s:"']+\.(?:ino|cpp|c|h|hpp|cc|S)):(\d+):(?:(\d+):)?\s+(fatal error|error|warning):\s+(.*)/g;
  for (const m of logText.matchAll(re)) {
    const path = resolveFile(m[1]);
    if (!path) continue;
    problems.push({ path, line: +m[2], col: +(m[3] || 1), severity: m[4] === 'warning' ? 'warning' : 'error', message: m[5] });
  }
  return problems;
}

function showProblems(problems) {
  for (const m of models.values()) monaco.editor.setModelMarkers(m, 'arduino', []);
  const byFile = {};
  for (const p of problems) {
    (byFile[p.path] ||= []).push({
      startLineNumber: p.line, endLineNumber: p.line, startColumn: p.col, endColumn: 1000, message: p.message,
      severity: p.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
    });
  }
  for (const [path, markers] of Object.entries(byFile)) monaco.editor.setModelMarkers(getModel(path), 'arduino', markers);

  const ul = $('problemList');
  ul.innerHTML = '';
  for (const p of problems) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="sev"></span><span class="msg"></span><span class="where"></span>';
    li.querySelector('.sev').textContent = p.severity.toUpperCase();
    li.querySelector('.sev').classList.add(p.severity);
    li.querySelector('.msg').textContent = p.message;
    li.querySelector('.where').textContent = `${p.path}:${p.line}:${p.col}`;
    li.onclick = () => openFile(p.path, p.line);
    ul.appendChild(li);
  }
  if (!problems.length) ul.innerHTML = '<li class="empty-row">No problems found.</li>';
  const errors = problems.filter(p => p.severity === 'error').length;
  const badge = $('problemCount');
  badge.textContent = problems.length;
  badge.className = 'badge ' + (errors ? 'err' : problems.length ? 'warn' : 'hidden');
}

function showBuildSummary(data, ok, seconds, backend) {
  const el = $('buildSummary');
  el.classList.remove('hidden');
  el.innerHTML = '';
  const state = document.createElement('span');
  state.className = 'state ' + (ok ? 'ok' : 'err');
  state.innerHTML = `<svg><use href="#i-${ok ? 'check' : 'x'}"/></svg>`;
  state.append(ok ? 'Build succeeded' : 'Build failed');
  el.appendChild(state);
  const sb = [];
  for (const m of data.memory || []) {
    if (!m.max) continue;
    const label = m.name === 'text' ? 'Flash' : m.name === 'data' ? 'RAM' : m.name;
    const pct = Math.round((m.size / m.max) * 100);
    const meter = document.createElement('span');
    meter.className = 'meter';
    meter.innerHTML = '<span></span><span class="bar"><i></i></span><span></span>';
    meter.children[0].textContent = label;
    const bar = meter.querySelector('i');
    bar.style.width = Math.min(pct, 100) + '%';
    bar.className = pct >= 90 ? 'high' : pct >= 75 ? 'mid' : '';
    meter.children[2].textContent = `${pct}%  ${fmtBytes(m.size)} / ${fmtBytes(m.max)}`;
    el.appendChild(meter);
    sb.push(`${label} ${pct}%`);
  }
  const facts = document.createElement('span');
  facts.className = 'facts';
  facts.textContent = [`${seconds.toFixed(1)}s on ${backend}`, data.binary ? `firmware ${fmtBytes(b64ToBytes(data.binary).length)}` : '', debugBuild ? 'debug build' : ''].filter(Boolean).join(' · ');
  el.appendChild(facts);
  $('sbMemory').textContent = sb.join(' · ');
}

async function compile() {
  const root = sketchRoot();
  showTab('output');
  $('output').textContent = '';
  if (!root) { log('No .ino file in this project.', 'err'); return null; }
  const prefix = root.dir ? root.dir + '/' : '';
  const files = Object.entries(project().files)
    .filter(([path]) => path.startsWith(prefix))
    .map(([path, content]) => ({ path: path.slice(prefix.length), content }));
  // The main sketch goes first so the build names the sketch folder after it
  const mainRel = root.main.slice(prefix.length);
  files.sort((a, b) => (a.path === mainRel ? -1 : b.path === mainRel ? 1 : 0));

  const fqbn = fullFqbn();
  if (!fqbn) { log('Pick a board first.', 'err'); return null; }
  log(`Compiling ${root.main} for ${fqbn}${debugBuild ? ' (debug build)' : ''}…`, 'info');
  setStatus('Compiling…');
  const t0 = performance.now();
  try {
    let data, ok, backend;
    if (!serverOnline && ghBuild().token && ghBuild().repo) {
      backend = 'GitHub Actions';
      data = await githubCompile(fqbn, files, { debug: debugBuild, urls: boardUrls(fqbn) });
      ok = !data.error;
    } else if (!serverOnline) {
      log('Compiling is not set up yet.', 'err');
      logAction('Add a GitHub token (free builds on GitHub Actions) or a compile server URL:', 'Open compile settings', configureServer);
      setStatus('No compile backend');
      return null;
    } else {
      backend = 'compile server';
      const res = await api('/api/compile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fqbn, files, debug: debugBuild }),
      });
      data = await res.json();
      ok = res.ok;
    }
    const seconds = (performance.now() - t0) / 1000;
    const out = data.log || '';
    const problems = parseProblems(out, root);
    showProblems(problems);
    showBuildSummary(data, ok, seconds, backend);
    if (!ok) {
      log(out, 'err');
      log(data.error || 'Compilation failed', 'err');
      setStatus('Compilation failed');
      if (problems[0]) openFile(problems[0].path, problems[0].line);
      return null;
    }
    log(out);
    log(`Done in ${seconds.toFixed(1)}s`, 'ok');
    setStatus('Compiled');
    lastBuild = data;
    symbols = parseSymbols(data.symbols);
    $('btnDownloadFw').disabled = false;
    return data;
  } catch (e) {
    log('Compile failed: ' + e.message, 'err');
    setStatus('Error');
    return null;
  }
}

async function verify() {
  if (busy) return;
  setBusy(true);
  try { await compile(); } finally { setBusy(false); }
}

function downloadFirmware() {
  if (lastBuild) downloadBlob(new Blob([b64ToBytes(lastBuild.binary)]), lastBuild.filename);
}

// ---------- Serial port ----------
const serial = { port: null, open: false, reader: null, loop: null, decoder: null };
const mon = { lines: [], partial: '', raw: [], rawLen: 0, hex: false, dirty: false, history: store.get('sendHistory', []), histIdx: -1 };

function portName(port) {
  const i = port.getInfo();
  const known = { 0x2341: 'Arduino', 0x2a03: 'Arduino', 0x1a86: 'CH340', 0x10c4: 'CP210x', 0x0403: 'FTDI', 0x303a: 'Espressif', 0x2e8a: 'Raspberry Pi' };
  return i.usbVendorId ? `${known[i.usbVendorId] || 'USB'} ${i.usbVendorId.toString(16).padStart(4, '0')}:${(i.usbProductId || 0).toString(16).padStart(4, '0')}` : 'Serial port';
}

function setPort(port) {
  serial.port = port;
  $('portLabel').textContent = port ? portName(port) : 'Select port';
  $('btnPort').classList.toggle('connected', !!port);
  $('sbPort').textContent = port ? portName(port) : 'No port';
}

async function selectPort() {
  if (!('serial' in navigator)) {
    alert('Web Serial is not available. Use Chrome or Edge on desktop, over https or localhost.');
    return null;
  }
  try {
    if (serial.open) await closeMonitor();
    setPort(await navigator.serial.requestPort());
    return serial.port;
  } catch {
    return null;
  }
}
const ensurePort = async () => serial.port || selectPort();

function monitorSystem(text) {
  mon.lines.push({ t: Date.now(), s: `[${text}]`, sys: true });
  scheduleMonitor();
}

function onSerialData(bytes) {
  mon.raw.push(bytes);
  mon.rawLen += bytes.length;
  while (mon.rawLen > 16384 && mon.raw.length > 1) mon.rawLen -= mon.raw.shift().length;
  const parts = (mon.partial + serial.decoder.decode(bytes, { stream: true })).split('\n');
  mon.partial = parts.pop();
  for (const raw of parts) {
    const line = raw.replace(/\r$/, '');
    const isDbg = dbg.handleLine(line);
    if (!isDbg) plotter.addLine(line);
    mon.lines.push({ t: Date.now(), s: line, dbg: isDbg });
  }
  if (mon.lines.length > 6000) mon.lines.splice(0, 1000);
  scheduleMonitor();
}

function scheduleMonitor() {
  if (mon.dirty) return;
  mon.dirty = true;
  requestAnimationFrame(renderMonitor);
}

function renderMonitor() {
  mon.dirty = false;
  if (activeTab !== 'serial') { mon.stale = true; return; }
  mon.stale = false;
  const out = $('serialOut');
  if (mon.hex) {
    const all = new Uint8Array(mon.rawLen);
    let o = 0;
    for (const c of mon.raw) { all.set(c, o); o += c.length; }
    const rows = [];
    for (let i = 0; i < all.length; i += 16) {
      const chunk = all.subarray(i, i + 16);
      const hex = [...chunk].map(b => b.toString(16).padStart(2, '0')).join(' ').padEnd(48);
      const ascii = [...chunk].map(b => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      rows.push(`${i.toString(16).padStart(6, '0')}  ${hex}  ${ascii}`);
    }
    out.textContent = rows.join('\n');
  } else {
    const filter = $('serialFilter').value.toLowerCase();
    const hideDbg = $('chkHideDbg').checked;
    const ts = $('chkTimestamp').checked;
    const lines = [];
    for (const l of mon.lines) {
      if (hideDbg && l.dbg) continue;
      if (filter && !l.s.toLowerCase().includes(filter)) continue;
      lines.push(ts ? `${new Date(l.t).toTimeString().slice(0, 8)}.${String(l.t % 1000).padStart(3, '0')}  ${l.s}` : l.s);
    }
    if (!filter && mon.partial) lines.push(mon.partial);
    out.textContent = lines.join('\n');
  }
  if ($('chkAutoscroll').checked) out.scrollTop = out.scrollHeight;
}

async function openMonitor() {
  const port = await ensurePort();
  if (!port) return;
  const baud = +$('baudSelect').value;
  try {
    await port.open({ baudRate: baud });
  } catch (e) {
    monitorSystem(`Could not open port: ${e.message}`);
    return;
  }
  serial.open = true;
  serial.decoder = new TextDecoder();
  $('btnSerial').lastElementChild.textContent = 'Disconnect';
  $('serialDot').classList.add('on');
  try { await port.setSignals({ dataTerminalReady: $('chkDtr').checked, requestToSend: $('chkRts').checked }); } catch {}
  monitorSystem(`Connected @ ${baud} baud`);
  serial.loop = (async () => {
    while (serial.open && port.readable) {
      serial.reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await serial.reader.read();
          if (done) break;
          onSerialData(value);
        }
      } catch (e) {
        if (serial.open) monitorSystem(`Read error: ${e.message}`);
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
  $('btnSerial').lastElementChild.textContent = 'Connect';
  $('serialDot').classList.remove('on');
  monitorSystem('Disconnected');
}

async function serialWrite(text) {
  if (!serial.open) { monitorSystem('Not connected'); return false; }
  const w = serial.port.writable.getWriter();
  try { await w.write(new TextEncoder().encode(text)); } finally { w.releaseLock(); }
  return true;
}

async function sendSerial() {
  const input = $('serialInput');
  const ending = $('lineEnding').value.replace('\\r', '\r').replace('\\n', '\n');
  if (!(await serialWrite(input.value + ending))) return;
  if (input.value && mon.history[0] !== input.value) {
    mon.history.unshift(input.value);
    mon.history.length = Math.min(mon.history.length, 50);
    store.set('sendHistory', mon.history);
  }
  mon.histIdx = -1;
  input.value = '';
}

// Runs fn with the port closed, then reopens the monitor if it was open
async function withPort(fn) {
  const port = await ensurePort();
  if (!port) { log('No port selected.', 'err'); return; }
  const wasOpen = serial.open;
  if (wasOpen) await closeMonitor();
  try { return await fn(port); } finally { if (wasOpen) await openMonitor(); }
}

async function resetBoard() {
  const esp = boardInfo?.upload?.method === 'esptool';
  const pulse = async port => {
    if (esp) {
      // ESP auto-reset circuit: RTS pulls EN low
      await port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await sleep(120);
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } else {
      // Arduino: a DTR edge resets through the auto-reset capacitor
      await port.setSignals({ dataTerminalReady: false, requestToSend: false });
      await sleep(120);
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    }
  };
  if (serial.open) { await pulse(serial.port); monitorSystem('Board reset'); return; }
  const port = await ensurePort();
  if (!port) return;
  await port.open({ baudRate: +$('baudSelect').value });
  try { await pulse(port); } finally { await port.close(); }
  log('Board reset', 'ok');
}

// ---------- Upload ----------
async function espLoader(port, speed) {
  const { ESPLoader, Transport } = await import(new URL('../vendor/esptool.js', import.meta.url).href);
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine: s => log(s), write: s => log(s) };
  const loader = new ESPLoader({ transport, baudrate: speed || 460800, romBaudrate: 115200, terminal });
  return { loader, transport };
}

async function flashEsp(port, build, upload) {
  const { loader, transport } = await espLoader(port, upload.speed);
  try {
    const chip = await loader.main();
    log(`Connected to ${chip}`, 'info');
    await loader.writeFlash({
      fileArray: [{ data: b64ToBytes(build.binary), address: upload.address ?? build.address ?? 0 }],
      flashMode: 'keep', flashFreq: 'keep', flashSize: 'keep',
      eraseAll: false, compress: true,
      reportProgress: (_i, written, total) => progress(written / total),
    });
    await loader.after('hard_reset');
  } finally {
    await transport.disconnect().catch(() => {});
  }
}

async function writeUf2(build) {
  const dir = await window.showDirectoryPicker({ id: 'uf2drive', mode: 'readwrite' });
  const fh = await dir.getFileHandle(build.filename, { create: true });
  const w = await fh.createWritable();
  await w.write(b64ToBytes(build.binary));
  await w.close();
  log(`Copied ${build.filename} to the board drive; the board restarts with the new firmware.`, 'ok');
}

async function flashUf2(build) {
  if (!('showDirectoryPicker' in window)) {
    downloadFirmware();
    log('Copy the downloaded .uf2 file onto the board\'s USB drive (RPI-RP2).', 'warn');
    return;
  }
  if (serial.port) {
    // 1200-baud "touch" asks a running RP2040 sketch to reboot into its USB drive
    try { await serial.port.open({ baudRate: 1200 }); await serial.port.close(); log('Asked the board to restart as a USB drive…'); await sleep(2500); } catch {}
  }
  logAction('Choose the board\'s USB drive (RPI-RP2). If it is missing, hold BOOTSEL while plugging the board in.', 'Choose drive', () =>
    writeUf2(build).catch(e => log('Copy failed: ' + e.message, 'err')));
}

async function upload() {
  if (busy) return;
  setBusy(true);
  const wasMonitoring = serial.open;
  let flashed = false;
  try {
    const build = await compile();
    if (!build) return;
    const info = boardInfo?.upload;
    if (build.format === 'uf2' || info?.method === 'uf2') { await flashUf2(build); return; }
    if (!info || info.method === 'download') {
      log(info?.note || 'This board cannot be flashed from the browser; the firmware is downloaded instead.', 'warn');
      downloadFirmware();
      return;
    }
    const port = await ensurePort();
    if (!port) { log('No port selected.', 'err'); return; }
    if (serial.open) await closeMonitor();
    dbg.reset();

    log(`Uploading via ${info.method}…`, 'info');
    setStatus('Uploading…');
    progress(0);
    if (info.method === 'esptool') await flashEsp(port, build, info);
    else await flashAvr(port, atob(build.binary), info, s => log(s), progress);
    flashed = true;
    log('Upload finished ✔', 'ok');
    setStatus('Uploaded');
  } catch (e) {
    log('Upload failed: ' + (e.message || e), 'err');
    if (/Failed to open serial port/i.test(e.message || '')) {
      log('The operating system refused to open the port. Check that:\n' +
        '  • the right port is selected, not COM1 or a Bluetooth port\n' +
        '  • no other program or tab has it open (Arduino IDE, another Web IDE tab)\n' +
        '  • the USB driver works: CH340 clones may need the older WCH driver 3.5 on Windows', 'warn');
    } else {
      log('Tip: check the board type and its options, press Reset on the board, then try again.', 'warn');
    }
    setStatus('Upload failed');
  } finally {
    progress(null);
    setBusy(false);
    // Reopen the monitor after a serial upload (always for debug builds, so the debugger is live)
    if (serial.port && (wasMonitoring || (flashed && debugBuild))) {
      await openMonitor();
      if (flashed && debugBuild) showTab('debug');
    }
  }
}

// ---------- Board tools ----------
async function chipInfo() {
  const info = boardInfo?.upload;
  showTab('output');
  $('output').textContent = '';
  try {
    await withPort(async port => {
      if (info?.method === 'esptool') {
        const { loader, transport } = await espLoader(port, 115200);
        try {
          const chip = await loader.main();
          log(`Chip: ${chip}`, 'ok');
          await loader.flashId();
          const size = await loader.detectFlashSize().catch(() => null);
          if (size) log(`Flash size: ${size}`, 'ok');
          await loader.after('hard_reset');
        } finally {
          await transport.disconnect().catch(() => {});
        }
      } else if (info?.method === 'stk500v1') {
        const sig = await readAvrSignature(port, info);
        log(`Signature: ${sig.match(/../g).join(' ')} → ${avrChipName(sig)}`, 'ok');
      } else {
        log('Chip info is available for ESP32/ESP8266 and Uno/Nano/Pro Mini boards.', 'warn');
      }
    });
  } catch (e) {
    log('Chip info failed: ' + e.message, 'err');
  }
}

async function eraseFlash() {
  if (boardInfo?.upload?.method !== 'esptool') return;
  if (!confirm('Erase the whole flash of the ESP board? The current program and stored data are removed.')) return;
  showTab('output');
  $('output').textContent = '';
  try {
    await withPort(async port => {
      const { loader, transport } = await espLoader(port, boardInfo.upload.speed);
      try {
        await loader.main();
        log('Erasing flash (can take 10–30 s)…', 'info');
        await loader.eraseFlash();
        log('Flash erased ✔', 'ok');
        await loader.after('hard_reset');
      } finally {
        await transport.disconnect().catch(() => {});
      }
    });
  } catch (e) {
    log('Erase failed: ' + e.message, 'err');
  }
}

// ---------- Debugger & plotter ----------
let plotter, dbg;

function onBreak(file, line) {
  $('pausedBanner').classList.remove('hidden');
  $('pausedText').textContent = `Paused at ${file}:${line}`;
  $('debugDot').className = 'dot paused';
  setStatus(`Paused at ${file}:${line}`);
  const path = resolveFile(file);
  if (path && editor) {
    openFile(path, line);
    breakDecorations?.clear();
    breakDecorations = editor.createDecorationsCollection([{
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: 'dbg-line', glyphMarginClassName: 'dbg-glyph' },
    }]);
    // The banner just shrank the editor; scroll again once the new size is applied
    setTimeout(() => { editor.layout(); editor.revealLineInCenter(line); }, 150);
  }
}

function onResume() {
  $('pausedBanner').classList.add('hidden');
  $('debugDot').className = 'dot on';
  breakDecorations?.clear();
  setStatus('Running');
}

function insertDebugHeader() {
  const root = sketchRoot();
  if (!root) return alert('Open a sketch first.');
  const path = joinRoot(root.dir, 'WebIDEDebug.h');
  project().files[path] = DEBUG_HEADER;
  models.get(path)?.setValue(DEBUG_HEADER);
  const main = getModel(root.main);
  if (!/#include\s+"WebIDEDebug\.h"/.test(main.getValue())) {
    main.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: '#include "WebIDEDebug.h"\n' }], () => null);
  }
  saveProjects();
  renderTree();
  setDebugBuild(true);
  openFile(root.main);
  log('Added WebIDEDebug.h and turned on Debug build. Use DBG_WATCH(x), DBG_BREAK() … in your code.', 'ok');
}

// ---------- Libraries ----------
let libIndex = null;

async function loadLibIndex() {
  if (libIndex) return libIndex;
  try {
    const r = await fetch('libraries.json');
    if (!r.ok) throw new Error(r.status);
    libIndex = (await r.json()).map(([name, version, author, sentence, category, arch]) => ({ name, version, author, sentence, category, arch, key: name.toLowerCase() }));
  } catch {
    libIndex = [];
  }
  return libIndex;
}

const libsPath = () => joinRoot(sketchRoot()?.dir || '', 'libraries.txt');
function sketchLibs() {
  return (project().files[libsPath()] || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
}

function writeSketchLibs(list) {
  const path = libsPath();
  const content = '# Libraries installed when this sketch is built: Library Manager names, git URLs or .zip links\n' + list.join('\n') + '\n';
  project().files[path] = content;
  models.get(path)?.setValue(content);
  saveProjects();
  renderTree();
  renderSketchLibs();
}

async function addLibrary(entry) {
  if (!sketchLibs().includes(entry)) writeSketchLibs([...sketchLibs(), entry]);
  log(`Added "${entry}" to ${libsPath()}`, 'ok');
  if (serverOnline && /^[\w .@+-]+$/.test(entry)) {
    const r = await (await api('/api/libs/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: entry }),
    })).json().catch(e => ({ error: e.message }));
    log(r.error ? `Server install failed: ${r.error}` : `Installed ${entry} on the compile server`, r.error ? 'warn' : 'ok');
  }
}

function renderSketchLibs() {
  const ul = $('libInstalled');
  const libs = sketchLibs();
  $('libCount').textContent = libs.length;
  ul.innerHTML = libs.length ? '' : '<li class="empty-row">No libraries yet</li>';
  for (const name of libs) {
    const li = document.createElement('li');
    li.innerHTML = '<b></b><button class="icon-btn sm" title="Remove"><svg><use href="#i-trash"/></svg></button>';
    li.querySelector('b').textContent = name;
    li.querySelector('button').onclick = () => writeSketchLibs(sketchLibs().filter(l => l !== name));
    ul.appendChild(li);
  }
}

async function searchLibs() {
  const q = $('libQuery').value.trim().toLowerCase();
  const ul = $('libResults');
  if (!q) { ul.innerHTML = ''; return; }
  let results = [];
  const index = await loadLibIndex();
  if (index.length) {
    const words = q.split(/\s+/);
    results = index
      .map(l => {
        const hay = `${l.key} ${l.sentence.toLowerCase()} ${l.author.toLowerCase()}`;
        if (!words.every(w => hay.includes(w))) return null;
        const score = (l.key === q ? 100 : 0) + (l.key.startsWith(q) ? 50 : 0) + (l.key.includes(q) ? 20 : 0);
        return { l, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.l.name.localeCompare(b.l.name))
      .slice(0, 60)
      .map(x => x.l);
  } else if (serverOnline) {
    results = await (await api('/api/libs/search?q=' + encodeURIComponent(q))).json().catch(() => []);
  }
  ul.innerHTML = results.length ? '' : '<li class="empty-row">No libraries found</li>';
  const have = new Set(sketchLibs());
  for (const l of results) {
    const li = document.createElement('li');
    li.innerHTML = '<b></b><button class="btn sm"></button><p></p><span class="meta"></span>';
    li.querySelector('b').textContent = l.name;
    li.querySelector('p').textContent = l.sentence || '';
    li.querySelector('.meta').textContent = [l.version && 'v' + l.version, l.author, l.category].filter(Boolean).join(' · ');
    const btn = li.querySelector('button');
    btn.textContent = have.has(l.name) ? 'Added' : 'Add';
    btn.disabled = have.has(l.name);
    btn.onclick = async () => { btn.disabled = true; btn.textContent = 'Added'; await addLibrary(l.name); };
    ul.appendChild(li);
  }
}

// ---------- Examples ----------
function renderExamples() {
  const ul = $('exampleList');
  for (const ex of EXAMPLES) {
    const li = document.createElement('li');
    li.innerHTML = '<b></b><button class="btn sm">Open</button><p></p>';
    li.querySelector('b').textContent = ex.name;
    li.querySelector('p').textContent = ex.desc;
    li.querySelector('button').onclick = () => {
      createProject(ex.name, ex.files);
      if (ex.name === 'Debugger') setDebugBuild(true);
      showView('files');
    };
    ul.appendChild(li);
  }
}

// ---------- GitHub import ----------
async function ghImport() {
  const status = $('ghStatus');
  const btn = $('btnGhImport');
  const token = $('ghToken').value.trim();
  status.className = 'status';
  btn.disabled = true;
  try {
    const { name, files, source } = await importRepo($('ghUrl').value, token, s => (status.textContent = s));
    createProject(name, files);
    status.textContent = `Imported ${Object.keys(files).length} files from ${source}`;
    store.set('ghLast', $('ghUrl').value);
    if (!sketchRoot()) log('The imported project has no .ino file; add one or link to a sketch folder.', 'warn');
    showView('files');
  } catch (e) {
    status.className = 'status err';
    status.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- Layout ----------
let activeTab = 'output';
function showTab(name) {
  activeTab = name;
  document.querySelectorAll('.panel-tabs [data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-body').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  plotter.visible = name === 'plotter';
  plotter.dirty = true;
  if (name === 'serial' && mon.stale) scheduleMonitor();
}

function showView(name) {
  const wb = document.querySelector('.workbench');
  const btn = document.querySelector(`.activitybar [data-view="${name}"]`);
  if (btn.classList.contains('active') && !wb.classList.contains('side-hidden') && name === store.get('view')) {
    wb.classList.add('side-hidden');
    return;
  }
  wb.classList.remove('side-hidden');
  document.querySelectorAll('.activitybar [data-view]').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.sidebar .view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  store.set('view', name);
  if (name === 'libs') { renderSketchLibs(); loadLibIndex(); }
  if (name === 'boards') renderBoardList();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('theme', theme);
  $('btnTheme').querySelector('use').setAttribute('href', theme === 'light' ? '#i-moon' : '#i-sun');
  if (window.monaco) monaco.editor.setTheme(theme === 'light' ? 'webide-light' : 'webide-dark');
  if (plotter) plotter.dirty = true;
}

function setupResizers() {
  const root = document.documentElement.style;
  const side = store.get('sideW', 290), panel = store.get('panelH', 270);
  root.setProperty('--side-w', side + 'px');
  root.setProperty('--panel-h', panel + 'px');
  const drag = (handle, onMove, onEnd) => {
    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      document.body.classList.add('resizing');
      const move = ev => onMove(ev);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.classList.remove('dragging');
        document.body.classList.remove('resizing');
        onEnd();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  };
  let w = side, h = panel;
  drag($('sideResizer'), e => {
    const left = $('sidebar').getBoundingClientRect().left;
    w = Math.max(200, Math.min(640, e.clientX - left));
    root.setProperty('--side-w', w + 'px');
  }, () => store.set('sideW', w));
  drag($('bottomResizer'), e => {
    const main = document.querySelector('.main').getBoundingClientRect();
    h = Math.max(80, Math.min(main.height - 120, main.bottom - e.clientY));
    root.setProperty('--panel-h', h + 'px');
    $('panel').classList.remove('max');
  }, () => store.set('panelH', h));
}

// ---------- Wiring ----------
function wireUi() {
  document.querySelectorAll('.activitybar [data-view]').forEach(b => (b.onclick = () => showView(b.dataset.view)));
  document.querySelectorAll('.panel-tabs [data-tab]').forEach(b => (b.onclick = () => showTab(b.dataset.tab)));
  $('btnPanelMax').onclick = () => $('panel').classList.toggle('max');

  $('btnVerify').onclick = verify;
  $('btnUpload').onclick = upload;
  $('btnDebugBuild').onclick = () => setDebugBuild(!debugBuild);
  $('chkDebugBuild').onchange = e => setDebugBuild(e.target.checked);
  $('btnPort').onclick = selectPort;
  $('btnDownloadFw').onclick = downloadFirmware;
  $('btnTheme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  $('btnSettings').onclick = $('btnSettings2').onclick = $('serverStatus').onclick = configureServer;
  $('boardSelect').onchange = onBoardChange;
  $('boardQuery').oninput = renderBoardList;
  $('btnAddBoard').onclick = addBoardDialog;

  $('projectSelect').onchange = e => switchProject(e.target.value);
  $('btnProjectMenu').onclick = e => { e.stopPropagation(); $('projectMenu').classList.toggle('hidden'); };
  document.addEventListener('click', () => $('projectMenu').classList.add('hidden'));
  $('projectMenu').onclick = e => {
    const act = e.target.dataset.act;
    if (act === 'new') {
      const name = prompt('Project name:', 'MySketch')?.trim();
      if (name) createProject(name, { [`${name.replace(/[^\w-]/g, '_')}.ino`]: 'void setup() {\n  Serial.begin(115200);\n}\n\nvoid loop() {\n  \n}\n' });
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
  $('ghUrl').onkeydown = e => e.key === 'Enter' && ghImport();

  let libTimer;
  $('libQuery').oninput = () => { clearTimeout(libTimer); libTimer = setTimeout(searchLibs, 200); };
  $('btnLibUrl').onclick = () => {
    const url = $('libUrl').value.trim();
    if (!/^https:\/\/\S+$/.test(url)) return alert('Enter an https:// git URL or .zip link');
    addLibrary(url);
    $('libUrl').value = '';
  };

  // Serial monitor
  $('btnSerial').onclick = () => (serial.open ? closeMonitor() : openMonitor());
  $('baudSelect').value = store.get('baud', '115200');
  $('baudSelect').onchange = async () => {
    store.set('baud', $('baudSelect').value);
    if (serial.open) { await closeMonitor(); await openMonitor(); }
  };
  $('btnSerialClear').onclick = () => { mon.lines = []; mon.partial = ''; mon.raw = []; mon.rawLen = 0; scheduleMonitor(); };
  $('btnSerialSave').onclick = () => {
    const text = mon.lines.map(l => `${new Date(l.t).toISOString()}  ${l.s}`).join('\n');
    downloadBlob(new Blob([text], { type: 'text/plain' }), `serial-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`);
  };
  $('btnSerialSend').onclick = sendSerial;
  $('serialInput').onkeydown = e => {
    if (e.key === 'Enter') sendSerial();
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      mon.histIdx = Math.max(-1, Math.min(mon.history.length - 1, mon.histIdx + (e.key === 'ArrowUp' ? 1 : -1)));
      $('serialInput').value = mon.histIdx < 0 ? '' : mon.history[mon.histIdx];
    }
  };
  for (const id of ['serialFilter', 'chkTimestamp', 'chkHideDbg']) $(id).addEventListener('input', scheduleMonitor);
  $('viewText').onclick = () => { mon.hex = false; $('viewText').classList.add('active'); $('viewHex').classList.remove('active'); scheduleMonitor(); };
  $('viewHex').onclick = () => { mon.hex = true; $('viewHex').classList.add('active'); $('viewText').classList.remove('active'); scheduleMonitor(); };
  const signals = async () => {
    if (serial.open) await serial.port.setSignals({ dataTerminalReady: $('chkDtr').checked, requestToSend: $('chkRts').checked }).catch(() => {});
  };
  $('chkDtr').onchange = signals;
  $('chkRts').onchange = signals;

  // Plotter
  $('btnPlotClear').onclick = () => plotter.clear();
  $('btnPlotPause').onclick = () => {
    plotter.paused = !plotter.paused;
    $('btnPlotPause').querySelector('use').setAttribute('href', plotter.paused ? '#i-play' : '#i-pause');
    $('btnPlotPause').title = plotter.paused ? 'Resume' : 'Pause';
  };
  $('plotPoints').onchange = e => { plotter.maxPoints = +e.target.value; plotter.dirty = true; };

  // Debug
  $('btnDbgClear').onclick = () => dbg.reset();
  $('btnBannerContinue').onclick = () => dbg.resume('c');
  $('btnBannerRun').onclick = () => dbg.resume('r');
  $('btnInsertDebug').onclick = insertDebugHeader;
  $('btnOpenDebugExample').onclick = () => { const ex = EXAMPLES.find(e => e.name === 'Debugger'); createProject(ex.name, ex.files); setDebugBuild(true); showView('files'); };
  $('btnChipInfo').onclick = chipInfo;
  $('btnResetBoard').onclick = () => resetBoard().catch(e => log('Reset failed: ' + e.message, 'err'));
  $('btnEraseFlash').onclick = eraseFlash;
  $('btnOpenMonitor').onclick = () => { showTab('serial'); if (!serial.open) openMonitor(); };

  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'r') { e.preventDefault(); verify(); }
    else if (k === 'u') { e.preventDefault(); upload(); }
    else if (k === 's') { e.preventDefault(); saveProjects(); setStatus('Saved'); }
    else if (k === 'b') { e.preventDefault(); document.querySelector('.workbench').classList.toggle('side-hidden'); }
    else if (k === 'j') { e.preventDefault(); $('panel').classList.toggle('hidden'); }
  });

  if ('serial' in navigator) {
    // Prefer USB ports; built-in COM ports and Bluetooth ports are usually not the board
    navigator.serial.getPorts().then(ports => {
      const usb = ports.find(p => p.getInfo().usbVendorId);
      if (usb && !serial.port) setPort(usb);
    });
    navigator.serial.addEventListener('disconnect', e => {
      if (e.target !== serial.port) return;
      serial.open = false;
      $('serialDot').classList.remove('on');
      $('btnSerial').lastElementChild.textContent = 'Connect';
      setPort(null);
      monitorSystem('Board disconnected');
    });
  } else {
    log('Web Serial is not supported in this browser: uploading and the serial monitor need Chrome or Edge on desktop.', 'warn');
  }
}

// ---------- Boot ----------
plotter = new Plotter($('plotCanvas'), $('plotLegend'));
dbg = new Debugger(
  { state: $('dbgState'), continueBtn: $('btnDbgContinue'), runBtn: $('btnDbgRun'), watches: $('dbgWatches'), events: $('dbgEvents') },
  {
    send: ch => serialWrite(ch),
    onBreak, onResume,
    plot: (name, value) => plotter.push(name, value),
    symbols: () => symbols,
    openLocation,
  },
);
setPort(null);
setDebugBuild(debugBuild);
setupResizers();
renderExamples();

require.config({ paths: { vs: new URL('vendor/monaco/vs', document.baseURI).href } });
require(['vs/editor/editor.main'], () => {
  monaco.editor.defineTheme('webide-dark', {
    base: 'vs-dark', inherit: true, rules: [],
    colors: { 'editor.background': '#0f1115', 'editorGutter.background': '#0f1115', 'editor.lineHighlightBackground': '#1b1f2a' },
  });
  monaco.editor.defineTheme('webide-light', { base: 'vs', inherit: true, rules: [], colors: { 'editor.background': '#ffffff' } });
  const theme = store.get('theme', matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  editor = monaco.editor.create($('editor'), {
    theme: theme === 'light' ? 'webide-light' : 'webide-dark',
    automaticLayout: true,
    fontSize: 14,
    fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, monospace',
    fontLigatures: true,
    minimap: { enabled: true, scale: 1, renderCharacters: false },
    glyphMargin: true,
    tabSize: 2,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    bracketPairColorization: { enabled: true },
    padding: { top: 8 },
  });
  applyTheme(theme);
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
  renderSketchLibs();
  const view = store.get('view', 'files');
  store.set('view', null);
  showView(view);
  showTab('output');
  checkServer().then(() => loadBoards());
});

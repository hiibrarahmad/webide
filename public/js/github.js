// Import source files from a GitHub repository (public, or private with a token).

const TEXT_EXT = /\.(ino|pde|c|cc|cpp|cxx|h|hh|hpp|hxx|s|S|txt|md|json|properties|ya?ml|csv|html?|css|js|py|ini|cfg|conf)$/i;
const MAX_FILES = 300;
const MAX_SIZE = 512 * 1024;

export function parseRepoUrl(input) {
  const s = input.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  let m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.*))?)?$/);
  if (!m) m = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error('Not a GitHub repository URL');
  return { owner: m[1], repo: m[2], ref: m[3] || null, subpath: m[4] || '' };
}

export async function importRepo(input, token, onStatus = () => {}) {
  const { owner, repo, ref: refIn, subpath } = parseRepoUrl(input);
  const headers = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const api = async url => {
    const r = await fetch(`https://api.github.com${url}`, { headers });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0')
        throw new Error('GitHub API rate limit reached. Add a token and retry.');
      throw new Error(`GitHub: ${body.message || r.statusText} (${r.status})`);
    }
    return r.json();
  };

  onStatus(`Reading ${owner}/${repo}…`);
  const info = await api(`/repos/${owner}/${repo}`);
  const ref = refIn || info.default_branch;
  const tree = await api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);

  // A blob link (…/blob/main/foo.ino) imports the containing folder
  let base = subpath;
  if (base && tree.tree.some(t => t.type === 'blob' && t.path === base)) base = base.split('/').slice(0, -1).join('/');
  const prefix = base ? base + '/' : '';

  const blobs = tree.tree.filter(t =>
    t.type === 'blob' && t.path.startsWith(prefix) && TEXT_EXT.test(t.path) && t.size <= MAX_SIZE);
  if (!blobs.length) throw new Error('No source files found at that location');
  if (blobs.length > MAX_FILES) throw new Error(`Too many files (${blobs.length}); link to the sketch folder instead`);

  const files = {};
  let done = 0;
  const fetchOne = async b => {
    let text;
    if (token) {
      const blob = await api(`/repos/${owner}/${repo}/git/blobs/${b.sha}`);
      const bin = atob(blob.content.replace(/\n/g, ''));
      text = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    } else {
      const path = b.path.split('/').map(encodeURIComponent).join('/');
      const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${path}`);
      if (!r.ok) throw new Error(`Failed to fetch ${b.path}`);
      text = await r.text();
    }
    files[b.path.slice(prefix.length)] = text;
    onStatus(`Downloaded ${++done}/${blobs.length} files`);
  };
  // Small concurrency pool
  const queue = [...blobs];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) await fetchOne(queue.shift());
  }));

  const name = base ? base.split('/').pop() : repo;
  return { name, files, source: `https://github.com/${owner}/${repo}/tree/${ref}/${base}` };
}

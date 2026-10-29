// serve.mjs: the dev server.   node tools/serve.mjs [port] [dir]      (npm start)
// A plain static server, with two things Python's http.server does not do and a module-based page needs:
//  1. Cache-Control: no-cache and an ETag on everything, so the browser asks again on every load (a 304 when nothing changed) instead of reusing an old copy for hours.
//  2. In every HTML page it stamps each module under src/ with its modification time (an import-map entry per file, and the main script tag): a changed module has a new
//     URL, so a browser can never run a new main.js next to an old cached level.js. That mismatch ("does not provide an export named ...") leaves the page stuck on
//     "Loading renderer..." with nothing on screen to say why.
// Binds to 127.0.0.1 only and never serves outside the directory.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[3] || new URL('..', import.meta.url).pathname), PORT = +process.argv[2] || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.fbx': 'application/octet-stream', '.obj': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.wasm': 'application/wasm',
};

// "/src/level.js" -> "/src/level.js?v=<mtime>" for every module in src/
function stamps() {
  const out = {}, dir = path.join(ROOT, 'src');
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) out[`/src/${f}`] = `/src/${f}?v=${Math.round(fs.statSync(path.join(dir, f)).mtimeMs).toString(36)}`;
  return out;
}
function stampHtml(html) {
  const map = stamps();
  html = html.replace(/(<script\s+type="importmap"\s*>)([\s\S]*?)(<\/script>)/, (all, open, json, close) => {
    try { const m = JSON.parse(json); m.imports = { ...m.imports, ...map }; return open + JSON.stringify(m, null, 1) + close; } catch { return all; } // an import map we cannot read is left alone
  });
  return html.replace(/(src=")(?:\.\/|\/)?(src\/[\w.-]+\.js)(")/g, (all, a, file, c) => (map['/' + file] ? a + map['/' + file] + c : all));
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), rel = decodeURIComponent(url.pathname);
  let file = path.join(ROOT, rel.endsWith('/') ? rel + 'index.html' : rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); try { st = fs.statSync(file); } catch { err = true; } }
    if (err || !st.isFile()) { res.writeHead(404, { 'Cache-Control': 'no-cache' }); return res.end('not found'); }
    const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', html = type.startsWith('text/html');
    const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Last-Modified': st.mtime.toUTCString() };
    if (html) { // pages are rebuilt on every request (they carry the stamps) and never validated against an ETag
      const body = stampHtml(fs.readFileSync(file, 'utf8'));
      res.writeHead(200, { ...headers, 'Content-Length': Buffer.byteLength(body) });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
    const etag = `W/"${st.size}-${Math.round(st.mtimeMs).toString(36)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ...headers, ETag: etag }); return res.end(); }
    res.writeHead(200, { ...headers, ETag: etag, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}/`));

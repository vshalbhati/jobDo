// A static file server for local development, with no dependencies. In
// production the contents of public/ go to a static host instead.
//
//   node serve.js            serves ./public on http://localhost:4173
//   PORT=5000 node serve.js
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const port = Number(process.env.PORT) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  // Resolve inside root and reject anything that climbs out of it.
  const file = path.join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let stat;
  try {
    stat = statSync(file);
    if (stat.isDirectory()) throw new Error('directory');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache'
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log('Frontend on http://localhost:' + port + '/');
  console.log('Expecting the API on http://localhost:8787 (see public/config.js)');
});

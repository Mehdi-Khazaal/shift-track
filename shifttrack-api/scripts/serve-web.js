// Static server for the frontend during local development.
//
// Serves the repo root on :5500. That port matters: assets/js/{admin,index}.js
// switch their API base to http://localhost:3000 whenever the page is served
// from localhost, and the API's default CORS allowlist already includes
// http://localhost:5500 (server.js).
//
// Deliberately dependency-free so the sandbox works offline.
'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..'); // repo root, above shifttrack-api
const PORT = Number(process.env.WEB_PORT) || 5500;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);

  // Never serve outside the repo, and never hand out env files or .git.
  if (!file.startsWith(ROOT) || /(^|[\\/])(\.env|\.git)/.test(rel)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store', // always serve the edit you just made
    });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`\n  Frontend  http://localhost:${PORT}/index.html   (employee)`);
  console.log(`            http://localhost:${PORT}/admin.html   (admin)`);
  console.log(`  Serving   ${ROOT}`);
  console.log(`  API       expects the local API on :3000  (npm run dev:local)\n`);
});

#!/usr/bin/env node
/**
 * Minimal static preview server for dist/ (local testing only).
 *   node scripts/serve.js [port]
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const port = parseInt(process.argv[2], 10) || 4173;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf'
};

http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (err) {
    res.writeHead(400); res.end('Bad request'); return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = path.normalize(path.join(DIST, pathname));
  if (file !== DIST && !file.startsWith(DIST + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(DIST, '404.html'), (err404, page) => {
        res.writeHead(404, { 'Content-Type': TYPES['.html'] });
        res.end(err404 ? 'Not found' : page);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => {
  console.log('VaultParse preview: http://127.0.0.1:' + port + '/');
});

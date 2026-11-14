#!/usr/bin/env node
/**
 * Submit every URL in dist/sitemap.xml to IndexNow (Bing, Yandex, Seznam,
 * Naver and other participating engines) in one request.
 *
 *   node scripts/ping_indexnow.js            submit
 *   node scripts/ping_indexnow.js --dry-run  print the payload only
 *
 * Non-blocking by design: any failure is reported and the process still
 * exits 0, so a search-engine hiccup can never fail a deployment.
 * Set INDEXNOW_SKIP=1 to disable.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

function finish(message) {
  console.log('[indexnow] ' + message);
  process.exit(0);
}

function main() {
  if (process.env.INDEXNOW_SKIP === '1') return finish('skipped (INDEXNOW_SKIP=1).');

  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'app.config.json'), 'utf8'));
  const key = config.indexNow && config.indexNow.key;
  const endpoint = new URL((config.indexNow && config.indexNow.endpoint) || 'https://api.indexnow.org/indexnow');
  if (!key) return finish('no key configured; nothing sent.');

  const sitemapPath = path.join(ROOT, 'dist', 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return finish('dist/sitemap.xml not found; run "npm run build" first.');

  const xml = fs.readFileSync(sitemapPath, 'utf8');
  const urls = [];
  const re = /<loc>([^<]+)<\/loc>/g;
  let m;
  while ((m = re.exec(xml))) {
    urls.push(m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim());
  }
  if (!urls.length) return finish('sitemap has no URLs; nothing sent.');

  const first = new URL(urls[0]);
  if (/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(first.hostname)) return finish('site URL is local (' + first.hostname + '); nothing sent.');

  const base = first.origin + first.pathname.replace(/[^/]*$/, '');
  const payload = {
    host: first.host,
    key,
    keyLocation: base + key + '.txt',
    urlList: urls.slice(0, 10000)
  };

  if (dryRun) {
    console.log(JSON.stringify(Object.assign({}, payload, { urlList: payload.urlList.slice(0, 3).concat(['... ' + payload.urlList.length + ' urls total']) }), null, 2));
    return finish('dry run; nothing sent.');
  }

  const body = JSON.stringify(payload);
  const request = https.request({
    method: 'POST',
    hostname: endpoint.hostname,
    path: endpoint.pathname + endpoint.search,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'indexnow-submitter/1.0'
    },
    timeout: 15000
  }, (response) => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { text += chunk; });
    response.on('end', () => {
      const code = response.statusCode;
      const meaning = {
        200: 'accepted',
        202: 'accepted; key validation pending (the key file must be live at ' + payload.keyLocation + ')',
        400: 'bad request (invalid format)',
        403: 'key not valid: the key file was not found at ' + payload.keyLocation + ' (it appears after the first deployment)',
        422: 'URLs do not belong to the host or the key does not match',
        429: 'too many requests; try again later'
      }[code] || 'unexpected response';
      finish('HTTP ' + code + ' — ' + meaning + '. Submitted ' + payload.urlList.length + ' URLs for ' + payload.host + '.' + (text && code >= 400 ? ' ' + text.slice(0, 200) : ''));
    });
  });
  request.on('timeout', () => { request.destroy(new Error('request timed out')); });
  request.on('error', (err) => finish('request failed (' + err.message + '); continuing without blocking.'));
  request.end(body);
}

try {
  main();
} catch (err) {
  finish('error (' + err.message + '); continuing without blocking.');
}

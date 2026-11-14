/*!
 * VaultParse — app.js
 * UI state controller: file intake + batch limiter, instant demo documents,
 * editable data grid, live JSON/CSV inspector, exports, offline license check,
 * custom regex templates, embed snippet and live privacy telemetry.
 *
 * The first half (SHA-256, License, Samples) is environment-neutral so the
 * Node test-suite and the license generator can load this same file.
 */
(function (root) {
  'use strict';

  /* ================================================================== *
   * SHA-256 (pure JS, synchronous — works on file:// and inside iframes)
   * ================================================================== */

  var SHA_K = (function () {
    var k = [], n = 2;
    while (k.length < 64) {
      var prime = true;
      for (var d = 2; d * d <= n; d++) { if (n % d === 0) { prime = false; break; } }
      if (prime) k.push(((Math.cbrt(n) % 1) * 4294967296) | 0);
      n++;
    }
    return k;
  })();

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i++; }
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256Bytes(str) {
    var p = utf8Bytes(String(str));
    var bitLen = p.length * 8;
    p.push(0x80);
    while (p.length % 64 !== 56) p.push(0);
    var hi = Math.floor(bitLen / 4294967296), lo = bitLen >>> 0;
    p.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var w = new Array(64);
    for (var off = 0; off < p.length; off += 64) {
      var t;
      for (t = 0; t < 16; t++) {
        var j = off + t * 4;
        w[t] = (p[j] << 24) | (p[j + 1] << 16) | (p[j + 2] << 8) | p[j + 3];
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        var s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + SHA_K[t] + w[t]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    var out = [];
    for (var i = 0; i < 8; i++) out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
    return out;
  }

  function sha256Hex(str) {
    return sha256Bytes(str).map(function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }

  /* ================================================================== *
   * Offline license keys:  VP-XXXXX-XXXXX-XXXXX-CCCCC
   * The last group is a SHA-256 checksum of the first three plus a salt.
   * ================================================================== */

  var License = {
    ALPHABET: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    PATTERN: /^VP-([A-HJ-NP-Z2-9]{5})-([A-HJ-NP-Z2-9]{5})-([A-HJ-NP-Z2-9]{5})-([A-HJ-NP-Z2-9]{5})$/,
    normalize: function (key) {
      return String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^VP/, '')
        .replace(/(.{5})(?=.)/g, '$1-').replace(/^/, 'VP-');
    },
    checksum: function (payload, salt) {
      var bytes = sha256Bytes(String(salt) + ':' + payload);
      var out = '';
      for (var i = 0; i < 5; i++) out += License.ALPHABET.charAt(bytes[i] % 32);
      return out;
    },
    verify: function (key, salt) {
      var normalized = License.normalize(key);
      var m = License.PATTERN.exec(normalized);
      if (!m) return false;
      return License.checksum(m[1] + '-' + m[2] + '-' + m[3], salt) === m[4];
    },
    /** randomBytes: function(n) -> array-like of n random bytes. */
    generate: function (salt, randomBytes) {
      var bytes = randomBytes(15);
      var groups = [];
      for (var g = 0; g < 3; g++) {
        var part = '';
        for (var i = 0; i < 5; i++) part += License.ALPHABET.charAt(bytes[g * 5 + i] % 32);
        groups.push(part);
      }
      var payload = groups.join('-');
      return 'VP-' + payload + '-' + License.checksum(payload, salt);
    }
  };

  /* ================================================================== *
   * Demo documents: positioned text items, exactly as pdf.js would emit
   * them, so the sample runs through the real row-reconstruction + parser.
   * ================================================================== */

  var Samples = (function () {
    var CHAR = 5.1, SIZE = 10;

    function build(lines) {
      var items = [];
      lines.forEach(function (line) {
        var y = line[0];
        line[1].forEach(function (cell) {
          var str = cell[1];
          var w = str.length * CHAR;
          items.push({ str: str, x: cell[2] === 'R' ? cell[0] - w : cell[0], y: y, w: w, h: SIZE });
        });
      });
      return items;
    }

    function invoiceItems() {
      var lines = [
        [790, [[40, 'Northwind Cloud Services Ltd'], [555, 'INVOICE', 'R']]],
        [776, [[40, '221 Harbour Street, Dublin 2, Ireland']]],
        [762, [[40, 'VAT No: IE6388047V']]],
        [730, [[40, 'Bill To:'], [360, 'Invoice Number:'], [555, 'INV-2026-0418', 'R']]],
        [716, [[40, 'Atlas Freight Logistics LLC'], [360, 'Invoice Date:'], [555, '03 Nov 2026', 'R']]],
        [702, [[40, '88 Mercer Avenue, Austin, TX 78701'], [360, 'Due Date:'], [555, '03 Dec 2026', 'R']]],
        [688, [[360, 'Currency:'], [555, 'USD', 'R']]],
        [650, [[40, 'Description'], [330, 'Qty', 'R'], [430, 'Unit Price', 'R'], [555, 'Amount', 'R']]]
      ];
      var rows = [
        ['Compute instances \u2014 m5.large (us-east-1)', '1,488', '0.096', '142.85'],
        ['Managed PostgreSQL \u2014 2 vCPU / 8 GB', '1', '185.00', '185.00'],
        ['Object storage (GB-month)', '2,150', '0.023', '49.45'],
        ['Outbound data transfer (GB)', '940', '0.09', '84.60'],
        ['Load balancer hours', '744', '0.025', '18.60'],
        ['Premium support plan', '1', '250.00', '250.00'],
        ['Promotional credit \u2014 annual commitment', '1', '(75.00)', '(75.00)']
      ];
      var y = 632;
      rows.forEach(function (r) {
        lines.push([y, [[40, r[0]], [330, r[1], 'R'], [430, r[2], 'R'], [555, r[3], 'R']]]);
        y -= 16;
      });
      lines.push([y - 10, [[430, 'Subtotal', 'R'], [555, '655.50', 'R']]]);
      lines.push([y - 26, [[430, 'Sales Tax (8.25%)', 'R'], [555, '54.08', 'R']]]);
      lines.push([y - 42, [[430, 'Total Due', 'R'], [555, '$709.58', 'R']]]);
      lines.push([y - 84, [[40, 'Payment terms: Net 30. Please quote the invoice number with your transfer.']]]);
      lines.push([y - 98, [[40, 'Bank transfer: IBAN IE29 AIBK 9311 5212 3456 78']]]);
      return build(lines);
    }

    function statementItems() {
      var lines = [
        [792, [[40, 'Meridian Community Bank'], [555, 'STATEMENT OF ACCOUNT', 'R']]],
        [778, [[40, '14 Castle Quay, Bristol BS1 4DJ']]],
        [750, [[40, 'Account Holder: Halden Design Ltd'], [320, 'Statement Period: 01 Oct 2026 \u2013 31 Oct 2026']]],
        [736, [[40, 'Account Number: ****4821'], [320, 'Sort Code: 40-11-62']]],
        [722, [[40, 'IBAN: GB29 MRDN 4011 6200 0048 21'], [320, 'Currency: GBP']]],
        [690, [[40, 'Date'], [95, 'Description'], [380, 'Withdrawals', 'R'], [465, 'Deposits', 'R'], [555, 'Balance', 'R']]],
        [674, [[40, '01 Oct'], [95, 'Opening Balance'], [555, '4,250.00', 'R']]]
      ];
      var txns = [
        ['02 Oct', 'Direct Debit \u2014 Octopus Energy', '86.40', '', '4,163.60'],
        ['03 Oct', 'Card Payment \u2014 Tesco Stores 3217', '54.18', '', '4,109.42'],
        ['05 Oct', 'Faster Payment Received \u2014 Atlas Freight INV-1042', '', '1,850.00', '5,959.42', 'Ref: ATLAS/OCT/RETAINER'],
        ['07 Oct', 'Standing Order \u2014 Kestrel Lettings (Rent)', '1,200.00', '', '4,759.42'],
        ['09 Oct', 'Card Payment \u2014 Trainline', '42.75', '', '4,716.67'],
        ['12 Oct', 'ATM Withdrawal \u2014 High Street', '100.00', '', '4,616.67'],
        ['14 Oct', 'Stripe Payout', '', '932.16', '5,548.83'],
        ['16 Oct', 'Direct Debit \u2014 Vodafone', '32.00', '', '5,516.83'],
        ['19 Oct', 'Card Payment \u2014 Northwind Cloud Services', '118.37', '', '5,398.46'],
        ['22 Oct', 'Refund \u2014 Trainline', '', '21.40', '5,419.86'],
        ['26 Oct', 'Bank Charges \u2014 Monthly Account Fee', '12.50', '', '5,407.36'],
        ['30 Oct', 'Interest Paid', '', '3.12', '5,410.48']
      ];
      var y = 658;
      txns.forEach(function (t) {
        var cells = [[40, t[0]], [95, t[1]]];
        if (t[2]) cells.push([380, t[2], 'R']);
        if (t[3]) cells.push([465, t[3], 'R']);
        cells.push([555, t[4], 'R']);
        lines.push([y, cells]);
        y -= 16;
        if (t[5]) { lines.push([y + 3, [[95, t[5]]]]); y -= 13; }
      });
      lines.push([y, [[40, '31 Oct'], [95, 'Closing Balance'], [555, '5,410.48', 'R']]]);
      lines.push([y - 40, [[40, 'Meridian Community Bank is a fictional institution used for this demonstration statement.']]]);
      return build(lines);
    }

    return {
      list: function () {
        return [
          { name: 'sample-invoice-northwind.pdf', size: 48211, pageCount: 1, items: invoiceItems() },
          { name: 'sample-statement-meridian.pdf', size: 61874, pageCount: 1, items: statementItems() }
        ];
      }
    };
  })();

  var shared = { License: License, Samples: Samples, sha256Hex: sha256Hex };
  if (typeof module === 'object' && module.exports) module.exports = shared;
  root.VaultParse = root.VaultParse || {};
  root.VaultParse.License = License;
  root.VaultParse.Samples = Samples;
  root.VaultParse.sha256Hex = sha256Hex;

  if (typeof document === 'undefined') return;

  /* ================================================================== *
   * Browser UI
   * ================================================================== */

  var VP = root.VaultParse;
  var STORE = { license: 'vp_license', templates: 'vp_templates' };
  var NUMERIC_FIELDS = { subtotal: 1, tax: 1, total: 1, openingBalance: 1, closingBalance: 1 };
  var SUMMARY_FIELDS = {
    bank: [['vendor', 'Bank'], ['number', 'Statement no.'], ['accountNumber', 'Account'], ['iban', 'IBAN'],
      ['periodStart', 'Period start'], ['periodEnd', 'Period end'], ['currency', 'Currency'],
      ['openingBalance', 'Opening balance'], ['closingBalance', 'Closing balance']],
    invoice: [['vendor', 'Vendor'], ['number', 'Invoice no.'], ['issueDate', 'Issue date'], ['dueDate', 'Due date'],
      ['currency', 'Currency'], ['subtotal', 'Subtotal'], ['tax', 'Tax / VAT'], ['total', 'Total']],
    receipt: [['vendor', 'Merchant'], ['number', 'Receipt no.'], ['issueDate', 'Date'], ['currency', 'Currency'],
      ['subtotal', 'Subtotal'], ['tax', 'Tax / VAT'], ['total', 'Total']]
  };
  var TYPE_LABEL = { bank: 'Bank statement', invoice: 'Invoice', receipt: 'Receipt' };

  var cfg = {};
  var state = {
    docs: [],
    active: 0,
    preset: 'auto',
    codeFormat: 'json',
    tab: 'grid',
    pro: false,
    busy: false,
    serverCalls: 0,
    lastMs: null,
    seq: 0
  };

  function $(id) { return document.getElementById(id); }
  function all(selector, scope) { return Array.prototype.slice.call((scope || document).querySelectorAll(selector)); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function store(key, value) {
    try {
      if (value === undefined) return root.localStorage.getItem(key);
      if (value === null) root.localStorage.removeItem(key);
      else root.localStorage.setItem(key, value);
    } catch (err) { /* storage can be blocked (private mode, sandboxed iframe) */ }
    return null;
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function activeDoc() { return state.docs[state.active] || null; }

  /* ------------------------------ toast ------------------------------ */

  var toastTimer = null;
  function toast(message, tone) {
    var node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.dataset.tone = tone || 'info';
    node.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('is-visible'); }, tone === 'error' ? 6500 : 3200);
  }

  /* ---------------------------- telemetry ---------------------------- */

  function estimateMemoryMb() {
    if (root.performance && performance.memory && performance.memory.usedJSHeapSize) {
      return { value: performance.memory.usedJSHeapSize / 1048576, exact: true };
    }
    var bytes = 6 * 1048576;
    state.docs.forEach(function (doc) {
      bytes += (doc.size || 0) * 2;
      bytes += doc.raw.rows.length * 420 + doc.result.rows.length * 260;
    });
    return { value: bytes / 1048576, exact: false };
  }

  function renderTelemetry() {
    var mem = estimateMemoryMb();
    if ($('tel-mem')) $('tel-mem').textContent = (mem.exact ? '' : '\u2248 ') + mem.value.toFixed(1) + ' MB';
    if ($('tel-calls')) $('tel-calls').textContent = String(state.serverCalls);
    if ($('tel-speed')) $('tel-speed').textContent = state.lastMs === null ? 'ready' : (state.lastMs < 1 ? '<1' : Math.round(state.lastMs)) + ' ms';
  }

  /** Count every runtime request that could carry data off the device. */
  function watchNetwork() {
    if (typeof PerformanceObserver === 'undefined') return;
    var staticHosts = ['https://cdnjs.cloudflare.com/'];
    try {
      var observer = new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          var type = entry.initiatorType;
          if (type !== 'fetch' && type !== 'xmlhttprequest' && type !== 'beacon') return;
          var name = String(entry.name || '');
          if (/^(?:blob|data):/i.test(name)) return;
          if (staticHosts.some(function (host) { return name.indexOf(host) === 0; })) return;
          state.serverCalls++;
          renderTelemetry();
        });
      });
      observer.observe({ type: 'resource', buffered: false });
    } catch (err) { /* resource timing unavailable */ }
  }

  /* ----------------------------- license ----------------------------- */

  function setPro(on) {
    state.pro = !!on;
    document.documentElement.classList.toggle('vp-pro', state.pro);
    all('[data-pro-label]').forEach(function (node) { node.textContent = state.pro ? 'Pro active' : 'Unlock Pro'; });
    if ($('pro-active')) $('pro-active').hidden = !state.pro;
    if ($('pro-form')) $('pro-form').hidden = state.pro;
  }

  var PRO_REASONS = {
    batch: 'You dropped more than {limit} files. The first {limit} were converted; Pro removes the batch limit.',
    export: 'QuickBooks and Xero export presets are part of Pro.',
    template: 'Saving custom regex templates for reuse is part of Pro.',
    general: 'Unlock unlimited batches, accounting presets and saved templates.'
  };

  function openPro(reason) {
    var text = (PRO_REASONS[reason] || PRO_REASONS.general).replace(/\{limit\}/g, String(cfg.freeBatchLimit || 3));
    if ($('pro-reason')) $('pro-reason').textContent = text;
    if ($('license-status')) { $('license-status').textContent = ''; $('license-status').dataset.tone = ''; }
    openDialog('modal-pro');
  }

  function activateLicense() {
    var input = $('license-input');
    var status = $('license-status');
    var key = License.normalize(input.value);
    if (License.verify(key, cfg.salt)) {
      store(STORE.license, key);
      setPro(true);
      status.textContent = 'Key verified offline. Pro is unlocked on this browser.';
      status.dataset.tone = 'ok';
      toast('Pro unlocked. Thank you!', 'ok');
    } else {
      status.textContent = 'That key did not pass the checksum. Check for typos (format: VP-XXXXX-XXXXX-XXXXX-XXXXX).';
      status.dataset.tone = 'error';
    }
  }

  /* ----------------------------- dialogs ----------------------------- */

  function openDialog(id) {
    var dialog = $(id);
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') { if (!dialog.open) dialog.showModal(); }
    else dialog.setAttribute('open', '');
  }
  function closeDialog(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }

  function embedSnippet() {
    var page = location.href.split(/[?#]/)[0];
    var home = new URL(cfg.root || './', location.href).href;
    var title = (document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : cfg.siteName + ' PDF converter');
    return '<iframe src="' + page + '?embed=1" title="' + title.replace(/"/g, '&quot;') + '" width="100%" height="820" ' +
      'style="border:1px solid #1f2937;border-radius:14px;max-width:100%" loading="lazy" allow="clipboard-write"></iframe>\n' +
      '<p style="font:13px/1.5 system-ui,sans-serif;margin:8px 0 0">Free private PDF to CSV converter by ' +
      '<a href="' + home + '" target="_blank" rel="noopener">' + cfg.siteName + '</a> &mdash; files never leave your device.</p>';
  }

  /* ------------------------------ intake ------------------------------ */

  function isPdf(file) {
    return file && (file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''));
  }

  function setBusy(on, label) {
    state.busy = on;
    var zone = $('dropzone');
    if (zone) zone.classList.toggle('is-busy', on);
    var status = $('progress');
    if (status) status.textContent = label || '';
  }

  function addDocument(raw, ms, fixedPreset) {
    var result = VP.Parser.parseDocument(raw, { preset: fixedPreset || state.preset });
    state.docs.push({
      fixedPreset: fixedPreset || '',
      id: ++state.seq,
      name: raw.name,
      size: raw.size || 0,
      raw: raw,
      result: result,
      template: '',
      ms: ms
    });
  }

  function processFiles(fileList) {
    if (state.busy) return;
    var files = Array.prototype.slice.call(fileList || []).filter(isPdf);
    if (!files.length) {
      toast('Please choose PDF files (invoices, receipts or statements).', 'error');
      return;
    }
    var limit = cfg.freeBatchLimit || 3;
    var trimmed = false;
    if (files.length > limit && !state.pro) {
      files = files.slice(0, limit);
      trimmed = true;
    }
    var started = performance.now();
    var done = 0, failed = [];
    var firstNew = state.docs.length;
    setBusy(true, 'Reading 1 of ' + files.length + '\u2026');

    var chain = Promise.resolve();
    files.forEach(function (file, index) {
      chain = chain.then(function () {
        setBusy(true, 'Reading ' + (index + 1) + ' of ' + files.length + ': ' + file.name);
        var t0 = performance.now();
        return VP.PdfEngine.extractDocument(file, { tolerance: cfg.rowTolerance }).then(function (raw) {
          addDocument(raw, performance.now() - t0);
          done++;
        }).catch(function (err) {
          failed.push((err && err.message) || ('Could not read ' + file.name));
        });
      });
    });

    chain.then(function () {
      setBusy(false, '');
      if (done) {
        state.lastMs = (performance.now() - started) / done;
        state.active = firstNew;
        renderAll();
        toast(done + (done === 1 ? ' file' : ' files') + ' converted locally in ' + Math.round(performance.now() - started) + ' ms.', 'ok');
      }
      if (failed.length) toast(failed[0], 'error');
      if (trimmed) openPro('batch');
      renderTelemetry();
    });
  }

  function loadSamples() {
    var t0 = performance.now();
    var samples = Samples.list();
    var firstNew = state.docs.length;
    samples.forEach(function (sample) {
      var s0 = performance.now();
      var rows = VP.PdfEngine.reconstructRows(sample.items, { tolerance: cfg.rowTolerance, page: 1 });
      // Samples are one invoice and one statement, so they always auto-detect
      // (until the visitor picks a preset by hand) whatever this page pre-selects.
      addDocument({ name: sample.name, size: sample.size, pageCount: sample.pageCount, rows: rows }, performance.now() - s0, 'auto');
    });
    state.lastMs = (performance.now() - t0) / samples.length;
    state.active = firstNew + (state.preset === 'bank' ? 1 : 0);
    renderAll();
    toast('Sample invoice and bank statement loaded. Edit any cell, then export.', 'ok');
    var target = $('workspace');
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function reparse(doc) {
    doc.result = VP.Parser.parseDocument(doc.raw, { preset: doc.fixedPreset || state.preset, template: doc.template || '' });
  }

  /* ----------------------------- rendering ----------------------------- */

  function formatCell(value, col) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      if (col && (col.key === 'qty' || col.key === 'unit_price')) return String(value);
      return value.toFixed(2);
    }
    return String(value);
  }

  function renderTabs() {
    var host = $('doc-tabs');
    host.textContent = '';
    state.docs.forEach(function (doc, index) {
      var chip = el('div', 'vp-chip' + (index === state.active ? ' is-active' : ''));
      var pick = el('button', 'vp-chip-main');
      pick.type = 'button';
      pick.dataset.doc = String(index);
      pick.appendChild(el('span', 'vp-chip-type', TYPE_LABEL[doc.result.docType] || 'Document'));
      pick.appendChild(el('span', 'vp-chip-name', doc.name));
      pick.appendChild(el('span', 'vp-chip-count', doc.result.rows.length + ' rows'));
      var close = el('button', 'vp-chip-close', '\u00d7');
      close.type = 'button';
      close.dataset.remove = String(index);
      close.setAttribute('aria-label', 'Remove ' + doc.name);
      chip.appendChild(pick);
      chip.appendChild(close);
      host.appendChild(chip);
    });
  }

  function renderSummary() {
    var host = $('summary-grid');
    var doc = activeDoc();
    host.textContent = '';
    var badge = $('reconcile-badge');
    var warn = $('warnings');
    warn.textContent = '';
    if (!doc) { badge.hidden = true; return; }
    var meta = doc.result.meta;
    var fields = SUMMARY_FIELDS[doc.result.docType] || SUMMARY_FIELDS.invoice;
    fields.forEach(function (field) {
      var wrap = el('label', 'vp-field');
      wrap.appendChild(el('span', 'vp-field-label', field[1]));
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'vp-input';
      input.dataset.meta = field[0];
      input.autocomplete = 'off';
      input.spellcheck = false;
      var value = meta[field[0]];
      input.value = typeof value === 'number' ? value.toFixed(2) : (value || '');
      if (NUMERIC_FIELDS[field[0]]) input.inputMode = 'decimal';
      wrap.appendChild(input);
      host.appendChild(wrap);
    });
    renderReconcile();
    doc.result.warnings.forEach(function (message) { warn.appendChild(el('p', 'vp-warning', message)); });
  }

  function renderReconcile() {
    var doc = activeDoc();
    var badge = $('reconcile-badge');
    if (!doc || doc.template) { badge.hidden = true; return; }
    var check = VP.Parser.reconcile(doc.result.docType, doc.result.meta, doc.result.rows);
    doc.result.meta.reconciled = check.status;
    doc.result.meta.reconcileNote = check.message;
    badge.hidden = !check.message;
    badge.dataset.status = check.status;
    badge.textContent = (check.status === 'ok' ? '\u2713 ' : check.status === 'mismatch' ? '! ' : '') + check.message;
  }

  function renderGrid() {
    var host = $('grid-host');
    var doc = activeDoc();
    host.textContent = '';
    if (!doc) return;
    var res = doc.result;
    var table = el('table', 'vp-grid');
    var thead = el('thead');
    var hr = el('tr');
    hr.appendChild(el('th', 'vp-grid-idx', '#'));
    res.columns.forEach(function (col, c) {
      var th = el('th', col.type === 'number' ? 'is-num' : '');
      var label = el('span', 'vp-grid-head', col.label);
      label.contentEditable = 'true';
      label.spellcheck = false;
      label.dataset.col = String(c);
      label.setAttribute('role', 'textbox');
      label.setAttribute('aria-label', 'Rename column ' + col.label);
      th.appendChild(label);
      hr.appendChild(th);
    });
    hr.appendChild(el('th', 'vp-grid-act'));
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    res.rows.forEach(function (row, r) {
      var tr = el('tr');
      tr.appendChild(el('td', 'vp-grid-idx', String(r + 1)));
      res.columns.forEach(function (col) {
        var value = row[col.key];
        var td = el('td', (col.type === 'number' ? 'is-num' : '') + (typeof value === 'number' && value < 0 ? ' is-neg' : ''), formatCell(value, col));
        td.contentEditable = 'true';
        td.spellcheck = false;
        td.dataset.r = String(r);
        td.dataset.k = col.key;
        tr.appendChild(td);
      });
      var act = el('td', 'vp-grid-act');
      var del = el('button', 'vp-row-del', '\u00d7');
      del.type = 'button';
      del.dataset.del = String(r);
      del.title = 'Delete row';
      del.setAttribute('aria-label', 'Delete row ' + (r + 1));
      act.appendChild(del);
      tr.appendChild(act);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    host.appendChild(table);
    if ($('row-count')) $('row-count').textContent = res.rows.length + (res.rows.length === 1 ? ' row' : ' rows') + ' \u00b7 ' + res.columns.length + ' columns';
  }

  var MAX_CODE = 160000;

  function currentCode() {
    var doc = activeDoc();
    if (!doc) return '';
    return state.codeFormat === 'csv' ? VP.Exporter.toCSV([doc]) : VP.Exporter.toJSON([doc]);
  }

  function highlightJson(text) {
    return escapeHtml(text).replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g,
      function (match, str, colon, literal) {
        if (str) return colon ? '<span class="tok-key">' + str + '</span>' + colon : '<span class="tok-str">' + str + '</span>';
        if (literal) return '<span class="tok-lit">' + match + '</span>';
        return '<span class="tok-num">' + match + '</span>';
      });
  }

  function highlightCsv(text) {
    var lines = escapeHtml(text).split(/\r?\n/);
    return lines.map(function (line, i) {
      var body = line.replace(/,/g, '<span class="tok-punc">,</span>');
      return i === 0 ? '<span class="tok-key">' + body + '</span>' : body;
    }).join('\n');
  }

  function renderCode() {
    var view = $('code-view');
    if (!view) return;
    var code = currentCode();
    var clipped = code.length > MAX_CODE;
    var shown = clipped ? code.slice(0, MAX_CODE) : code;
    view.innerHTML = (state.codeFormat === 'csv' ? highlightCsv(shown) : highlightJson(shown)) +
      (clipped ? '\n<span class="tok-punc">\u2026 preview truncated; Copy and Export include everything.</span>' : '');
    all('[data-code-format]').forEach(function (btn) {
      btn.setAttribute('aria-pressed', btn.dataset.codeFormat === state.codeFormat ? 'true' : 'false');
    });
  }

  var codeTimer = null;
  function refreshDerived() {
    clearTimeout(codeTimer);
    codeTimer = setTimeout(function () { renderCode(); renderReconcile(); renderTabs(); renderTelemetry(); }, 60);
  }

  function renderTemplates() {
    var select = $('tpl-saved');
    if (!select) return;
    var saved = readTemplates();
    select.textContent = '';
    var first = el('option', '', saved.length ? 'Saved templates (' + saved.length + ')' : 'No saved templates yet');
    first.value = '';
    select.appendChild(first);
    saved.forEach(function (tpl, i) {
      var option = el('option', '', tpl.name);
      option.value = String(i);
      select.appendChild(option);
    });
  }

  function renderAll() {
    var has = state.docs.length > 0;
    if (state.active >= state.docs.length) state.active = Math.max(0, state.docs.length - 1);
    $('workspace').hidden = !has;
    if ($('empty-hint')) $('empty-hint').hidden = has;
    renderTabs();
    renderSummary();
    renderGrid();
    renderCode();
    renderTelemetry();
    var doc = activeDoc();
    if ($('tpl-regex')) $('tpl-regex').value = doc && doc.template ? doc.template : ($('tpl-regex').value || '');
  }

  function setTab(name) {
    state.tab = name;
    ['grid', 'code'].forEach(function (key) {
      var tab = $('tab-' + key), panel = $('panel-' + key);
      var on = key === name;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    });
    if (name === 'code') renderCode();
  }

  /* ------------------------------ editing ------------------------------ */

  function commitCell(td) {
    var doc = activeDoc();
    if (!doc) return;
    var r = +td.dataset.r, key = td.dataset.k;
    var row = doc.result.rows[r];
    if (!row) return;
    var col = doc.result.columns.filter(function (c) { return c.key === key; })[0];
    var text = td.textContent.replace(/\u00a0/g, ' ').trim();
    var value = text;
    if (col.type === 'number') {
      if (text === '') value = null;
      else {
        var parsed = VP.Parser.parseAmount(text);
        value = parsed ? parsed.value : text;
      }
    } else if (col.type === 'date' && text) {
      value = VP.Parser.parseDate(text, { order: doc.result.meta.dateOrder }) || text;
    }
    if (row[key] === value) { td.textContent = formatCell(value, col); return; }
    row[key] = value;
    // Keep the signed Amount in step when Debit / Credit are edited on bank rows.
    if (doc.result.docType === 'bank' && (key === 'debit' || key === 'credit') && !doc.template) {
      var debit = typeof row.debit === 'number' ? row.debit : 0;
      var credit = typeof row.credit === 'number' ? row.credit : 0;
      row.amount = Math.round((credit - debit) * 100) / 100;
      var amountCell = td.parentNode.querySelector('td[data-k="amount"]');
      if (amountCell) {
        amountCell.textContent = row.amount.toFixed(2);
        amountCell.classList.toggle('is-neg', row.amount < 0);
      }
    }
    td.textContent = formatCell(value, col);
    td.classList.toggle('is-neg', typeof value === 'number' && value < 0);
    refreshDerived();
  }

  function commitHeader(span) {
    var doc = activeDoc();
    if (!doc) return;
    var col = doc.result.columns[+span.dataset.col];
    if (!col) return;
    var text = span.textContent.replace(/\s+/g, ' ').trim();
    if (!text) { span.textContent = col.label; return; }
    span.textContent = text;
    if (text !== col.label) { col.label = text; refreshDerived(); }
  }

  function commitMeta(input) {
    var doc = activeDoc();
    if (!doc) return;
    var key = input.dataset.meta;
    var text = input.value.trim();
    if (NUMERIC_FIELDS[key]) {
      var parsed = text === '' ? null : VP.Parser.parseAmount(text);
      doc.result.meta[key] = text === '' ? null : (parsed ? parsed.value : doc.result.meta[key]);
      var v = doc.result.meta[key];
      input.value = typeof v === 'number' ? v.toFixed(2) : '';
    } else if (/Date|period/i.test(key) && text) {
      doc.result.meta[key] = VP.Parser.parseDate(text, { order: doc.result.meta.dateOrder }) || text;
      input.value = doc.result.meta[key];
    } else {
      doc.result.meta[key] = text;
    }
    refreshDerived();
  }

  function addRow() {
    var doc = activeDoc();
    if (!doc) return;
    var row = {};
    doc.result.columns.forEach(function (col) { row[col.key] = col.type === 'number' ? null : ''; });
    doc.result.rows.push(row);
    renderGrid();
    refreshDerived();
    var cells = all('#grid-host tbody tr:last-child td[contenteditable]');
    if (cells[0]) cells[0].focus();
  }

  /* ----------------------------- templates ----------------------------- */

  function readTemplates() {
    try {
      var list = JSON.parse(store(STORE.templates) || '[]');
      return Array.isArray(list) ? list.filter(function (t) { return t && typeof t.regex === 'string' && typeof t.name === 'string'; }) : [];
    } catch (err) { return []; }
  }

  function applyTemplate() {
    var doc = activeDoc();
    if (!doc) { toast('Load a document first.', 'error'); return; }
    var pattern = $('tpl-regex').value.trim();
    if (!pattern) { toast('Enter a regular expression with named groups.', 'error'); return; }
    try {
      VP.Parser.applyTemplate(doc.raw.rows.slice(0, 1), pattern, {});
      doc.template = pattern;
      reparse(doc);
      renderAll();
      toast('Template matched ' + doc.result.rows.length + ' rows.', doc.result.rows.length ? 'ok' : 'error');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function resetTemplate() {
    var doc = activeDoc();
    if (!doc) return;
    doc.template = '';
    $('tpl-regex').value = '';
    reparse(doc);
    renderAll();
    toast('Back to built-in detection.', 'info');
  }

  function saveTemplate() {
    if (!state.pro) { openPro('template'); return; }
    var pattern = $('tpl-regex').value.trim();
    var name = ($('tpl-name').value || '').trim();
    if (!pattern) { toast('Enter a regular expression first.', 'error'); return; }
    try { new RegExp(pattern); } catch (err) { toast('Invalid regular expression: ' + err.message, 'error'); return; }
    var list = readTemplates();
    list.push({ name: name || 'Template ' + (list.length + 1), regex: pattern });
    store(STORE.templates, JSON.stringify(list.slice(-50)));
    $('tpl-name').value = '';
    renderTemplates();
    toast('Template saved in this browser.', 'ok');
  }

  /* ------------------------------ exports ------------------------------ */

  function loadScript(src, integrity) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      if (integrity) { tag.integrity = integrity; tag.crossOrigin = 'anonymous'; }
      tag.referrerPolicy = 'no-referrer';
      tag.onload = resolve;
      tag.onerror = function () { reject(new Error('Could not load ' + src)); };
      document.head.appendChild(tag);
    });
  }

  var xlsxLoading = null;
  function ensureXlsx() {
    if (root.XLSX && root.XLSX.utils) return Promise.resolve();
    if (!xlsxLoading) {
      xlsxLoading = loadScript(cfg.cdn.xlsx.src, cfg.cdn.xlsx.integrity).catch(function (err) { xlsxLoading = null; throw err; });
    }
    return xlsxLoading;
  }

  function runExport(kind) {
    var format = VP.Exporter.FORMATS[kind];
    if (!format) return;
    if (!state.docs.length) { toast('Load a PDF or the sample first.', 'error'); return; }
    if (format.pro && !state.pro) { openPro('export'); return; }
    var docs = state.docs.filter(function (doc) { return doc.result.rows.length > 0; });
    if (!docs.length) { toast('There are no rows to export.', 'error'); return; }
    var ready = kind === 'xlsx' ? ensureXlsx() : Promise.resolve();
    ready.then(function () {
      var name = VP.Exporter.exportDocs(kind, docs);
      toast('Saved ' + name, 'ok');
    }).catch(function (err) {
      toast((err && err.message) || 'Export failed.', 'error');
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
    }
    return legacyCopy(text);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      document.body.removeChild(area);
      if (ok) resolve(); else reject(new Error('Copy is blocked in this context. Select the text and copy manually.'));
    });
  }

  /* ------------------------------- wiring ------------------------------- */

  function bind() {
    var zone = $('dropzone');
    var input = $('file-input');

    zone.addEventListener('click', function (event) {
      if (event.target.closest('button, select, a, label')) return;
      input.click();
    });
    zone.addEventListener('keydown', function (event) {
      if ((event.key === 'Enter' || event.key === ' ') && event.target === zone) { event.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () {
      processFiles(input.files);
      input.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (type) {
      zone.addEventListener(type, function (event) { event.preventDefault(); zone.classList.add('is-drag'); });
    });
    ['dragleave', 'dragend', 'drop'].forEach(function (type) {
      zone.addEventListener(type, function () { zone.classList.remove('is-drag'); });
    });
    zone.addEventListener('drop', function (event) {
      event.preventDefault();
      if (event.dataTransfer && event.dataTransfer.files) processFiles(event.dataTransfer.files);
    });
    // Dropping a file outside the zone must never navigate the tab away to the PDF.
    ['dragover', 'drop'].forEach(function (type) {
      window.addEventListener(type, function (event) { event.preventDefault(); });
    });

    $('btn-browse').addEventListener('click', function () { input.click(); });
    $('btn-sample').addEventListener('click', loadSamples);
    $('btn-clear').addEventListener('click', function () {
      state.docs = [];
      state.active = 0;
      renderAll();
      toast('Workspace cleared. Nothing was stored.', 'info');
    });

    $('preset-select').addEventListener('change', function (event) {
      state.preset = event.target.value;
      if (state.docs.length) {
        state.docs.forEach(function (doc) { doc.fixedPreset = ''; reparse(doc); });
        renderAll();
        toast('Re-parsed with the "' + event.target.options[event.target.selectedIndex].text + '" rules.', 'info');
      }
    });

    $('doc-tabs').addEventListener('click', function (event) {
      var remove = event.target.closest('[data-remove]');
      if (remove) {
        state.docs.splice(+remove.dataset.remove, 1);
        if (state.active >= state.docs.length) state.active = Math.max(0, state.docs.length - 1);
        renderAll();
        return;
      }
      var pick = event.target.closest('[data-doc]');
      if (pick) { state.active = +pick.dataset.doc; renderAll(); }
    });

    $('summary-grid').addEventListener('change', function (event) {
      if (event.target.dataset && event.target.dataset.meta) commitMeta(event.target);
    });

    var grid = $('grid-host');
    grid.addEventListener('focusout', function (event) {
      var target = event.target;
      if (target.dataset && target.dataset.k !== undefined) commitCell(target);
      else if (target.dataset && target.dataset.col !== undefined) commitHeader(target);
    });
    grid.addEventListener('keydown', function (event) {
      if (!event.target.isContentEditable) return;
      if (event.key === 'Enter') { event.preventDefault(); event.target.blur(); }
      else if (event.key === 'Escape') { event.preventDefault(); renderGrid(); }
    });
    grid.addEventListener('paste', function (event) {
      if (!event.target.isContentEditable) return;
      event.preventDefault();
      var text = (event.clipboardData || root.clipboardData).getData('text').replace(/[\r\n\t]+/g, ' ');
      var selection = root.getSelection();
      if (!selection || !selection.rangeCount) return;
      var range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    });
    grid.addEventListener('click', function (event) {
      var del = event.target.closest('[data-del]');
      if (!del) return;
      var doc = activeDoc();
      doc.result.rows.splice(+del.dataset.del, 1);
      renderGrid();
      refreshDerived();
    });
    $('btn-add-row').addEventListener('click', addRow);

    $('tab-grid').addEventListener('click', function () { setTab('grid'); });
    $('tab-code').addEventListener('click', function () { setTab('code'); });
    all('[role="tab"]').forEach(function (tab) {
      tab.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          var next = state.tab === 'grid' ? 'code' : 'grid';
          setTab(next);
          $('tab-' + next).focus();
        }
      });
    });

    all('[data-code-format]').forEach(function (btn) {
      btn.addEventListener('click', function () { state.codeFormat = btn.dataset.codeFormat; renderCode(); });
    });
    $('btn-copy-code').addEventListener('click', function () {
      var code = currentCode();
      if (!code) { toast('Nothing to copy yet.', 'error'); return; }
      copyText(code).then(function () { toast(state.codeFormat.toUpperCase() + ' copied to clipboard.', 'ok'); },
        function (err) { toast(err.message, 'error'); });
    });

    all('[data-export]').forEach(function (btn) {
      btn.addEventListener('click', function () { runExport(btn.dataset.export); });
    });

    $('btn-tpl-apply').addEventListener('click', applyTemplate);
    $('btn-tpl-reset').addEventListener('click', resetTemplate);
    $('btn-tpl-save').addEventListener('click', saveTemplate);
    $('tpl-saved').addEventListener('change', function (event) {
      var tpl = readTemplates()[+event.target.value];
      if (event.target.value !== '' && tpl) $('tpl-regex').value = tpl.regex;
    });

    all('[data-open]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.dataset.open === 'pro') openPro('general');
        else if (btn.dataset.open === 'embed') {
          $('embed-code').value = embedSnippet();
          openDialog('modal-embed');
        }
      });
    });
    all('dialog').forEach(function (dialog) {
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog || event.target.closest('[data-close]')) closeDialog(dialog);
      });
    });
    $('btn-activate').addEventListener('click', activateLicense);
    $('license-input').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); activateLicense(); }
    });
    $('btn-deactivate').addEventListener('click', function () {
      store(STORE.license, null);
      setPro(false);
      toast('License removed from this browser.', 'info');
    });
    $('btn-copy-embed').addEventListener('click', function () {
      copyText($('embed-code').value).then(function () { toast('Embed code copied.', 'ok'); },
        function (err) { toast(err.message, 'error'); });
    });
  }

  function init() {
    var holder = $('vp-config');
    if (!holder || !$('dropzone')) return;
    try { cfg = JSON.parse(holder.textContent); } catch (err) { cfg = {}; }
    cfg.cdn = cfg.cdn || {};

    VP.PdfEngine.configure({
      rowTolerance: cfg.rowTolerance || 3.5,
      workerSrc: cfg.cdn.pdfjsWorker || '',
      cMapUrl: cfg.cdn.pdfjsCMaps || ''
    });

    if (/[?&]embed=1\b/.test(location.search)) document.documentElement.classList.add('vp-embed');

    state.preset = cfg.preset || 'auto';
    $('preset-select').value = state.preset;
    all('[data-export]').forEach(function (btn) {
      if (btn.dataset.export === cfg.exportDefault) btn.classList.add('is-preferred');
    });

    var buy = $('btn-buy');
    if (buy) {
      if (cfg.checkoutUrl) { buy.href = cfg.checkoutUrl; buy.hidden = false; if ($('buy-pending')) $('buy-pending').hidden = true; }
      else { buy.hidden = true; if ($('buy-pending')) $('buy-pending').hidden = false; }
    }

    var savedKey = store(STORE.license);
    setPro(!!savedKey && License.verify(savedKey, cfg.salt));

    bind();
    renderTemplates();
    renderAll();
    watchNetwork();
    setInterval(renderTelemetry, 2500);

    if (/[?&]demo=1\b/.test(location.search)) loadSamples();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(typeof self !== 'undefined' ? self : globalThis);

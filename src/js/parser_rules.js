/*!
 * VaultParse — parser_rules.js
 * Deterministic heuristics that turn reconstructed PDF rows into structured
 * financial data: document metadata (number, dates, vendor, currency, totals,
 * account identifiers) and tabular line items / bank transactions.
 *
 * Input rows come from pdf_engine.js:
 *   { page, y, text, cells: [{ text, x, x2 }] }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VaultParse = root.VaultParse || {};
  root.VaultParse.Parser = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Dates
   * ------------------------------------------------------------------ */

  var MON = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  var MONTH_INDEX = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  var D_ISO = '\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}';
  var D_NUM = '\\d{1,2}[-/.]\\d{1,2}[-/.]\\d{2,4}';
  var D_DMON = '\\d{1,2}(?:st|nd|rd|th)?[\\s.-]+' + MON + '\\.?,?[\\s.-]+\\d{2,4}';
  var D_MOND = MON + '\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}';
  var DATE_SRC = '(?:' + D_ISO + '|' + D_NUM + '|' + D_DMON + '|' + D_MOND + ')(?!\\d)';
  var SHORT_DATE_SRC = '(?:\\d{1,2}[/-]\\d{1,2}|\\d{1,2}[\\s-]+' + MON + '\\b\\.?|' + MON + '\\b\\.?\\s+\\d{1,2})(?![\\d/.-])';

  var RE_ISO = new RegExp('^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})$');
  var RE_NUM = new RegExp('^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{2,4})$');
  var RE_DMON = new RegExp('^(\\d{1,2})(?:st|nd|rd|th)?[\\s.-]+(' + MON + ')\\.?,?[\\s.-]+(\\d{2,4})$', 'i');
  var RE_MOND = new RegExp('^(' + MON + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$', 'i');
  var RE_S_NUM = new RegExp('^(\\d{1,2})[/-](\\d{1,2})$');
  var RE_S_DMON = new RegExp('^(\\d{1,2})[\\s-]+(' + MON + ')\\.?$', 'i');
  var RE_S_MOND = new RegExp('^(' + MON + ')\\.?\\s+(\\d{1,2})$', 'i');
  var RE_LEAD_DATE = new RegExp('^\\s*(' + DATE_SRC + ')(?=\\s|$|[,;|])', 'i');
  var RE_LEAD_SHORT = new RegExp('^\\s*(' + SHORT_DATE_SRC + ')(?=\\s|$)', 'i');
  var RE_ANY_NUM_DATE = new RegExp('(?:^|[^\\d])(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{4}|\\d{2})(?!\\d)', 'g');

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function monthIndex(name) {
    return MONTH_INDEX[String(name).slice(0, 3).toLowerCase()] || 0;
  }

  function fullYear(y) {
    y = +y;
    if (y < 100) return y < 70 ? 2000 + y : 1900 + y;
    return y;
  }

  function iso(y, m, d) {
    if (!(y >= 1900 && y <= 2200) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    var days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d > days) return null;
    return y + '-' + pad(m) + '-' + pad(d);
  }

  /**
   * Parse a single date string to ISO (YYYY-MM-DD).
   * ctx.order: 'DMY' | 'MDY' for ambiguous numeric dates.
   * ctx.allowShort + ctx.resolveYear(month): accept year-less dates ("02 Oct", "10/02").
   */
  function parseDate(str, ctx) {
    ctx = ctx || {};
    var s = String(str == null ? '' : str).trim().replace(/\s+/g, ' ').replace(/[,;|]+$/, '');
    if (!s) return null;
    var m;
    if ((m = RE_ISO.exec(s))) return iso(+m[1], +m[2], +m[3]);
    if ((m = RE_DMON.exec(s))) return iso(fullYear(m[3]), monthIndex(m[2]), +m[1]);
    if ((m = RE_MOND.exec(s))) return iso(+m[3], monthIndex(m[1]), +m[2]);
    if ((m = RE_NUM.exec(s))) {
      var a = +m[1], b = +m[2], y = fullYear(m[3]);
      if (a > 12 && b <= 12) return iso(y, b, a);
      if (b > 12 && a <= 12) return iso(y, a, b);
      return ctx.order === 'MDY' ? iso(y, a, b) : iso(y, b, a);
    }
    if (ctx.allowShort) {
      var month = 0, day = 0;
      if ((m = RE_S_DMON.exec(s))) { day = +m[1]; month = monthIndex(m[2]); }
      else if ((m = RE_S_MOND.exec(s))) { day = +m[2]; month = monthIndex(m[1]); }
      else if ((m = RE_S_NUM.exec(s))) {
        var p = +m[1], q = +m[2];
        if (p > 12 && q <= 12) { day = p; month = q; }
        else if (q > 12 && p <= 12) { day = q; month = p; }
        else if (ctx.order === 'MDY') { month = p; day = q; }
        else { day = p; month = q; }
      }
      if (month && day) {
        var year = typeof ctx.resolveYear === 'function' ? ctx.resolveYear(month) : new Date().getFullYear();
        return iso(year, month, day);
      }
    }
    return null;
  }

  function leadingDate(text, ctx) {
    var m = RE_LEAD_DATE.exec(text);
    if (m) {
      var value = parseDate(m[1], ctx);
      if (value) return { iso: value, raw: m[1], rest: text.slice(m[0].length).replace(/^[\s,;|]+/, '') };
    }
    if (ctx && ctx.allowShort) {
      m = RE_LEAD_SHORT.exec(text);
      if (m) {
        var short = parseDate(m[1], ctx);
        if (short) return { iso: short, raw: m[1], rest: text.slice(m[0].length).replace(/^[\s,;|]+/, '') };
      }
    }
    return null;
  }

  function detectDateOrder(text, currency) {
    var dmy = 0, mdy = 0, m;
    RE_ANY_NUM_DATE.lastIndex = 0;
    while ((m = RE_ANY_NUM_DATE.exec(text))) {
      var a = +m[1], b = +m[2];
      if (a > 12 && b <= 12) dmy++;
      else if (b > 12 && a <= 12) mdy++;
    }
    if (dmy > mdy) return 'DMY';
    if (mdy > dmy) return 'MDY';
    return currency === 'USD' ? 'MDY' : 'DMY';
  }

  /* ------------------------------------------------------------------ *
   * Amounts
   * ------------------------------------------------------------------ */

  var CUR = '(?:USD|EUR|GBP|PKR|CAD|AUD|US\\$|CA\\$|AU\\$|C\\$|A\\$|Rs\\.?|[$\\u20AC\\u00A3\\u20A8])';
  var NUM_CORE = '(?:\\d{1,3}(?:,\\d{3})+(?:\\.\\d{1,4})?|\\d{1,3}(?:\\.\\d{3})+(?:,\\d{1,2})?|\\d+[.,]\\d{1,4}|\\d+)';
  var AMT_SRC = '\\(?\\s?[-+\\u2212]?\\s?' + CUR + '?\\s?[-+\\u2212]?' + NUM_CORE + '\\s?' + CUR + '?\\s?\\)?(?:\\s?(?:CR|DR|Cr|Dr|cr|dr))?-?';
  var RE_AMT_FULL = new RegExp('^' + AMT_SRC + '$');
  var RE_AMT_TRAIL = new RegExp('^(.*?\\S)\\s+(' + AMT_SRC + ')$');
  var RE_CUR_G = new RegExp(CUR, 'g');

  /**
   * Parse a money / numeric token. Handles 1,234.56 · 1.234,56 · (450.00) ·
   * -450.00 · 450.00- · 450.00 CR / DR · $1,234.56 · PKR 12,500.
   * Returns null when the string is not a clean numeric token.
   */
  function parseAmount(str) {
    var s = String(str == null ? '' : str).trim();
    if (!s || s.length > 28 || !RE_AMT_FULL.test(s)) return null;
    var hasCur = false;
    var body = s.replace(RE_CUR_G, function () { hasCur = true; return ''; });
    var paren = body.indexOf('(') !== -1 && body.indexOf(')') !== -1;
    var minus = /[-\u2212]/.test(body);
    var dr = /dr-?$/i.test(body.trim());
    var cr = /cr-?$/i.test(body.trim());
    var digits = body.replace(/[^\d.,]/g, '');
    if (!/\d/.test(digits)) return null;

    var lastDot = digits.lastIndexOf('.');
    var lastComma = digits.lastIndexOf(',');
    var decimalSep = '';
    var grouped = false;
    if (lastDot !== -1 && lastComma !== -1) {
      decimalSep = lastDot > lastComma ? '.' : ',';
      grouped = true;
    } else if (lastComma !== -1) {
      if (/^\d{1,3}(?:,\d{3})+$/.test(digits)) grouped = true;
      else decimalSep = ',';
    } else if (lastDot !== -1) {
      if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(digits)) grouped = true;
      else decimalSep = '.';
    }
    var normalized;
    if (decimalSep) {
      var idx = digits.lastIndexOf(decimalSep);
      normalized = digits.slice(0, idx).replace(/[.,]/g, '') + '.' + digits.slice(idx + 1);
    } else {
      normalized = digits.replace(/[.,]/g, '');
    }
    var abs = parseFloat(normalized);
    if (!isFinite(abs)) return null;
    var negative = paren || minus || dr;
    return {
      value: negative ? -abs : abs,
      abs: abs,
      negative: negative,
      explicit: negative || cr || /\+/.test(body),
      cr: cr,
      dr: dr,
      currency: hasCur,
      decimals: decimalSep ? normalized.length - normalized.indexOf('.') - 1 : 0,
      money: hasCur || !!decimalSep || grouped || paren || cr || dr,
      raw: s
    };
  }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }
  function approx(a, b) { return Math.abs(a - b) < 0.006; }

  /* ------------------------------------------------------------------ *
   * Row analysis
   * ------------------------------------------------------------------ */

  /**
   * Split a row into: optional leading date, description text, and the run of
   * numeric tokens at its right-hand end (with approximate x positions).
   */
  function analyzeRow(row, ctx, options) {
    options = options || {};
    var cells = [];
    for (var c = 0; c < row.cells.length; c++) {
      var src = row.cells[c];
      var txt = String(src.text || '').trim();
      if (txt) cells.push({ text: txt, x: src.x, x2: src.x2 });
    }
    var nums = [];
    var i = cells.length - 1;
    for (; i >= 0; i--) {
      var cell = cells[i];
      var whole = parseAmount(cell.text);
      if (whole && (whole.money || (options.plainNumbers && cell.text.replace(/\D/g, '').length <= 7))) {
        whole.x = cell.x; whole.x2 = cell.x2;
        nums.unshift(whole);
        continue;
      }
      // Peel money tokens that pdf.js glued onto the end of a text cell.
      var guard = 0;
      while (guard++ < 6) {
        var m = RE_AMT_TRAIL.exec(cell.text);
        if (!m) break;
        var tail = parseAmount(m[2]);
        if (!tail || !tail.money) break;
        var width = cell.x2 - cell.x;
        var startRatio = (cell.text.length - m[2].length) / cell.text.length;
        tail.x = cell.x + width * startRatio;
        tail.x2 = cell.x2;
        nums.unshift(tail);
        cell.x2 = cell.x + width * (m[1].length / cell.text.length);
        cell.text = m[1];
      }
      break;
    }
    var rest = cells.slice(0, Math.max(0, i + 1));
    var date = null, dateRaw = '';
    if (rest.length) {
      var lead = leadingDate(rest[0].text, ctx);
      if (lead) {
        date = lead.iso;
        dateRaw = lead.raw;
        if (lead.rest) rest[0] = { text: lead.rest, x: rest[0].x, x2: rest[0].x2 };
        else rest.shift();
        // A second date (value / posting date) directly after the first is dropped.
        if (rest.length) {
          var second = leadingDate(rest[0].text, ctx);
          if (second) {
            if (second.rest) rest[0] = { text: second.rest, x: rest[0].x, x2: rest[0].x2 };
            else rest.shift();
          }
        }
      }
    }
    return {
      date: date,
      dateRaw: dateRaw,
      nums: nums,
      desc: rest.map(function (r) { return r.text; }).join(' ').replace(/\s+/g, ' ').trim(),
      descCells: rest
    };
  }

  /* ------------------------------------------------------------------ *
   * Table header detection + column mapping
   * ------------------------------------------------------------------ */

  var HEADER_RULES = [
    ['date', /^(?:date|trans(?:action)? date|txn date|posting date|post date|posted|value date|booking date|date posted|service date)$/],
    ['description', /^(?:description|details|transaction details|transaction description|particulars|narrative|narration|transaction|transactions|item|items|item description|product|products|service|services|product or service|memo|payee|activity|line item|charge)$/],
    ['debit', /^(?:debit|debits|withdrawal|withdrawals|paid out|money out|payments|payments out|dr|out|debit amount|withdrawals \/ debits|money out \/ debit)$/],
    ['credit', /^(?:credit|credits|deposit|deposits|paid in|money in|receipts|payments in|cr|in|credit amount|deposits \/ credits|money in \/ credit)$/],
    ['balance', /(?:^|\s)balance$/],
    ['qty', /^(?:qty|quantity|hours|hrs|units|unit|usage|count)$/],
    ['unit_price', /^(?:unit price|rate|price|unit cost|price each|each|unit amount|price per unit)$/],
    ['tax', /^(?:tax|vat|gst|tax rate|vat rate|tax amount|vat amount)$/],
    ['amount', /^(?:amount|total|line total|net amount|net|total price|ext price|extended price|extended|sum|cost|charges|subtotal|amount due)$/]
  ];
  var MONEY_KEYS = ['debit', 'credit', 'balance', 'amount', 'unit_price'];

  function normHeader(text) {
    return String(text).toLowerCase()
      .replace(/\(.*?\)/g, ' ')
      .replace(/[^a-z/ ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function detectHeader(row) {
    if (!row.cells || row.cells.length < 2 || row.cells.length > 12) return null;
    var cols = [];
    var seen = {};
    for (var i = 0; i < row.cells.length; i++) {
      var cell = row.cells[i];
      if (/\d{2,}/.test(cell.text)) return null;
      var norm = normHeader(cell.text);
      if (!norm) continue;
      for (var r = 0; r < HEADER_RULES.length; r++) {
        if (HEADER_RULES[r][1].test(norm)) {
          var key = HEADER_RULES[r][0];
          if (!seen[key]) {
            seen[key] = true;
            cols.push({ key: key, label: cell.text, x: cell.x, x2: cell.x2 });
          }
          break;
        }
      }
    }
    if (cols.length < 2) return null;
    var hasMoney = cols.some(function (col) { return MONEY_KEYS.indexOf(col.key) !== -1; });
    if (!hasMoney) return null;
    var map = {};
    cols.forEach(function (col) { map[col.key] = col; });
    return { cols: cols, map: map };
  }

  function nearestColumn(token, header, keys) {
    var best = null, bestDist = Infinity;
    for (var i = 0; i < header.cols.length; i++) {
      var col = header.cols[i];
      if (keys.indexOf(col.key) === -1) continue;
      var dist = Math.min(
        Math.abs(token.x2 - col.x2),
        Math.abs(token.x - col.x),
        Math.abs((token.x + token.x2) / 2 - (col.x + col.x2) / 2)
      );
      if (dist < bestDist) { bestDist = dist; best = col; }
    }
    return best ? { key: best.key, dist: bestDist } : null;
  }

  function assignColumns(nums, header, keys) {
    var out = {};
    var ok = true;
    nums.forEach(function (tok) {
      var hit = nearestColumn(tok, header, keys);
      if (!hit || out[hit.key]) { ok = false; return; }
      out[hit.key] = tok;
    });
    return ok ? out : null;
  }

  function medianSpacing(rows) {
    var gaps = [];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i].page !== rows[i - 1].page) continue;
      var gap = Math.abs(rows[i - 1].y - rows[i].y);
      if (gap > 1) gaps.push(gap);
    }
    if (!gaps.length) return 14;
    gaps.sort(function (a, b) { return a - b; });
    return gaps[Math.floor(gaps.length / 2)];
  }

  /* ------------------------------------------------------------------ *
   * Currency, document type, metadata
   * ------------------------------------------------------------------ */

  var CURRENCIES = ['USD', 'EUR', 'GBP', 'PKR', 'CAD', 'AUD'];

  function countMatches(text, re) {
    var m = text.match(re);
    return m ? m.length : 0;
  }

  function detectCurrency(text) {
    var score = {
      USD: countMatches(text, /\bUSD\b|US\$/g) * 3,
      EUR: countMatches(text, /\bEUR\b/g) * 3 + countMatches(text, /\u20AC/g),
      GBP: countMatches(text, /\bGBP\b/g) * 3 + countMatches(text, /\u00A3/g),
      PKR: countMatches(text, /\bPKR\b/g) * 3 + countMatches(text, /\u20A8|\bRs\.?(?=\s?\d)/g),
      CAD: countMatches(text, /\bCAD\b|CA\$|C\$/g) * 3,
      AUD: countMatches(text, /\bAUD\b|AU\$|A\$/g) * 3
    };
    var dollars = countMatches(text, /\$/g);
    if (dollars) {
      if (score.CAD > 0 && score.CAD >= score.AUD && score.CAD >= score.USD) score.CAD += dollars;
      else if (score.AUD > 0 && score.AUD >= score.USD) score.AUD += dollars;
      else score.USD += dollars;
    }
    var best = '', bestScore = 0;
    CURRENCIES.forEach(function (code) {
      if (score[code] > bestScore) { best = code; bestScore = score[code]; }
    });
    return best;
  }

  function detectType(text) {
    var t = text.toLowerCase();
    var bank = 0, invoice = 0, receipt = 0;
    [/statement period/, /opening balance/, /closing balance/, /beginning balance/, /ending balance/,
      /account statement/, /bank statement/, /statement of account/, /balance brought forward/, /sort code/,
      /available balance/, /withdrawals?/, /deposits?/, /\biban\b/].forEach(function (re) { if (re.test(t)) bank += 2; });
    if (/\bstatement\b/.test(t)) bank += 1;
    if (/\binvoice\b/.test(t)) invoice += 4;
    [/bill(?:ed)? to/, /due date/, /unit price/, /\bqty\b|\bquantity\b/, /sub-?total/, /amount due/, /payment terms/, /purchase order|\bp\.?o\.? number/]
      .forEach(function (re) { if (re.test(t)) invoice += 1; });
    if (/\breceipt\b/.test(t)) receipt += 4;
    [/order (?:number|no|#|id)/, /payment method/, /\bpaid\b/, /thank you/, /change due/, /cashier/, /card ending|ending in \d{4}/]
      .forEach(function (re) { if (re.test(t)) receipt += 1; });
    if (bank >= invoice && bank >= receipt && bank >= 3) return 'bank';
    if (receipt > invoice) return 'receipt';
    return 'invoice';
  }

  /**
   * Find a labelled value. The value may sit in the same cell after the label,
   * in the next cell on the row, or in the cell directly underneath.
   */
  function findLabeled(rows, labelRe, valueRe, limit) {
    var max = Math.min(rows.length, limit || rows.length);
    for (var i = 0; i < max; i++) {
      var cells = rows[i].cells;
      for (var c = 0; c < cells.length; c++) {
        var m = labelRe.exec(cells[c].text);
        if (!m) continue;
        var after = cells[c].text.slice(m.index + m[0].length).replace(/^[\s:#.\-\u2013\u2014]+/, '');
        var hit = after ? valueRe.exec(after) : null;
        if (hit) return hit;
        if (!after && cells[c + 1]) {
          hit = valueRe.exec(cells[c + 1].text.replace(/^[\s:#]+/, ''));
          if (hit) return hit;
        }
        if (!after && rows[i + 1] && rows[i + 1].page === rows[i].page) {
          var below = null, dist = Infinity;
          rows[i + 1].cells.forEach(function (cell) {
            var d = Math.min(Math.abs(cell.x - cells[c].x), Math.abs(cell.x2 - cells[c].x2));
            if (d < dist) { dist = d; below = cell; }
          });
          if (below && dist < 40) {
            hit = valueRe.exec(below.text);
            if (hit) return hit;
          }
        }
      }
    }
    return null;
  }

  var RE_VALUE_DATE = new RegExp('^(' + DATE_SRC + ')', 'i');
  var RE_VALUE_ID = /^([A-Za-z0-9][A-Za-z0-9\-\/_.]{1,31})(?=\s|$)/;
  var RE_PERIOD = new RegExp('(?:period|from)\\s*:?\\s*(' + DATE_SRC + ')\\s*(?:-|\\u2013|\\u2014|to|through|until|thru)\\s*(' + DATE_SRC + ')', 'i');
  var RE_PERIOD_BARE = new RegExp('(' + DATE_SRC + ')\\s*(?:-|\\u2013|\\u2014|to|through)\\s*(' + DATE_SRC + ')', 'i');
  var RE_IBAN = /\b([A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?)\b/;
  var RE_ACCOUNT = /\b(?:account|acct|a\/c)\s*(?:number|num|no\.?|#)?\s*[:#]?\s*((?:[xX*\u2022.\-]{2,}[\s-]?)?\d[\d\s\-]{2,22}\d)/i;

  var NUMBER_LABELS = [
    /\binvoice\s*(?:number|num|no\.?|#|id)(?![a-z])|\binvoice(?=\s*[:#])/i,
    /\bstatement\s*(?:number|num|no\.?|#|id)(?![a-z])/i,
    /\breceipt\s*(?:number|num|no\.?|#|id)(?![a-z])|\breceipt(?=\s*[:#])/i,
    /\border\s*(?:number|num|no\.?|#|id)(?![a-z])/i,
    /\b(?:bill|document|reference|ref|transaction|confirmation)\s*(?:number|num|no\.?|#|id)(?![a-z])|\bref(?:erence)?(?=\s*[:#])/i
  ];
  var ISSUE_LABELS = [
    /\b(?:invoice date|date of issue|issue date|date issued|issued on|statement date|billing date|bill date|receipt date|order date|date paid|payment date|paid on|order placed)\b/i,
    /^\s*(?:date|issued|dated)\b/i
  ];
  var DUE_LABELS = [
    /\b(?:due date|payment due date|payment due|date due|due on|due by|pay by)\b/i,
    /^\s*due\b/i
  ];

  var KNOWN_VENDORS = [
    ['Amazon Web Services', /amazon web services|\baws\b/i], ['Google Cloud', /google cloud/i], ['Google Ads', /google ads/i],
    ['Microsoft Azure', /microsoft azure|\bazure\b/i], ['Stripe', /\bstripe\b/i], ['PayPal', /\bpaypal\b/i],
    ['DigitalOcean', /digitalocean/i], ['Vercel', /\bvercel\b/i], ['GitHub', /\bgithub\b/i], ['Shopify', /\bshopify\b/i],
    ['Meta Platforms', /meta platforms|facebook ads|meta ads/i], ['Cloudflare', /cloudflare/i], ['OpenAI', /\bopenai\b/i],
    ['Slack', /slack technologies|\bslack\b/i], ['Zoom', /zoom video|zoom\.us/i], ['HubSpot', /hubspot/i],
    ['Atlassian', /atlassian/i], ['Notion', /notion labs/i], ['LinkedIn', /linkedin/i],
    ['JPMorgan Chase', /jpmorgan chase|\bchase\b/i], ['Bank of America', /bank of america/i], ['Wells Fargo', /wells fargo/i],
    ['HSBC', /\bhsbc\b/i], ['Barclays', /\bbarclays\b/i], ['Revolut', /\brevolut\b/i], ['Wise', /\bwise (?:payments|europe|us)\b|transferwise/i],
    ['Standard Chartered', /standard chartered/i], ['Citibank', /citibank|\bciti\b/i], ['Capital One', /capital one/i],
    ['American Express', /american express|\bamex\b/i], ['TD Bank', /\btd bank\b|td canada trust/i], ['Lloyds Bank', /lloyds/i],
    ['NatWest', /natwest/i], ['Santander', /santander/i], ['Monzo', /\bmonzo\b/i], ['N26', /\bn26\b/i],
    ['Commonwealth Bank', /commonwealth bank|commbank/i], ['Royal Bank of Canada', /royal bank of canada|\brbc\b/i],
    ['HBL', /habib bank|\bhbl\b/i], ['Meezan Bank', /meezan/i], ['U.S. Bank', /u\.?s\.? bank\b/i],
    ['Amazon', /amazon\.[a-z.]+|\bamazon\b/i], ['eBay', /\bebay\b/i], ['Etsy', /\betsy\b/i], ['Uber', /\buber\b/i],
    ['Airbnb', /airbnb/i], ['Walmart', /walmart/i], ['Apple', /apple (?:inc|distribution|store)|apple\.com/i],
    ['Upwork', /upwork/i], ['Fiverr', /fiverr/i], ['Square', /square,? inc|squareup|block,? inc/i], ['Payoneer', /payoneer/i]
  ];
  var RE_GENERIC_TITLE = /^(?:tax\s+)?(?:invoice|statement|receipt|bill|credit note|statement of account|account statement|bank statement|page\b|date\b|original|copy|paid)\b/i;

  function lastNum(analysis) {
    return analysis.nums.length ? analysis.nums[analysis.nums.length - 1] : null;
  }

  var SUMMARY_LABELS = {
    subtotal: /^(?:sub[\s-]?total|net total|net amount|total before tax|total excl(?:uding)?\.? (?:tax|vat|gst))\b/i,
    tax: /^(?:total\s+)?(?:sales tax|vat|gst|hst|pst|tax)\b(?!\s*(?:id|no\b|number|reg|invoice|#|point|date))/i,
    totalStrong: /^(?:amount due|total due|balance due|grand total|total amount|invoice total|total paid|amount paid|total charged|order total|total payable|total incl)/i,
    total: /^total\b/i,
    opening: /^(?:opening balance|beginning balance|previous balance|balance brought forward|brought forward|balance b\/f|starting balance|previous statement balance)\b/i,
    closing: /^(?:closing balance|ending balance|new balance|balance carried forward|carried forward|balance c\/f|closing ledger balance|current balance)\b/i
  };

  function extractMeta(rows, analyses, type, ctx, fullText) {
    var meta = {
      number: '', issueDate: '', dueDate: '', periodStart: '', periodEnd: '',
      vendor: '', currency: ctx.currency || '', subtotal: null, tax: null, total: null,
      openingBalance: null, closingBalance: null, accountNumber: '', iban: ''
    };
    var i, hit;

    for (i = 0; i < NUMBER_LABELS.length && !meta.number; i++) {
      hit = findLabeled(rows, NUMBER_LABELS[i], RE_VALUE_ID, 80);
      if (hit && /\d/.test(hit[1]) && !parseDate(hit[1], ctx)) meta.number = hit[1].replace(/[.,;]+$/, '');
    }
    for (i = 0; i < ISSUE_LABELS.length && !meta.issueDate; i++) {
      hit = findLabeled(rows, ISSUE_LABELS[i], RE_VALUE_DATE, 80);
      if (hit) meta.issueDate = parseDate(hit[1], ctx) || '';
    }
    for (i = 0; i < DUE_LABELS.length && !meta.dueDate; i++) {
      hit = findLabeled(rows, DUE_LABELS[i], RE_VALUE_DATE, 120);
      if (hit) meta.dueDate = parseDate(hit[1], ctx) || '';
    }

    var head = Math.min(rows.length, 60);
    for (i = 0; i < head; i++) {
      var period = RE_PERIOD.exec(rows[i].text) || (type === 'bank' ? RE_PERIOD_BARE.exec(rows[i].text) : null);
      if (period) {
        var start = parseDate(period[1], ctx), end = parseDate(period[2], ctx);
        if (start && end && start <= end) {
          meta.periodStart = start;
          meta.periodEnd = end;
          if (!meta.issueDate) meta.issueDate = end;
          break;
        }
      }
    }

    var iban = RE_IBAN.exec(fullText);
    if (iban && iban[1].replace(/\s/g, '').length >= 15) meta.iban = iban[1].replace(/\s+/g, ' ').trim();
    var acct = RE_ACCOUNT.exec(fullText);
    if (acct) meta.accountNumber = acct[1].replace(/\s+/g, ' ').trim();

    // Vendor: explicit label, then known brands near the top, then the first prominent line.
    var from = findLabeled(rows, /^(?:from|seller|vendor|supplier|billed by|sold by|merchant|issued by)\b/i, /^([A-Za-z0-9][^|]{2,60})/, 40);
    if (from) meta.vendor = from[1].trim();
    if (!meta.vendor) {
      var top = rows.slice(0, 10).map(function (r) { return r.text; }).join(' \n ');
      for (i = 0; i < KNOWN_VENDORS.length; i++) {
        if (KNOWN_VENDORS[i][1].test(top)) { meta.vendor = KNOWN_VENDORS[i][0]; break; }
      }
    }
    if (!meta.vendor) {
      for (i = 0; i < Math.min(rows.length, 12); i++) {
        var first = rows[i].cells[0] ? rows[i].cells[0].text.trim() : '';
        if (first.length < 3 || first.length > 70) continue;
        if (!/[A-Za-z]{3,}/.test(first) || RE_GENERIC_TITLE.test(first)) continue;
        if (/[:@]|https?:|www\./i.test(first) || parseDate(first, ctx)) continue;
        meta.vendor = first;
        break;
      }
    }

    // Money summary rows: the label must open the row (after any leading date).
    for (i = 0; i < rows.length; i++) {
      var a = analyses[i];
      var tok = lastNum(a);
      if (!tok || !a.desc) continue;
      var label = a.desc;
      if (SUMMARY_LABELS.opening.test(label)) { if (meta.openingBalance === null) meta.openingBalance = tok.value; continue; }
      if (SUMMARY_LABELS.closing.test(label)) { meta.closingBalance = tok.value; continue; }
      if (type === 'bank') continue;
      if (SUMMARY_LABELS.subtotal.test(label)) { if (meta.subtotal === null) meta.subtotal = tok.value; continue; }
      if (SUMMARY_LABELS.totalStrong.test(label)) { meta.total = tok.value; meta._strongTotal = true; continue; }
      if (SUMMARY_LABELS.tax.test(label)) { meta.tax = round2((meta.tax || 0) + tok.value); continue; }
      if (SUMMARY_LABELS.total.test(label) && !meta._strongTotal) { meta.total = tok.value; }
    }
    delete meta._strongTotal;
    if (meta.total === null && meta.subtotal !== null) meta.total = round2(meta.subtotal + (meta.tax || 0));
    return meta;
  }

  /* ------------------------------------------------------------------ *
   * Bank statement transactions
   * ------------------------------------------------------------------ */

  var RE_BANK_SKIP = /^(?:total|sub[\s-]?total|totals|page \d|continued|statement (?:of|date|period)|summary|average|interest rate|overdraft limit)\b/i;
  var RE_DEBIT_WORDS = /\b(?:payment to|purchase|withdrawal|withdraw|debit|fee|fees|charge|charges|pos|atm|direct debit|standing order|card payment|bill pay|transfer to|cheque|check #|tax|subscription)\b/i;
  var RE_CREDIT_WORDS = /\b(?:deposit|salary|payroll|credit|refund|interest paid|interest earned|reversal|transfer from|received|payout|cashback|dividend)\b/i;

  function extractBank(rows, analyses, meta) {
    var header = null, out = [], last = null, lastRow = null;
    var spacing = medianSpacing(rows);
    var bankKeys = ['debit', 'credit', 'balance', 'amount'];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var hdr = detectHeader(row);
      if (hdr && (hdr.map.date || hdr.map.balance || hdr.map.debit || hdr.map.credit)) { header = hdr; last = null; continue; }
      var a = analyses[i];
      if (a.desc && (SUMMARY_LABELS.opening.test(a.desc) || SUMMARY_LABELS.closing.test(a.desc) || RE_BANK_SKIP.test(a.desc))) {
        last = null;
        continue;
      }
      // Many banks print the date once per day: a dated-table row with a
      // description and an amount but no date inherits the date above it.
      var inherits = !a.date && last && header && a.desc && /[A-Za-z]/.test(a.desc) &&
        row.page === lastRow.page && a.nums.some(function (n) { return n.money; });
      if ((a.date && a.nums.length) || inherits) {
        var txn = { date: a.date || last.date, description: a.desc, debit: null, credit: null, amount: null, balance: null };
        var known = false;
        var slots = header ? assignColumns(a.nums, header, bankKeys.filter(function (k) { return header.map[k]; })) : null;
        if (!slots) {
          slots = {};
          slots.amount = a.nums[0];
          if (a.nums.length >= 2) slots.balance = a.nums[a.nums.length - 1];
        }
        if (slots.debit || slots.credit) {
          var debit = slots.debit ? slots.debit.abs : 0;
          var credit = slots.credit ? slots.credit.abs : 0;
          txn.amount = round2(credit - debit);
          known = true;
        } else if (slots.amount) {
          txn.amount = slots.amount.value;
          known = slots.amount.explicit;
        }
        if (slots.balance) txn.balance = slots.balance.value;
        if (txn.amount === null && txn.balance === null) { last = null; continue; }
        txn._known = known;
        out.push(txn);
        last = txn;
        lastRow = row;
        continue;
      }
      if (last && !a.date && !a.nums.length && row.page === lastRow.page &&
          Math.abs(lastRow.y - row.y) <= spacing * 1.7 && row.text.length <= 140 && !RE_BANK_SKIP.test(row.text)) {
        last.description = (last.description + ' ' + row.text.trim()).trim();
        lastRow = row;
        continue;
      }
      last = null;
    }

    // Resolve unsigned amounts from the running balance, then from wording.
    for (var t = 0; t < out.length; t++) {
      var cur = out[t];
      if (cur.amount === null) continue;
      if (!cur._known && cur.balance !== null) {
        var prev = t > 0 ? out[t - 1].balance : meta.openingBalance;
        var next = t + 1 < out.length ? out[t + 1].balance : null;
        var v = Math.abs(cur.amount);
        if (prev !== null && prev !== undefined && approx(prev + v, cur.balance)) { cur.amount = v; cur._known = true; }
        else if (prev !== null && prev !== undefined && approx(prev - v, cur.balance)) { cur.amount = -v; cur._known = true; }
        else if (next !== null && approx(next + v, cur.balance)) { cur.amount = v; cur._known = true; }
        else if (next !== null && approx(next - v, cur.balance)) { cur.amount = -v; cur._known = true; }
      }
      if (!cur._known) {
        if (RE_CREDIT_WORDS.test(cur.description)) cur.amount = Math.abs(cur.amount);
        else if (RE_DEBIT_WORDS.test(cur.description)) cur.amount = -Math.abs(cur.amount);
      }
      cur.amount = round2(cur.amount);
      if (cur.amount < 0) { cur.debit = round2(-cur.amount); cur.credit = null; }
      else { cur.credit = cur.amount; cur.debit = null; }
      delete cur._known;
    }
    out.forEach(function (o) { delete o._known; });

    var columns = [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'description', label: 'Description', type: 'text' },
      { key: 'debit', label: 'Debit', type: 'number' },
      { key: 'credit', label: 'Credit', type: 'number' },
      { key: 'amount', label: 'Amount', type: 'number' },
      { key: 'balance', label: 'Balance', type: 'number' }
    ];
    if (!out.some(function (o) { return o.balance !== null; })) columns.pop();
    return { columns: columns, rows: out };
  }

  /* ------------------------------------------------------------------ *
   * Invoice / receipt line items
   * ------------------------------------------------------------------ */

  var RE_ITEM_SUMMARY = /^(?:sub[\s-]?total|total|totals|grand total|net total|net amount|amount due|balance due|balance|tax|vat|gst|hst|pst|sales tax|discount|shipping|delivery|freight|amount paid|paid|payment|payments|credit applied|change|cash|card|visa|mastercard|amex|tip|gratuity|rounding|deposit)\b/i;
  var RE_ITEM_NOISE = /\b(?:invoice|receipt|date|due|bill(?:ed)? to|ship(?:ped)? to|sold to|page|tax id|vat (?:no|number|reg)|phone|tel|fax|account|iban|swift|bic|order|customer|po box|terms|reference|ref|statement|period|routing|sort code)\b/i;

  function extractItems(rows, analyses, meta) {
    var header = null, out = [], last = null, lastRow = null, ended = false;
    var spacing = medianSpacing(rows);
    var itemKeys = ['qty', 'unit_price', 'tax', 'amount'];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var hdr = detectHeader(row);
      if (hdr && (hdr.map.amount || hdr.map.unit_price) && !hdr.map.balance) { header = hdr; ended = false; last = null; continue; }
      var a = analyses[i];
      var label = a.desc;
      if (label && RE_ITEM_SUMMARY.test(label)) {
        if (header) ended = true;
        last = null;
        continue;
      }
      if (header && ended) continue;

      var hasMoney = a.nums.some(function (n) { return n.money; });
      if (a.nums.length && hasMoney && /[A-Za-z]/.test(label)) {
        if (!header && RE_ITEM_NOISE.test(label)) { last = null; continue; }
        var item = { description: label, qty: null, unit_price: null, tax: null, amount: null };
        if (a.date) item.date = a.date;
        var slots = header ? assignColumns(a.nums, header, itemKeys.filter(function (k) { return header.map[k]; })) : null;
        if (slots) {
          if (slots.qty) item.qty = slots.qty.abs;
          if (slots.unit_price) item.unit_price = slots.unit_price.value;
          if (slots.tax) item.tax = slots.tax.value;
          if (slots.amount) item.amount = slots.amount.value;
          if (item.amount === null && item.unit_price !== null) {
            item.amount = round2(item.unit_price * (item.qty === null ? 1 : item.qty));
          }
        } else {
          var n = a.nums.length;
          item.amount = a.nums[n - 1].value;
          if (n >= 3) {
            item.qty = a.nums[n - 3].abs;
            item.unit_price = a.nums[n - 2].value;
            if (!approx(round2(item.qty * item.unit_price), item.amount) && approx(round2(a.nums[n - 2].abs * a.nums[n - 3].value), item.amount)) {
              item.qty = a.nums[n - 2].abs;
              item.unit_price = a.nums[n - 3].value;
            }
          } else if (n === 2) {
            var other = a.nums[0];
            if (!other.money || other.decimals === 0) {
              item.qty = other.abs;
              if (other.abs) item.unit_price = round2(item.amount / other.abs);
            } else {
              item.unit_price = other.value;
              var ratio = other.value ? item.amount / other.value : 0;
              if (ratio > 0 && approx(ratio, Math.round(ratio))) item.qty = Math.round(ratio);
            }
          }
        }
        if (item.amount === null) { last = null; continue; }
        out.push(item);
        last = item;
        lastRow = row;
        continue;
      }
      if (last && header && !a.nums.length && !a.date && row.page === lastRow.page &&
          Math.abs(lastRow.y - row.y) <= spacing * 1.7 && row.text.length <= 140) {
        last.description = (last.description + ' ' + row.text.trim()).trim();
        lastRow = row;
        continue;
      }
      last = null;
    }

    var columns = [];
    if (out.some(function (o) { return o.date; })) columns.push({ key: 'date', label: 'Date', type: 'date' });
    columns.push({ key: 'description', label: 'Description', type: 'text' });
    columns.push({ key: 'qty', label: 'Qty', type: 'number' });
    columns.push({ key: 'unit_price', label: 'Unit Price', type: 'number' });
    if (out.some(function (o) { return o.tax !== null; })) columns.push({ key: 'tax', label: 'Tax', type: 'number' });
    columns.push({ key: 'amount', label: 'Amount', type: 'number' });
    out.forEach(function (o) {
      if (columns[0].key === 'date' && !o.date) o.date = '';
      if (!columns.some(function (col) { return col.key === 'tax'; })) delete o.tax;
    });
    return { columns: columns, rows: out };
  }

  /* ------------------------------------------------------------------ *
   * Custom regex templates
   * ------------------------------------------------------------------ */

  var NUMERIC_GROUPS = /^(?:amount|debit|credit|balance|total|subtotal|tax|vat|qty|quantity|unit_price|price|rate)$/i;

  function titleCase(key) {
    return String(key).replace(/_/g, ' ').replace(/\b[a-z]/g, function (ch) { return ch.toUpperCase(); });
  }

  /**
   * Apply a user regex (with named groups) to every reconstructed row.
   * Example: ^(?<date>\d{2}/\d{2}/\d{4})\s+(?<description>.+?)\s+(?<amount>-?[\d,]+\.\d{2})$
   */
  function applyTemplate(rows, pattern, ctx) {
    var re;
    try {
      re = new RegExp(pattern, 'i');
    } catch (err) {
      throw new Error('Invalid regular expression: ' + err.message);
    }
    var names = [];
    var nameRe = /\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g, m;
    while ((m = nameRe.exec(pattern))) if (names.indexOf(m[1]) === -1) names.push(m[1]);
    if (!names.length) throw new Error('Add at least one named group, for example (?<date>...) (?<description>...) (?<amount>...).');
    var columns = names.map(function (name) {
      var type = /date/i.test(name) ? 'date' : (NUMERIC_GROUPS.test(name) ? 'number' : 'text');
      return { key: name, label: titleCase(name), type: type };
    });
    var out = [];
    rows.forEach(function (row) {
      var hit = re.exec(row.text);
      if (!hit || !hit.groups) return;
      var rec = {};
      columns.forEach(function (col) {
        var raw = hit.groups[col.key];
        if (raw === undefined || raw === null) { rec[col.key] = col.type === 'number' ? null : ''; return; }
        raw = String(raw).trim();
        if (col.type === 'number') {
          var num = parseAmount(raw);
          rec[col.key] = num ? num.value : raw;
        } else if (col.type === 'date') {
          rec[col.key] = parseDate(raw, ctx || {}) || raw;
        } else {
          rec[col.key] = raw;
        }
      });
      out.push(rec);
    });
    return { columns: columns, rows: out };
  }

  /* ------------------------------------------------------------------ *
   * Reconciliation + entry point
   * ------------------------------------------------------------------ */

  function sumOf(rows, key) {
    var total = 0, any = false;
    rows.forEach(function (r) {
      if (typeof r[key] === 'number' && isFinite(r[key])) { total += r[key]; any = true; }
    });
    return any ? round2(total) : null;
  }

  function reconcile(type, meta, rows) {
    var sum = sumOf(rows, 'amount');
    if (sum === null) return { status: 'unknown', message: '' };
    if (type === 'bank') {
      if (meta.openingBalance === null || meta.closingBalance === null) {
        return { status: 'unknown', message: 'Net movement ' + sum.toFixed(2) + ' (no opening/closing balance found to check against).' };
      }
      var expected = round2(meta.openingBalance + sum);
      return approx(expected, meta.closingBalance)
        ? { status: 'ok', message: 'Opening balance + transactions = closing balance (' + meta.closingBalance.toFixed(2) + ').' }
        : { status: 'mismatch', message: 'Opening balance + transactions = ' + expected.toFixed(2) + ', but the closing balance reads ' + meta.closingBalance.toFixed(2) + '. Review the rows.' };
    }
    var target = meta.subtotal !== null ? meta.subtotal
      : (meta.total !== null ? round2(meta.total - (meta.tax || 0)) : null);
    if (target === null) return { status: 'unknown', message: 'Line items sum to ' + sum.toFixed(2) + ' (no subtotal found to check against).' };
    if (approx(sum, target)) return { status: 'ok', message: 'Line items sum to the document ' + (meta.subtotal !== null ? 'subtotal' : 'total') + ' (' + target.toFixed(2) + ').' };
    if (meta.total !== null && approx(sum, meta.total)) return { status: 'ok', message: 'Line items sum to the document total (' + meta.total.toFixed(2) + ').' };
    return { status: 'mismatch', message: 'Line items sum to ' + sum.toFixed(2) + ', but the document shows ' + target.toFixed(2) + '. Review the rows.' };
  }

  /**
   * Parse reconstructed rows into structured data.
   * @param {{name?:string, rows:Array}} doc
   * @param {{preset?:'auto'|'bank'|'invoice'|'receipt', template?:string}} [options]
   */
  function parseDocument(doc, options) {
    options = options || {};
    var rows = (doc && doc.rows) || [];
    var warnings = [];
    var fullText = rows.map(function (r) { return r.text; }).join('\n');
    var preset = options.preset && options.preset !== 'auto' ? options.preset : '';
    var type = preset || detectType(fullText);
    var currency = detectCurrency(fullText);
    var order = detectDateOrder(fullText, currency);

    var baseCtx = { order: order, currency: currency };
    var probe = rows.map(function (row) { return analyzeRow(row, baseCtx, {}); });
    var meta = extractMeta(rows, probe, type, baseCtx, fullText);
    meta.type = type;
    meta.dateOrder = order;

    var anchor = meta.periodEnd || meta.issueDate || '';
    var anchorYear = anchor ? +anchor.slice(0, 4) : new Date().getFullYear();
    var anchorMonth = anchor ? +anchor.slice(5, 7) : 12;
    var ctx = {
      order: order,
      currency: currency,
      allowShort: type === 'bank',
      resolveYear: function (month) { return anchor && month > anchorMonth ? anchorYear - 1 : anchorYear; }
    };

    var table;
    if (options.template) {
      table = applyTemplate(rows, options.template, ctx);
    } else if (type === 'bank') {
      var bankAnalyses = rows.map(function (row) { return analyzeRow(row, ctx, {}); });
      // Balances may sit behind a year-less date ("01 Oct Opening Balance 4,250.00").
      rows.forEach(function (row, idx) {
        var a = bankAnalyses[idx], tok = lastNum(a);
        if (!tok || !a.desc) return;
        if (SUMMARY_LABELS.opening.test(a.desc) && meta.openingBalance === null) meta.openingBalance = tok.value;
        if (SUMMARY_LABELS.closing.test(a.desc)) meta.closingBalance = tok.value;
      });
      table = extractBank(rows, bankAnalyses, meta);
      if (!meta.periodStart && table.rows.length) {
        var dates = table.rows.map(function (r) { return r.date; }).filter(Boolean).sort();
        if (dates.length) { meta.periodStart = dates[0]; meta.periodEnd = dates[dates.length - 1]; }
      }
    } else {
      var itemAnalyses = rows.map(function (row) { return analyzeRow(row, ctx, { plainNumbers: true }); });
      table = extractItems(rows, itemAnalyses, meta);
    }

    if (!rows.length) {
      warnings.push('No text layer found. This PDF looks like a scanned image; VaultParse reads digital (text-based) PDFs and does not run OCR.');
    } else if (!table.rows.length) {
      warnings.push('No table rows were detected with the "' + type + '" rules. Try a different preset or a custom regex template.');
    }

    var check = options.template ? { status: 'unknown', message: '' } : reconcile(type, meta, table.rows);
    meta.reconciled = check.status;
    meta.reconcileNote = check.message;

    return {
      name: (doc && doc.name) || 'document.pdf',
      docType: type,
      meta: meta,
      columns: table.columns,
      rows: table.rows,
      warnings: warnings,
      stats: { sourceRows: rows.length, extractedRows: table.rows.length, pages: (doc && doc.pageCount) || 1 }
    };
  }

  return {
    parseDocument: parseDocument,
    parseAmount: parseAmount,
    parseDate: parseDate,
    analyzeRow: analyzeRow,
    detectHeader: detectHeader,
    detectCurrency: detectCurrency,
    detectType: detectType,
    detectDateOrder: detectDateOrder,
    applyTemplate: applyTemplate,
    reconcile: reconcile,
    CURRENCIES: CURRENCIES
  };
});

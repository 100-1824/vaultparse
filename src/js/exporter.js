/*!
 * VaultParse — exporter.js
 * Formatters and downloads: Standard CSV, Excel (.xlsx via SheetJS), clean JSON,
 * Xero bank-import CSV, QuickBooks Online CSV and QuickBooks Desktop IIF.
 * Everything is generated in memory and saved through a local Blob URL.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VaultParse = root.VaultParse || {};
  root.VaultParse.Exporter = api;
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict';

  var GENERATOR = 'VaultParse';

  /* ----------------------------- helpers ----------------------------- */

  function isNumber(v) { return typeof v === 'number' && isFinite(v); }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  /** Neutralise spreadsheet formula injection in free-text cells. */
  function safeText(value) {
    var s = String(value == null ? '' : value);
    if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d[\d.,]*$/.test(s))) return "'" + s;
    return s;
  }

  function cellValue(value) {
    if (value === null || value === undefined) return '';
    if (isNumber(value)) return value;
    return safeText(value);
  }

  function csvEscape(value) {
    var s = String(value);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Serialise an array-of-arrays to RFC 4180 CSV (PapaParse when present). */
  function unparse(matrix) {
    var papa = root.Papa;
    if (papa && typeof papa.unparse === 'function') {
      return papa.unparse(matrix, { newline: '\r\n' });
    }
    return matrix.map(function (line) { return line.map(csvEscape).join(','); }).join('\r\n');
  }

  function baseName(name) {
    return String(name || 'document').replace(/\.pdf$/i, '').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '') || 'document';
  }

  function fileStem(docs) {
    if (!docs.length) return 'vaultparse-export';
    if (docs.length === 1) return baseName(docs[0].name);
    return 'vaultparse-batch-' + docs.length + '-files';
  }

  function formatDate(isoDate, pattern) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''));
    if (!m) return String(isoDate || '');
    if (pattern === 'DMY') return m[3] + '/' + m[2] + '/' + m[1];
    if (pattern === 'MDY') return m[2] + '/' + m[3] + '/' + m[1];
    return m[0];
  }

  /* ------------------------- tabular exports ------------------------- */

  /** Build header + rows for one or more documents (adds "Source File" for batches). */
  function toMatrix(docs) {
    var multi = docs.length > 1;
    var columns = [];
    var seen = {};
    docs.forEach(function (doc) {
      doc.result.columns.forEach(function (col) {
        if (!seen[col.key]) { seen[col.key] = true; columns.push({ key: col.key, label: col.label }); }
      });
    });
    // In mixed batches keep the date column first, wherever it was first seen.
    columns.sort(function (a, b) { return (b.key === 'date') - (a.key === 'date'); });
    var header = columns.map(function (c) { return safeText(c.label); });
    if (multi) header.unshift('Source File');
    var matrix = [header];
    docs.forEach(function (doc) {
      doc.result.rows.forEach(function (row) {
        var line = columns.map(function (c) { return cellValue(row[c.key]); });
        if (multi) line.unshift(safeText(doc.name));
        matrix.push(line);
      });
    });
    return matrix;
  }

  function toCSV(docs) {
    return unparse(toMatrix(docs));
  }

  var META_FIELDS = [
    ['type', 'Document Type'], ['number', 'Invoice / Statement Number'], ['vendor', 'Vendor / Bank'],
    ['issueDate', 'Issue Date'], ['dueDate', 'Due Date'], ['periodStart', 'Period Start'], ['periodEnd', 'Period End'],
    ['currency', 'Currency'], ['subtotal', 'Subtotal'], ['tax', 'Tax / VAT'], ['total', 'Total Amount'],
    ['openingBalance', 'Opening Balance'], ['closingBalance', 'Closing Balance'],
    ['accountNumber', 'Account Number'], ['iban', 'IBAN'], ['reconciled', 'Reconciliation']
  ];

  function cleanMeta(meta) {
    var out = {};
    META_FIELDS.forEach(function (field) {
      var value = meta[field[0]];
      if (value === null || value === undefined || value === '') return;
      out[field[0]] = value;
    });
    return out;
  }

  function toJSONObject(docs) {
    return {
      generator: GENERATOR,
      exportedAt: new Date().toISOString(),
      documentCount: docs.length,
      documents: docs.map(function (doc) {
        var res = doc.result;
        return {
          file: doc.name,
          type: res.docType,
          summary: cleanMeta(res.meta),
          columns: res.columns.map(function (c) { return { key: c.key, label: c.label, type: c.type }; }),
          rows: res.rows.map(function (row) {
            var rec = {};
            res.columns.forEach(function (c) {
              var v = row[c.key];
              rec[c.key] = v === undefined ? null : v;
            });
            return rec;
          })
        };
      })
    };
  }

  function toJSON(docs) {
    return JSON.stringify(toJSONObject(docs), null, 2);
  }

  /* ------------------------ accounting presets ------------------------ */

  /**
   * Flatten documents to ledger lines. Bank transactions keep their sign;
   * invoice / receipt lines become money out (negative) dated at the issue date.
   */
  function toLedger(docs) {
    var lines = [];
    docs.forEach(function (doc) {
      var res = doc.result, meta = res.meta || {};
      res.rows.forEach(function (row) {
        var amount = row.amount;
        if (!isNumber(amount)) {
          if (isNumber(row.credit) || isNumber(row.debit)) amount = (row.credit || 0) - (row.debit || 0);
          else return;
        }
        var bank = res.docType === 'bank';
        lines.push({
          date: row.date || meta.issueDate || meta.periodEnd || '',
          description: String(row.description == null ? '' : row.description),
          amount: round2(bank ? amount : -amount),
          payee: bank ? '' : (meta.vendor || ''),
          reference: bank ? '' : (meta.number || '')
        });
      });
    });
    return lines;
  }

  /** Xero "Import a statement" template: *Date, *Amount, Payee, Description, Reference, Check Number. */
  function toXeroCSV(docs) {
    var matrix = [['*Date', '*Amount', 'Payee', 'Description', 'Reference', 'Check Number']];
    toLedger(docs).forEach(function (l) {
      matrix.push([formatDate(l.date, 'DMY'), l.amount.toFixed(2), safeText(l.payee), safeText(l.description), safeText(l.reference), '']);
    });
    return unparse(matrix);
  }

  /** QuickBooks Online bank upload, 3-column layout: Date, Description, Amount. */
  function toQuickBooksCSV(docs) {
    var matrix = [['Date', 'Description', 'Amount']];
    toLedger(docs).forEach(function (l) {
      var text = [l.payee, l.description, l.reference].filter(Boolean).join(' - ');
      matrix.push([formatDate(l.date, 'MDY'), safeText(text), l.amount.toFixed(2)]);
    });
    return unparse(matrix);
  }

  /** QuickBooks Desktop IIF (tab-delimited) with balanced TRNS / SPL pairs. */
  function toQuickBooksIIF(docs, options) {
    options = options || {};
    var bankAccount = options.bankAccount || 'Checking';
    var income = options.incomeAccount || 'Uncategorized Income';
    var expense = options.expenseAccount || 'Uncategorized Expenses';
    function clean(s) { return String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim(); }
    var out = [
      ['!TRNS', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'].join('\t'),
      ['!SPL', 'TRNSTYPE', 'DATE', 'ACCNT', 'NAME', 'AMOUNT', 'DOCNUM', 'MEMO'].join('\t'),
      '!ENDTRNS'
    ];
    toLedger(docs).forEach(function (l) {
      var type = l.amount >= 0 ? 'DEPOSIT' : 'CHECK';
      var date = formatDate(l.date, 'MDY');
      var memo = clean(l.description);
      out.push(['TRNS', type, date, bankAccount, clean(l.payee), l.amount.toFixed(2), clean(l.reference), memo].join('\t'));
      out.push(['SPL', type, date, l.amount >= 0 ? income : expense, clean(l.payee), (-l.amount).toFixed(2), clean(l.reference), memo].join('\t'));
      out.push('ENDTRNS');
    });
    return out.join('\r\n') + '\r\n';
  }

  /* ------------------------------ Excel ------------------------------ */

  function sheetName(name, used) {
    var base = baseName(name).replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 28) || 'Sheet';
    var candidate = base, n = 2;
    while (used[candidate.toLowerCase()]) candidate = base.slice(0, 25) + ' ' + (n++);
    used[candidate.toLowerCase()] = true;
    return candidate;
  }

  function autoWidths(matrix) {
    var widths = [];
    matrix.forEach(function (line) {
      line.forEach(function (value, i) {
        var len = String(value == null ? '' : value).length + 2;
        widths[i] = Math.min(60, Math.max(widths[i] || 8, len));
      });
    });
    return widths.map(function (w) { return { wch: w }; });
  }

  /** Build a SheetJS workbook: a Summary sheet plus one data sheet per document. */
  function toWorkbook(docs, XLSX) {
    XLSX = XLSX || root.XLSX;
    if (!XLSX || !XLSX.utils) throw new Error('The Excel engine (SheetJS) is not loaded.');
    var wb = XLSX.utils.book_new();
    var used = { summary: true };

    var summary = [['File'].concat(META_FIELDS.map(function (f) { return f[1]; })).concat(['Rows'])];
    docs.forEach(function (doc) {
      var meta = doc.result.meta || {};
      summary.push([safeText(doc.name)].concat(META_FIELDS.map(function (f) { return cellValue(meta[f[0]]); })).concat([doc.result.rows.length]));
    });
    var summarySheet = XLSX.utils.aoa_to_sheet(summary);
    summarySheet['!cols'] = autoWidths(summary);
    XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

    docs.forEach(function (doc) {
      var matrix = toMatrix([doc]);
      var sheet = XLSX.utils.aoa_to_sheet(matrix);
      sheet['!cols'] = autoWidths(matrix);
      if (matrix.length > 1) sheet['!autofilter'] = { ref: sheet['!ref'] };
      XLSX.utils.book_append_sheet(wb, sheet, sheetName(doc.name, used));
    });
    wb.Props = { Title: 'VaultParse export', Author: GENERATOR, CreatedDate: new Date() };
    return wb;
  }

  /* ----------------------------- download ----------------------------- */

  function download(filename, content, mime) {
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  }

  var BOM = '﻿';

  var FORMATS = {
    csv: { label: 'Standard CSV', pro: false, ext: '.csv' },
    xlsx: { label: 'Excel Workbook', pro: false, ext: '.xlsx' },
    json: { label: 'Clean JSON', pro: false, ext: '.json' },
    xero: { label: 'Xero Bank Import CSV', pro: true, ext: '-xero.csv' },
    qbo: { label: 'QuickBooks Online CSV', pro: true, ext: '-quickbooks.csv' },
    iif: { label: 'QuickBooks Desktop IIF', pro: true, ext: '.iif' }
  };

  /** Generate and save one export. Returns the filename written. */
  function exportDocs(kind, docs) {
    var format = FORMATS[kind];
    if (!format) throw new Error('Unknown export format: ' + kind);
    if (!docs.length) throw new Error('Nothing to export yet.');
    var name = fileStem(docs) + format.ext;
    if (kind === 'csv') download(name, BOM + toCSV(docs), 'text/csv;charset=utf-8');
    else if (kind === 'json') download(name, toJSON(docs), 'application/json;charset=utf-8');
    else if (kind === 'xero') download(name, toXeroCSV(docs), 'text/csv;charset=utf-8');
    else if (kind === 'qbo') download(name, toQuickBooksCSV(docs), 'text/csv;charset=utf-8');
    else if (kind === 'iif') download(name, toQuickBooksIIF(docs), 'text/plain;charset=utf-8');
    else if (kind === 'xlsx') {
      var wb = toWorkbook(docs);
      var bytes = root.XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
      download(name, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    }
    return name;
  }

  return {
    FORMATS: FORMATS,
    META_FIELDS: META_FIELDS,
    toMatrix: toMatrix,
    toCSV: toCSV,
    toJSON: toJSON,
    toJSONObject: toJSONObject,
    toLedger: toLedger,
    toXeroCSV: toXeroCSV,
    toQuickBooksCSV: toQuickBooksCSV,
    toQuickBooksIIF: toQuickBooksIIF,
    toWorkbook: toWorkbook,
    exportDocs: exportDocs,
    download: download,
    formatDate: formatDate,
    safeText: safeText
  };
});

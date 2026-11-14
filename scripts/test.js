#!/usr/bin/env node
/**
 * VaultParse engine tests (no browser needed).
 * Runs the same modules the site ships: row reconstruction, the heuristic
 * parser, exporters, SHA-256 and license checksums.
 */
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');

const src = (file) => path.join(__dirname, '..', 'src', 'js', file);
const Engine = require(src('pdf_engine.js'));
const Parser = require(src('parser_rules.js'));
const Exporter = require(src('exporter.js'));
const App = require(src('app.js'));
const config = require('../config/app.config.json');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  FAIL ' + name + '\n       ' + String(err.message).split('\n').join('\n       '));
  }
}

console.log('VaultParse engine tests');

test('parseAmount: plain, grouped, European, negative, CR/DR, currency', () => {
  const cases = [
    ['1,234.56', 1234.56], ['(450.00)', -450], ['-450.00', -450], ['450.00-', -450],
    ['450.00 CR', 450], ['450.00 DR', -450], ['$1,234.56', 1234.56], ['-$12.00', -12],
    ['1.234,56', 1234.56], ['12,50', 12.5], ['€ 99,00', 99], ['PKR 12,500', 12500],
    ['Rs. 1,250.75', 1250.75], ['£1,000', 1000], ['0.096', 0.096], ['1,488', 1488],
    ['1.234.567,89', 1234567.89], ['− 15.20', -15.2]
  ];
  cases.forEach(([input, expected]) => {
    const got = Parser.parseAmount(input);
    assert.ok(got, 'not parsed: ' + input);
    assert.strictEqual(got.value, expected, input);
  });
  ['abc', '2026-10-01', '01/10/2026', 'INV-2026', '12:30', ''].forEach((bad) => {
    assert.strictEqual(Parser.parseAmount(bad), null, 'should reject ' + bad);
  });
  assert.strictEqual(Parser.parseAmount('450').money, false);
  assert.strictEqual(Parser.parseAmount('450.00').money, true);
});

test('parseDate: ISO, numeric (both orders), month names, short dates', () => {
  assert.strictEqual(Parser.parseDate('2026-11-03'), '2026-11-03');
  assert.strictEqual(Parser.parseDate('03 Nov 2026'), '2026-11-03');
  assert.strictEqual(Parser.parseDate('Nov 3, 2026'), '2026-11-03');
  assert.strictEqual(Parser.parseDate('3rd November 2026'), '2026-11-03');
  assert.strictEqual(Parser.parseDate('15-Jan-26'), '2026-01-15');
  assert.strictEqual(Parser.parseDate('25/12/2026'), '2026-12-25');
  assert.strictEqual(Parser.parseDate('12/25/2026'), '2026-12-25');
  assert.strictEqual(Parser.parseDate('03/04/2026', { order: 'MDY' }), '2026-03-04');
  assert.strictEqual(Parser.parseDate('03/04/2026', { order: 'DMY' }), '2026-04-03');
  assert.strictEqual(Parser.parseDate('31/02/2026'), null);
  assert.strictEqual(Parser.parseDate('Market 12'), null);
  assert.strictEqual(Parser.parseDate('02 Oct', { allowShort: true, resolveYear: () => 2026 }), '2026-10-02');
  assert.strictEqual(Parser.parseDate('10/02', { allowShort: true, order: 'MDY', resolveYear: () => 2026 }), '2026-10-02');
  assert.strictEqual(Parser.parseDate('02 Oct'), null);
});

test('reconstructRows: scrambled items are regrouped by y and sorted by x', () => {
  const items = [
    { str: '99.00', x: 500, y: 700.8, w: 25, h: 10 },
    { str: 'Second', x: 40, y: 684, w: 30, h: 10 },
    { str: 'Widget', x: 40, y: 700, w: 30, h: 10 },
    { str: '12.50', x: 500, y: 683.1, w: 25, h: 10 },
    { str: 'row', x: 73, y: 685.5, w: 15, h: 10 },
    { str: '   ', x: 200, y: 700, w: 10, h: 10 },
    { str: 'far below', x: 40, y: 600, w: 45, h: 10 }
  ];
  const rows = Engine.reconstructRows(items, { tolerance: 3.5 });
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0].cells.map((c) => c.text), ['Widget', '99.00']);
  assert.deepStrictEqual(rows[1].cells.map((c) => c.text), ['Second row', '12.50']);
  assert.strictEqual(rows[2].text, 'far below');
  const tight = Engine.reconstructRows(items, { tolerance: 0.5 });
  assert.ok(tight.length > 3, 'a tighter tolerance must split near rows');
});

const samples = App.Samples.list().map((sample) => ({
  name: sample.name,
  pageCount: 1,
  rows: Engine.reconstructRows(sample.items, { tolerance: config.engine.rowTolerance })
}));
const invoice = Parser.parseDocument(samples[0], { preset: 'auto' });
const statement = Parser.parseDocument(samples[1], { preset: 'auto' });

test('sample invoice: type, metadata and totals', () => {
  assert.strictEqual(invoice.docType, 'invoice');
  const m = invoice.meta;
  assert.strictEqual(m.number, 'INV-2026-0418');
  assert.strictEqual(m.issueDate, '2026-11-03');
  assert.strictEqual(m.dueDate, '2026-12-03');
  assert.strictEqual(m.vendor, 'Northwind Cloud Services Ltd');
  assert.strictEqual(m.currency, 'USD');
  assert.strictEqual(m.subtotal, 655.5);
  assert.strictEqual(m.tax, 54.08);
  assert.strictEqual(m.total, 709.58);
  assert.strictEqual(m.reconciled, 'ok', m.reconcileNote);
});

test('sample invoice: 7 line items with qty / unit price / amount', () => {
  assert.strictEqual(invoice.rows.length, 7, JSON.stringify(invoice.rows, null, 1));
  assert.deepStrictEqual(invoice.columns.map((c) => c.key), ['description', 'qty', 'unit_price', 'amount']);
  assert.deepStrictEqual(invoice.rows[0], { description: 'Compute instances — m5.large (us-east-1)', qty: 1488, unit_price: 0.096, amount: 142.85 });
  assert.strictEqual(invoice.rows[6].amount, -75);
  assert.strictEqual(invoice.rows[6].unit_price, -75);
});

test('sample statement: type, metadata, balances', () => {
  assert.strictEqual(statement.docType, 'bank');
  const m = statement.meta;
  assert.strictEqual(m.vendor, 'Meridian Community Bank');
  assert.strictEqual(m.currency, 'GBP');
  assert.strictEqual(m.periodStart, '2026-10-01');
  assert.strictEqual(m.periodEnd, '2026-10-31');
  assert.strictEqual(m.openingBalance, 4250);
  assert.strictEqual(m.closingBalance, 5410.48);
  assert.strictEqual(m.iban, 'GB29 MRDN 4011 6200 0048 21');
  assert.ok(/4821/.test(m.accountNumber), 'account: ' + m.accountNumber);
  assert.strictEqual(m.reconciled, 'ok', m.reconcileNote);
});

test('sample statement: 12 signed transactions, wrapped description merged', () => {
  assert.strictEqual(statement.rows.length, 12, JSON.stringify(statement.rows, null, 1));
  const first = statement.rows[0];
  assert.deepStrictEqual(first, { date: '2026-10-02', description: 'Direct Debit — Octopus Energy', debit: 86.4, credit: null, amount: -86.4, balance: 4163.6 });
  const wrapped = statement.rows[2];
  assert.strictEqual(wrapped.credit, 1850);
  assert.ok(/Ref: ATLAS\/OCT\/RETAINER$/.test(wrapped.description), wrapped.description);
  const net = statement.rows.reduce((sum, r) => sum + r.amount, 0);
  assert.ok(Math.abs(net - 1160.48) < 0.001, 'net ' + net);
});

test('headerless statement: sign is inferred from the running balance', () => {
  const line = (y, cells) => cells.map(([x, str, right]) => ({ str, x: right ? x - str.length * 5 : x, y, w: str.length * 5, h: 10 }));
  const items = [].concat(
    line(700, [[40, 'Account Statement 01/03/2026 to 31/03/2026']]),
    line(680, [[40, 'Opening Balance'], [550, '1,000.00', 1]]),
    line(664, [[40, '05/03/2026'], [110, 'POS PURCHASE GROCER'], [450, '40.00', 1], [550, '960.00', 1]]),
    line(648, [[40, '18/03/2026'], [110, 'SALARY ACME LTD'], [450, '2,500.00', 1], [550, '3,460.00', 1]]),
    line(632, [[40, '21/03/2026'], [110, 'ONLINE TRANSFER'], [450, '(60.00)', 1], [550, '3,400.00', 1]]),
    line(616, [[40, 'Closing Balance'], [550, '3,400.00', 1]])
  );
  const result = Parser.parseDocument({ rows: Engine.reconstructRows(items) }, { preset: 'bank' });
  assert.deepStrictEqual(result.rows.map((r) => r.amount), [-40, 2500, -60]);
  assert.strictEqual(result.meta.reconciled, 'ok', result.meta.reconcileNote);
});

test('dated table: rows without a date inherit the date above', () => {
  const line = (y, cells) => cells.map(([x, str, right]) => ({ str, x: right ? x - str.length * 5 : x, y, w: str.length * 5, h: 10 }));
  const items = [].concat(
    line(700, [[40, 'Date'], [110, 'Description'], [380, 'Withdrawals', 1], [465, 'Deposits', 1], [550, 'Balance', 1]]),
    line(684, [[40, 'Opening Balance'], [550, '500.00', 1]]),
    line(668, [[40, '4 Mar 2026'], [110, 'Coffee shop'], [380, '5.00', 1], [550, '495.00', 1]]),
    line(652, [[110, 'Payroll deposit'], [465, '1,000.00', 1], [550, '1,495.00', 1]]),
    line(636, [[40, 'Closing Balance'], [550, '1,495.00', 1]])
  );
  const result = Parser.parseDocument({ rows: Engine.reconstructRows(items) }, { preset: 'bank' });
  assert.strictEqual(result.rows.length, 2, JSON.stringify(result.rows));
  assert.strictEqual(result.rows[1].date, '2026-03-04');
  assert.strictEqual(result.rows[1].amount, 1000);
  assert.strictEqual(result.meta.reconciled, 'ok');
});

test('US receipt without a table header: items + MDY dates + totals', () => {
  const line = (y, cells) => cells.map(([x, str, right]) => ({ str, x: right ? x - str.length * 5 : x, y, w: str.length * 5, h: 10 }));
  const items = [].concat(
    line(760, [[40, 'Corner Hardware Co.']]),
    line(744, [[40, 'Receipt #: R-88213'], [300, 'Date: 03/04/2026']]),
    line(700, [[40, 'Cordless drill 18V'], [550, '$89.99', 1]]),
    line(684, [[40, 'Wood screws 200pk'], [400, '2'], [550, '$13.98', 1]]),
    line(668, [[40, 'Subtotal'], [550, '$103.97', 1]]),
    line(652, [[40, 'Sales Tax'], [550, '$8.58', 1]]),
    line(636, [[40, 'Total'], [550, '$112.55', 1]]),
    line(620, [[40, 'Paid with Visa ending in 4242']])
  );
  const result = Parser.parseDocument({ rows: Engine.reconstructRows(items) }, { preset: 'auto' });
  assert.strictEqual(result.docType, 'receipt');
  assert.strictEqual(result.meta.number, 'R-88213');
  assert.strictEqual(result.meta.issueDate, '2026-03-04');
  assert.strictEqual(result.meta.total, 112.55);
  assert.strictEqual(result.rows.length, 2, JSON.stringify(result.rows));
  assert.strictEqual(result.rows[1].qty, 2);
  assert.strictEqual(result.rows[1].unit_price, 6.99);
  assert.strictEqual(result.meta.reconciled, 'ok');
});

test('custom regex template with named groups', () => {
  const result = Parser.parseDocument(samples[1], {
    preset: 'bank',
    template: '^(?<date>\\d{2} \\w{3})\\s+(?<description>.+?)\\s+(?<amount>[\\d,]+\\.\\d{2})\\s+(?<balance>[\\d,]+\\.\\d{2})$'
  });
  assert.strictEqual(result.rows.length, 12);
  assert.deepStrictEqual(result.columns.map((c) => c.key), ['date', 'description', 'amount', 'balance']);
  assert.strictEqual(result.rows[0].date, '2026-10-02');
  assert.strictEqual(result.rows[0].balance, 4163.6);
  assert.throws(() => Parser.applyTemplate(samples[1].rows, '(unclosed', {}), /Invalid regular expression/);
  assert.throws(() => Parser.applyTemplate(samples[1].rows, '^\\d+', {}), /named group/);
});

test('empty document yields a scanned-PDF warning, not a crash', () => {
  const result = Parser.parseDocument({ name: 'scan.pdf', rows: [] }, {});
  assert.strictEqual(result.rows.length, 0);
  assert.ok(/scanned/i.test(result.warnings[0]));
});

const docs = [
  { name: samples[0].name, result: invoice },
  { name: samples[1].name, result: statement }
];

test('exporter: CSV shape, escaping and formula-injection guard', () => {
  const csv = Exporter.toCSV([docs[1]]).split('\r\n');
  assert.strictEqual(csv[0], 'Date,Description,Debit,Credit,Amount,Balance');
  assert.strictEqual(csv.length, 13);
  assert.strictEqual(csv[1], '2026-10-02,Direct Debit — Octopus Energy,86.4,,-86.4,4163.6');
  const batch = Exporter.toCSV(docs).split('\r\n');
  assert.ok(batch[0].startsWith('Source File,'));
  assert.strictEqual(batch.length, 1 + 7 + 12);
  const evil = { name: 'x.pdf', result: { docType: 'invoice', meta: {}, columns: [{ key: 'description', label: 'Description' }], rows: [{ description: '=HYPERLINK("http://x","a, b")' }] } };
  assert.strictEqual(Exporter.toCSV([evil]).split('\r\n')[1], '"\'=HYPERLINK(""http://x"",""a, b"")"');
});

test('exporter: JSON, Xero, QuickBooks CSV and IIF', () => {
  const json = JSON.parse(Exporter.toJSON(docs));
  assert.strictEqual(json.documentCount, 2);
  assert.strictEqual(json.documents[0].summary.total, 709.58);
  assert.strictEqual(json.documents[1].rows.length, 12);

  const xero = Exporter.toXeroCSV([docs[1]]).split('\r\n');
  assert.strictEqual(xero[0], '*Date,*Amount,Payee,Description,Reference,Check Number');
  assert.strictEqual(xero[1], '02/10/2026,-86.40,,Direct Debit — Octopus Energy,,');

  const qbo = Exporter.toQuickBooksCSV(docs).split('\r\n');
  assert.strictEqual(qbo[0], 'Date,Description,Amount');
  assert.strictEqual(qbo[1], '11/03/2026,Northwind Cloud Services Ltd - Compute instances — m5.large (us-east-1) - INV-2026-0418,-142.85');
  assert.strictEqual(qbo.length, 1 + 7 + 12);

  const iif = Exporter.toQuickBooksIIF([docs[1]]).trim().split('\r\n');
  assert.strictEqual(iif.length, 3 + 12 * 3);
  const trns = iif[3].split('\t'), spl = iif[4].split('\t');
  assert.strictEqual(trns[0], 'TRNS');
  assert.strictEqual(Number(trns[5]) + Number(spl[5]), 0, 'IIF entries must balance');
});

test('exporter: Excel workbook structure (with a minimal SheetJS stand-in)', () => {
  const sheets = {};
  const fake = {
    utils: {
      book_new: () => ({ SheetNames: [], Sheets: {} }),
      aoa_to_sheet: (aoa) => ({ '!ref': 'A1', aoa }),
      book_append_sheet: (wb, ws, name) => { wb.SheetNames.push(name); wb.Sheets[name] = ws; sheets[name] = ws; }
    }
  };
  const same = [docs[0], { name: docs[0].name, result: invoice }];
  const wb = Exporter.toWorkbook(same.concat(docs[1]), fake);
  assert.strictEqual(wb.SheetNames.length, 4);
  assert.strictEqual(wb.SheetNames[0], 'Summary');
  assert.strictEqual(new Set(wb.SheetNames).size, 4, 'sheet names must be unique');
  wb.SheetNames.forEach((name) => assert.ok(name.length <= 31, name));
  assert.strictEqual(sheets.Summary.aoa.length, 4);
});

test('sha256 matches Node crypto', () => {
  ['', 'abc', 'VaultParse', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000), 'héllo € 🔒'].forEach((input) => {
    assert.strictEqual(App.sha256Hex(input), crypto.createHash('sha256').update(input, 'utf8').digest('hex'));
  });
});

test('license keys: generate, verify, reject tampering', () => {
  const salt = config.pro.licenseSalt;
  for (let i = 0; i < 200; i++) {
    const key = App.License.generate(salt, (n) => crypto.randomBytes(n));
    assert.ok(App.License.PATTERN.test(key), key);
    assert.ok(App.License.verify(key, salt), key);
    assert.ok(App.License.verify(key.toLowerCase().replace(/-/g, ' '), salt), 'normalisation');
    assert.ok(!App.License.verify(key, salt + 'x'), 'wrong salt must fail');
    const last = key.slice(-1);
    assert.ok(!App.License.verify(key.slice(0, -1) + (last === 'A' ? 'B' : 'A'), salt), 'tampered key must fail');
  }
  assert.ok(!App.License.verify('', salt));
  assert.ok(!App.License.verify('VP-AAAAA-AAAAA-AAAAA', salt));
});

console.log('\n' + passed + ' passed, ' + failures.length + ' failed');
if (failures.length) process.exit(1);

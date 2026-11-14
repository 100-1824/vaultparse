#!/usr/bin/env node
/**
 * VaultParse static site compiler.
 *
 *   node scripts/build.js
 *
 * Renders the home page, the all-tools directory and one landing page per
 * entry in config/seo_matrix.json into dist/, copies JS/CSS, compiles
 * Tailwind, and writes sitemap.xml, robots.txt, 404.html, favicon.svg,
 * .nojekyll and the IndexNow key file.
 *
 * Environment overrides (all optional):
 *   SITE_URL           canonical origin + base path (e.g. https://example.com)
 *   GITHUB_REPOSITORY  owner/repo, used to derive the GitHub Pages URL in CI
 *   CHECKOUT_URL       LemonSqueezy / Gumroad checkout link for the Pro key
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ejs = require('ejs');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const started = Date.now();

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'app.config.json'), 'utf8'));
const matrix = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'seo_matrix.json'), 'utf8'));

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

function resolveSiteUrl() {
  const explicit = (process.env.SITE_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const repo = (process.env.GITHUB_REPOSITORY || '').trim();
  if (repo.includes('/')) {
    const [owner, name] = repo.split('/');
    const host = owner.toLowerCase() + '.github.io';
    return name.toLowerCase() === host ? 'https://' + host : 'https://' + host + '/' + name;
  }
  return String(config.siteUrl || '').replace(/\/+$/, '');
}

const siteUrl = resolveSiteUrl();
const checkoutUrl = (process.env.CHECKOUT_URL || config.pro.checkoutUrl || '').trim();
const brand = config.brand;
const year = new Date().getFullYear();
const today = new Date().toISOString().slice(0, 10);

const FORMATS = {
  csv: { label: 'CSV', long: 'CSV', exportKey: 'csv', pro: false },
  excel: { label: 'Excel', long: 'Excel (.xlsx)', exportKey: 'xlsx', pro: false },
  json: { label: 'JSON', long: 'JSON', exportKey: 'json', pro: false },
  qbo: { label: 'QuickBooks CSV', long: 'QuickBooks Online CSV', exportKey: 'qbo', pro: true },
  xero: { label: 'Xero CSV', long: 'Xero bank import CSV', exportKey: 'xero', pro: true }
};
const PRESETS = {
  auto: 'Auto-detect',
  bank: 'Bank statement rules',
  invoice: 'Invoice rules',
  receipt: 'Receipt rules'
};

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

function fail(message) {
  console.error('\n  BUILD FAILED: ' + message + '\n');
  process.exit(1);
}

function validate() {
  if (!/^https?:\/\/[^\s/]+/.test(siteUrl)) fail('siteUrl must be an absolute URL (got "' + siteUrl + '").');
  if (!/^[a-f0-9]{8,128}$/i.test(config.indexNow.key)) fail('indexNow.key must be 8-128 hexadecimal characters.');
  if (!Array.isArray(matrix.pages) || matrix.pages.length < 60) fail('seo_matrix.json must define at least 60 pages (found ' + (matrix.pages || []).length + ').');
  const clusterIds = new Set(matrix.clusters.map((c) => c.id));
  const slugs = new Set();
  matrix.pages.forEach((entry, i) => {
    const where = 'seo_matrix.pages[' + i + '] (' + (entry.slug || '?') + ')';
    ['slug', 'cluster', 'name', 'doc', 'format', 'preset', 'hint'].forEach((key) => {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) fail(where + ' is missing "' + key + '".');
    });
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)) fail(where + ' has an invalid slug.');
    if (slugs.has(entry.slug)) fail(where + ' duplicates a slug.');
    slugs.add(entry.slug);
    if (!clusterIds.has(entry.cluster)) fail(where + ' references unknown cluster "' + entry.cluster + '".');
    if (!FORMATS[entry.format]) fail(where + ' has unknown format "' + entry.format + '".');
    if (!PRESETS[entry.preset]) fail(where + ' has unknown preset "' + entry.preset + '".');
  });
}

/* ------------------------------------------------------------------ *
 * Content generation
 * ------------------------------------------------------------------ */

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

function article(word) {
  if (/^(?:hsbc|hbl|rbc|n26|aws)\b/i.test(word)) return 'an';
  if (/^(?:u\.s\.|uber|utility|us\b|united)/i.test(word)) return 'a';
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:.\s]+$/, '') + '\u2026';
}

function rowsNoun(preset) {
  if (preset === 'bank') return 'transactions';
  if (preset === 'auto') return 'table rows';
  return 'line items';
}

function extractedList(preset) {
  if (preset === 'bank') {
    return [
      'Every transaction row: date, description, debit, credit, signed amount and running balance',
      'Bank name, account number and IBAN where printed',
      'Statement period, opening balance and closing balance',
      'Negative figures in any notation: -450.00, (450.00), 450.00- and DR / CR suffixes',
      'A reconciliation check: opening balance plus transactions must equal the closing balance'
    ];
  }
  if (preset === 'auto') {
    return [
      'Document type detection: bank statement, invoice or receipt',
      'Table rows rebuilt from text coordinates, so columns stay aligned',
      'Dates normalised to ISO format and amounts to plain numbers',
      'Summary fields: document number, issuer, dates, currency and totals',
      'A check that the extracted rows add up to the printed totals'
    ];
  }
  return [
    'Every line item: description, quantity, unit price and amount',
    (preset === 'receipt' ? 'Receipt' : 'Invoice') + ' number, vendor name, issue date' + (preset === 'receipt' ? '' : ' and due date'),
    'Currency (USD, EUR, GBP, PKR, CAD, AUD), subtotal, tax / VAT and total',
    'Credits and discounts shown in brackets or with a minus sign stay negative',
    'A check that line items add up to the printed subtotal or total'
  ];
}

const PRIVACY_ANSWERS = [
  (subject) => 'Yes. ' + capitalize(subject) + ' are opened by JavaScript running in your own browser tab. The file is read from disk into memory, parsed there and discarded when you close the tab. Nothing is uploaded, and the page blocks itself from sending requests to any server other than the public CDN that hosts its code libraries. You can confirm this in your browser\u2019s Network tab while converting.',
  (subject) => 'They stay on your device. This page has no backend: there is no upload endpoint, no account system and no database. ' + capitalize(subject) + ' are parsed in your browser\u2019s memory, and the live \u201cServer Calls\u201d counter above the workspace shows how many data-carrying requests the page has made, which stays at zero.',
  (subject) => 'No upload takes place. The converter is a static page; once it has loaded, ' + subject + ' are processed locally by the PDF engine in your browser. A Content-Security-Policy on the page restricts network access to the code-library CDN, so the document contents have nowhere to go.'
];

function formatFaq(entry, fmt, subjectOne) {
  const proNote = ' The ' + fmt.long + ' preset is part of the ' + config.pro.priceLabel + ' lifetime Pro key; standard CSV, Excel and JSON exports are free.';
  switch (entry.format) {
    case 'excel':
      return {
        q: 'What does the Excel file contain?',
        a: 'A real .xlsx workbook, built in your browser. The first sheet is a Summary with the document number, issuer, dates, currency and totals; the second holds the ' + rowsNoun(entry.preset) + ' with an auto-filter on the header row. Amounts are stored as numbers, so SUM, sorting and pivot tables work immediately. When you convert several files at once, each file gets its own sheet.'
      };
    case 'json':
      return {
        q: 'What does the JSON output look like?',
        a: 'One object per document with a summary block (number, issuer, dates, currency, totals) and a rows array. Keys are stable and lower-case, such as description, qty, unit_price and amount, and numeric values are real numbers rather than strings. The inspector tab shows the JSON live as you edit the grid, with one-click copy.'
      };
    case 'qbo':
      return {
        q: 'How do I import the result into QuickBooks Online?',
        a: 'Export with the QuickBooks Online CSV preset, then in QuickBooks open Transactions > Bank transactions, choose Upload from file and select the CSV. The file uses the three-column Date, Description, Amount layout with money out as negative amounts.' + proNote
      };
    case 'xero':
      return {
        q: 'How do I import the result into Xero?',
        a: 'Export with the Xero preset, then in Xero open the bank account, choose Import a Statement and upload the CSV. The columns follow Xero\u2019s template: *Date, *Amount, Payee, Description, Reference and Check Number, with money out as negative amounts.' + proNote
      };
    default:
      return {
        q: 'Will the CSV open correctly in Excel and Google Sheets?',
        a: 'Yes. The CSV is UTF-8 with a byte-order mark so Excel reads accented characters and currency symbols correctly, fields containing commas or quotes are escaped to the RFC 4180 standard, dates are written as YYYY-MM-DD and amounts as plain numbers without thousands separators. Text that starts with =, + or @ is prefixed so a spreadsheet will not run it as a formula.'
      };
  }
}

function buildToolPage(entry) {
  const fmt = FORMATS[entry.format];
  const brandName = (entry.brand || '').trim();
  const subjectOne = (brandName ? brandName + ' ' : '') + entry.doc;
  const subjectMany = subjectOne + ' PDFs';
  const noun = rowsNoun(entry.preset);
  const variant = hash(entry.slug) % 3;
  const selfDescribing = /(extract|extractor|parser|converter|without upload)/i.test(entry.name);

  const longTitle = entry.name + (selfDescribing ? '' : ' Converter') + ' \u2014 Free, Private, No Upload | ' + brand.name;
  const midTitle = entry.name + ' \u2014 Free & Private | ' + brand.name;
  const title = longTitle.length <= 65 ? longTitle : (midTitle.length <= 65 ? midTitle : entry.name + ' | ' + brand.name);
  const h1 = entry.name + (selfDescribing ? '' : ' Converter');
  const descLead = brandName
    ? 'Convert ' + article(subjectOne) + ' ' + subjectOne + ' PDF to ' + fmt.long + ' in your browser.'
    : h1 + ': turn ' + entry.doc + ' PDFs into ' + fmt.long + ' in your browser.';
  const descBody = descLead + ' Extracts ' + noun + ', dates and totals with no upload and no sign-up.';
  const descTail = ' The file never leaves your device.';
  const description = clip([descBody + descTail, descBody, descLead + ' Private: no upload and no sign-up.']
    .find((text) => text.length <= 158) || descLead, 158);

  const intros = [
    'Drop ' + article(subjectOne) + ' ' + subjectOne + ' PDF below and get clean ' + noun + ' as ' + fmt.long + ' in seconds. Parsing happens in your browser tab, so the document is never uploaded.',
    'Turn ' + subjectMany + ' into tidy ' + fmt.long + ' without sending them anywhere. The ' + noun + ', dates and totals are extracted locally and shown in an editable grid before you export.',
    'A private way to get ' + noun + ' out of ' + article(subjectOne) + ' ' + subjectOne + ' PDF and into ' + fmt.long + '. No account, no upload, no waiting on a server: the work is done on your own device.'
  ];

  const source = brandName
    ? 'Download the ' + entry.doc + ' as a PDF from your ' + brandName + ' account. Use the original digital file rather than a scan or photo.'
    : 'Have the ' + entry.doc + ' ready as a digital PDF: the original download or an email saved as PDF, not a scan or photo.';
  const steps = [
    { title: 'Get the PDF', text: source },
    { title: 'Drop it on this page', text: 'The "' + PRESETS[entry.preset].replace(/ rules$/, '') + '" preset is already selected. The ' + noun + ' appear in the grid within moments, alongside a summary of the document.' },
    { title: 'Review, then export ' + fmt.label, text: 'Fix any cell, delete stray rows or rename columns, then click the highlighted ' + fmt.long + ' export. CSV, Excel and JSON are always available too.' }
  ];

  const howTo = 'Get the PDF from ' + (brandName ? 'your ' + brandName + ' account' : 'its source') + ', drop it onto the converter above and wait for the ' + noun +
    ' to appear in the grid. Check the reconciliation note under the summary, correct anything that looks off, and click the ' + fmt.long + ' export button. ' + entry.hint;

  const faqs = [
    { q: 'Is it safe to convert ' + article(subjectOne) + ' ' + subjectOne + ' here?', a: PRIVACY_ANSWERS[variant](subjectMany) },
    { q: brandName ? 'How do I convert ' + article(subjectOne) + ' ' + subjectOne + ' PDF to ' + fmt.label + '?' : 'How do I use the ' + h1.replace(/^pdf\b/i, 'PDF') + '?', a: howTo },
    formatFaq(entry, fmt, subjectOne)
  ];

  const detail = [
    'PDF files store text as positioned fragments, not as tables, which is why copying from ' + article(subjectOne) + ' ' + subjectOne +
      ' usually produces scrambled columns. ' + brand.name + ' reads the x and y position of every fragment, groups fragments that share a baseline into rows and orders each row left to right. The rebuilt rows are then matched against rules for dates, descriptions and amounts.',
    entry.preset === 'bank'
      ? 'For statements, each row that carries a date and an amount becomes a transaction. Separate debit and credit columns are merged into one signed amount, and the running balance is used to confirm the sign of every row.'
      : 'For ' + (entry.preset === 'auto' ? 'invoices and receipts' : entry.doc + 's') + ', rows under the item table header are mapped to description, quantity, unit price and amount, while subtotal, tax and total lines are captured as summary fields.'
  ];

  return {
    slug: entry.slug,
    path: 'tools/' + entry.slug + '.html',
    name: entry.name,
    title,
    ogTitle: h1,
    description,
    h1,
    eyebrow: matrix.clusters.find((c) => c.id === entry.cluster).title,
    clusterId: entry.cluster,
    breadcrumb: true,
    intro: intros[variant],
    preset: entry.preset,
    exportDefault: fmt.exportKey,
    steps,
    detailTitle: 'How ' + (brandName ? brandName + ' ' : '') + entry.doc + ' conversion works',
    detail,
    hint: entry.hint,
    extracted: extractedList(entry.preset),
    faqs,
    relatedTitle: 'Related converters',
    disclaimer: brandName
      ? brand.name + ' is an independent tool and is not affiliated with, endorsed by or sponsored by ' + brandName + '. ' + brandName + ' is a trademark of its respective owner.'
      : '',
    formatLabel: 'PDF to ' + fmt.label,
    presetLabel: PRESETS[entry.preset]
  };
}

function buildHomePage(pageCount) {
  return {
    slug: 'index',
    path: 'index.html',
    name: brand.name,
    title: 'PDF Invoice & Bank Statement to CSV, Excel, JSON | ' + brand.name,
    ogTitle: brand.name + ' \u2014 private PDF to CSV, Excel and JSON converter',
    description: 'Free PDF to CSV, Excel and JSON converter for invoices, receipts and bank statements. Runs 100% in your browser: no upload, no sign-up, no server.',
    h1: 'PDF invoices, receipts and bank statements to clean CSV, Excel and JSON',
    eyebrow: 'Private financial PDF converter',
    clusterId: '',
    breadcrumb: false,
    intro: 'Drop a PDF and get an editable table of line items or transactions, plus the document number, dates, currency and totals. Everything is parsed inside your browser tab, so confidential statements and invoices are never uploaded.',
    preset: 'auto',
    exportDefault: 'csv',
    steps: [
      { title: 'Drop your PDFs', text: 'Invoices, receipts and bank statements are detected automatically. Drop one file or a small batch; nothing leaves your device.' },
      { title: 'Review the grid', text: 'Rows are rebuilt from the text coordinates in the PDF. Edit any cell, delete noise, rename columns and check the reconciliation note.' },
      { title: 'Export', text: 'Download CSV, an Excel workbook or JSON with one click. Xero and QuickBooks presets are available with a Pro key.' }
    ],
    detailTitle: 'Why a browser-only converter',
    detail: [
      'Bank statements and supplier invoices are among the most sensitive documents a business handles, yet most online converters ask you to upload them. ' + brand.name + ' has no server to upload to: the page is static, and the PDF engine, the parsing rules and the exporters all run on your device.',
      'Extraction is deterministic. The engine reads the position of every text fragment, rebuilds table rows by their y coordinate, and applies rules for dates, amounts, negative notation and totals. The same document always produces the same result, and a reconciliation check tells you when rows do not add up to the printed totals.'
    ],
    hint: 'Scanned or photographed documents have no text layer and cannot be read without OCR. Use the original PDF from your bank or supplier wherever possible.',
    extracted: extractedList('auto'),
    faqs: [
      { q: 'Are my PDF files uploaded to a server?', a: PRIVACY_ANSWERS[0]('your PDFs') },
      { q: 'Which documents does it work with?', a: 'Digital, text-based PDFs: bank and card statements, supplier and SaaS invoices, and order receipts from any issuer. It handles amounts written as 1,234.56 or 1.234,56, negatives in brackets or with DR/CR suffixes, and dates in numeric or written forms. Scanned images are not supported because they contain no text to read. There are ' + pageCount + ' pre-configured converters for specific banks, vendors and workflows.' },
      { q: 'What is free and what does Pro add?', a: 'Converting single files and batches of up to ' + config.pro.freeBatchLimit + ' files is free with no limit on how often, including CSV, Excel and JSON export and the editable grid. A ' + config.pro.priceLabel + ' one-time Pro key removes the batch limit, adds Xero and QuickBooks export presets, and lets you save custom regex templates. The key is verified offline in your browser.' }
    ],
    relatedTitle: 'Popular converters',
    disclaimer: '',
    formatLabel: '',
    presetLabel: ''
  };
}

/* ------------------------------------------------------------------ *
 * Structured data
 * ------------------------------------------------------------------ */

function softwareLd(page, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: page.slug === 'index' ? brand.name : page.h1,
    url,
    description: page.description,
    applicationCategory: 'FinanceApplication',
    applicationSubCategory: 'Document conversion',
    operatingSystem: 'Any (runs in a web browser)',
    browserRequirements: 'Requires JavaScript and a current version of Chrome, Edge, Firefox or Safari.',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    featureList: [
      'PDF to CSV, Excel (.xlsx) and JSON',
      'Runs entirely in the browser with no file upload',
      'Editable data grid and live JSON / CSV inspector',
      'Bank statement, invoice and receipt parsing presets'
    ],
    publisher: { '@type': 'Organization', name: brand.name, url: siteUrl + '/' }
  };
}

function faqLd(page) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: page.faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.q,
      acceptedAnswer: { '@type': 'Answer', text: faq.a }
    }))
  };
}

function breadcrumbLd(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({ '@type': 'ListItem', position: i + 1, name: item.name, item: item.url }))
  };
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const THEME_SCRIPT = "(function(){var d=document.documentElement,k='vp_theme';function g(){try{return localStorage.getItem(k)}catch(e){return null}}" +
  "function a(t){d.classList.toggle('dark',t!=='light');var m=document.querySelector('meta[name=theme-color]');" +
  "if(m)m.setAttribute('content',t==='light'?'" + brand.themeColorLight + "':'" + brand.themeColorDark + "')}" +
  "a(g()==='light'?'light':'dark');document.addEventListener('DOMContentLoaded',function(){var b=document.getElementById('theme-toggle');" +
  "if(!b)return;b.addEventListener('click',function(){var t=d.classList.contains('dark')?'light':'dark';a(t);try{localStorage.setItem(k,t)}catch(e){}})})})();";

const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdnjs.cloudflare.com 'sha256-" + crypto.createHash('sha256').update(THEME_SCRIPT, 'utf8').digest('base64') + "'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  'connect-src https://cdnjs.cloudflare.com',
  "worker-src 'self' blob: https://cdnjs.cloudflare.com",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ');

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const templates = {};
['layout', 'converter', 'directory'].forEach((name) => {
  const file = path.join(SRC, 'templates', name + '.ejs');
  templates[name] = ejs.compile(fs.readFileSync(file, 'utf8'), { filename: file, rmWhitespace: false });
});

function write(relative, content) {
  const target = path.join(DIST, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function pageUrl(relativePath) {
  return relativePath === 'index.html' ? siteUrl + '/' : siteUrl + '/' + relativePath;
}

function build() {
  validate();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const assetFiles = ['js/pdf_engine.js', 'js/parser_rules.js', 'js/exporter.js', 'js/app.js', 'css/custom.css'];
  const buildId = crypto.createHash('sha256')
    .update(assetFiles.map((f) => fs.readFileSync(path.join(SRC, f))).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)))
    .digest('hex').slice(0, 10);

  const toolPages = matrix.pages.map(buildToolPage);
  const pageCount = toolPages.length;
  const home = buildHomePage(pageCount);
  const bySlug = new Map(toolPages.map((p) => [p.slug, p]));
  const card = (p) => ({ slug: p.slug, name: p.name, formatLabel: p.formatLabel, presetLabel: p.presetLabel });

  const shared = {
    brand,
    siteUrl,
    year,
    buildId,
    csp: CSP,
    themeScript: THEME_SCRIPT,
    safeJson,
    cdn: config.cdn,
    clusters: matrix.clusters,
    pageCount,
    pro: config.pro,
    freeBatchLimit: config.pro.freeBatchLimit
  };

  function clientConfig(page, root) {
    return {
      siteName: brand.name,
      root,
      preset: page.preset,
      exportDefault: page.exportDefault,
      checkoutUrl,
      salt: config.pro.licenseSalt,
      freeBatchLimit: config.pro.freeBatchLimit,
      rowTolerance: config.engine.rowTolerance,
      cdn: {
        pdfjsWorker: config.cdn.pdfjsWorker.src,
        pdfjsCMaps: config.cdn.pdfjsCMaps,
        xlsx: config.cdn.xlsx
      }
    };
  }

  function renderConverter(page, root, related, jsonLd) {
    const locals = Object.assign({}, shared, { page: Object.assign({}, page, { canonical: pageUrl(page.path) }), root, related });
    const body = templates.converter(locals);
    return templates.layout(Object.assign({}, locals, { body, hasApp: true, jsonLd, clientConfig: clientConfig(page, root) }));
  }

  // Home
  const featured = ['pdf-bank-statement-to-csv', 'pdf-invoice-to-excel', 'chase-bank-pdf-to-csv', 'stripe-invoice-pdf-to-excel', 'aws-invoice-pdf-to-csv', 'pdf-statement-to-xero-csv']
    .map((slug) => bySlug.get(slug)).filter(Boolean).map(card);
  write('index.html', renderConverter(home, './', featured, [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: brand.name, url: siteUrl + '/', description: brand.shortDescription },
    softwareLd(home, pageUrl('index.html')),
    faqLd(home)
  ]));

  // Tool pages
  toolPages.forEach((page, index) => {
    const sameCluster = toolPages.filter((p) => p.clusterId === page.clusterId && p.slug !== page.slug);
    const start = sameCluster.length ? hash(page.slug) % sameCluster.length : 0;
    const related = [];
    for (let i = 0; i < sameCluster.length && related.length < 5; i++) related.push(sameCluster[(start + i) % sameCluster.length]);
    const other = toolPages[(index + Math.floor(pageCount / 2)) % pageCount];
    if (other.slug !== page.slug && !related.includes(other)) related.push(other);
    const url = pageUrl(page.path);
    write(page.path, renderConverter(page, '../', related.map(card), [
      softwareLd(page, url),
      faqLd(page),
      breadcrumbLd([
        { name: brand.name, url: siteUrl + '/' },
        { name: page.eyebrow, url: siteUrl + '/directory.html#' + page.clusterId },
        { name: page.name, url }
      ])
    ]));
  });

  // Directory
  const groups = matrix.clusters.map((cluster) => ({
    id: cluster.id,
    title: cluster.title,
    blurb: cluster.blurb,
    tools: toolPages.filter((p) => p.clusterId === cluster.id).map(card)
  }));
  const directoryPage = {
    title: 'All ' + pageCount + ' PDF Converters for Statements & Invoices | ' + brand.name,
    description: 'Browse ' + pageCount + ' free in-browser PDF converters for bank statements, SaaS and cloud invoices, receipts and accounting imports. No upload required.',
    canonical: pageUrl('directory.html'),
    h1: 'All ' + pageCount + ' PDF converters',
    intro: 'Each converter opens the same private, in-browser engine with the right parsing preset and export format already selected for that bank, vendor or workflow.',
    disclaimer: brand.name + ' is an independent tool. Company and product names are trademarks of their respective owners and are used only to describe the documents each converter reads.'
  };
  const directoryLocals = Object.assign({}, shared, { page: directoryPage, root: './', groups });
  write('directory.html', templates.layout(Object.assign({}, directoryLocals, {
    body: templates.directory(directoryLocals),
    hasApp: false,
    clientConfig: null,
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: directoryPage.h1,
        url: directoryPage.canonical,
        description: directoryPage.description,
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: pageCount,
          itemListElement: toolPages.map((p, i) => ({ '@type': 'ListItem', position: i + 1, name: p.name, url: pageUrl(p.path) }))
        }
      },
      breadcrumbLd([{ name: brand.name, url: siteUrl + '/' }, { name: 'All converters', url: directoryPage.canonical }])
    ]
  })));

  // 404
  const notFound = {
    title: 'Page not found | ' + brand.name,
    description: 'That page does not exist. Open the converter or browse all tools.',
    canonical: pageUrl('404.html'),
    noindex: true,
    disclaimer: ''
  };
  const base = new URL(siteUrl + '/').pathname;
  const notFoundBody = '    <section class="mx-auto max-w-3xl px-4 py-24 text-center">\n' +
    '      <p class="vp-eyebrow">404</p>\n      <h1 class="vp-h1 mx-auto">That page is not here</h1>\n' +
    '      <p class="vp-lede mx-auto">The link may be outdated. The converter and the full list of tools are one click away.</p>\n' +
    '      <p class="mt-8 flex flex-wrap justify-center gap-3"><a class="vp-btn vp-btn-accent" href="' + base + 'index.html">Open the converter</a>' +
    '<a class="vp-btn vp-btn-outline" href="' + base + 'directory.html">Browse all converters</a></p>\n    </section>\n';
  write('404.html', templates.layout(Object.assign({}, shared, { page: notFound, root: base, body: notFoundBody, hasApp: false, clientConfig: null, jsonLd: [] })));

  // Static assets
  assetFiles.forEach((file) => write(file, fs.readFileSync(path.join(SRC, file))));
  write('favicon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#090D16"/>' +
    '<path d="M9 11l7 11 7-11" fill="none" stroke="#3DDC97" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>\n');
  write('.nojekyll', '');

  // Tailwind (scans the rendered HTML + client JS)
  const tailwindCli = require.resolve('tailwindcss/lib/cli.js');
  execFileSync(process.execPath, [tailwindCli, '-c', path.join(ROOT, 'tailwind.config.js'), '-o', path.join(DIST, 'css', 'tailwind.css'), '--minify'], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: Object.assign({}, process.env, { BROWSERSLIST_IGNORE_OLD_DATA: '1' })
  });

  // Sitemap, robots, IndexNow key
  const urls = [
    { loc: pageUrl('index.html'), priority: '1.0', changefreq: 'weekly' },
    { loc: pageUrl('directory.html'), priority: '0.9', changefreq: 'weekly' }
  ].concat(toolPages.map((p) => ({ loc: pageUrl(p.path), priority: '0.8', changefreq: 'monthly' })));
  const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  write('sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((u) => '  <url><loc>' + xmlEscape(u.loc) + '</loc><lastmod>' + today + '</lastmod><changefreq>' + u.changefreq + '</changefreq><priority>' + u.priority + '</priority></url>').join('\n') +
    '\n</urlset>\n');
  write('robots.txt', 'User-agent: *\nAllow: /\n\nSitemap: ' + siteUrl + '/sitemap.xml\n');
  write(config.indexNow.key + '.txt', config.indexNow.key);

  // Report
  const toolCount = fs.readdirSync(path.join(DIST, 'tools')).filter((f) => f.endsWith('.html')).length;
  console.log('VaultParse build');
  console.log('  site url      ' + siteUrl);
  console.log('  tool pages    ' + toolCount + '  (dist/tools/*.html)');
  console.log('  core pages    index.html, directory.html, 404.html');
  console.log('  seo files     sitemap.xml (' + urls.length + ' urls), robots.txt, ' + config.indexNow.key + '.txt');
  console.log('  assets        ' + assetFiles.length + ' copied + css/tailwind.css (' + Math.round(fs.statSync(path.join(DIST, 'css', 'tailwind.css')).size / 1024) + ' kB)');
  console.log('  build id      ' + buildId);
  if (!checkoutUrl) console.log('  note          pro.checkoutUrl is empty: the Pro modal shows key activation only (set it in config/app.config.json or CHECKOUT_URL).');
  console.log('  done in       ' + (Date.now() - started) + ' ms');
}

build();

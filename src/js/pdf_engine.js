/*!
 * VaultParse — pdf_engine.js
 * Coordinate-aware text extraction on top of Mozilla pdf.js.
 *
 * Plain text extraction scrambles tables because PDF content streams are not
 * stored in reading order. This module reads every text item's [x, y] origin
 * from page.getTextContent(), clusters items into horizontal rows by their
 * y coordinate (configurable tolerance, default ±3.5), sorts each row
 * left-to-right by x, and merges neighbouring fragments into column cells.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.VaultParse = root.VaultParse || {};
  root.VaultParse.PdfEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  var settings = {
    rowTolerance: 3.5,
    workerSrc: '',
    cMapUrl: '',
    maxPages: 400
  };

  function configure(options) {
    Object.keys(options || {}).forEach(function (key) {
      if (options[key] !== undefined && options[key] !== null) settings[key] = options[key];
    });
    return settings;
  }

  /**
   * Group positioned text items into rows, then into cells.
   * @param {Array<{str:string,x:number,y:number,w:number,h:number}>} items
   * @param {{tolerance?:number,page?:number}} [options]
   * @returns {Array<{page:number,y:number,text:string,cells:Array<{text:string,x:number,x2:number}>}>}
   */
  function reconstructRows(items, options) {
    options = options || {};
    var tolerance = typeof options.tolerance === 'number' ? options.tolerance : settings.rowTolerance;
    var page = options.page || 1;

    var clean = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || typeof it.str !== 'string' || !it.str.trim()) continue;
      if (!isFinite(it.x) || !isFinite(it.y)) continue;
      clean.push({
        str: it.str,
        x: it.x,
        y: it.y,
        w: it.w > 0 ? it.w : it.str.length * (it.h > 0 ? it.h : 10) * 0.5,
        h: it.h > 0 ? it.h : 10
      });
    }

    // PDF user space has its origin at the bottom-left: larger y is higher on the page.
    clean.sort(function (a, b) { return b.y - a.y || a.x - b.x; });

    var bands = [];
    var current = null;
    clean.forEach(function (item) {
      if (current && Math.abs(item.y - current.y) <= tolerance) {
        current.items.push(item);
        current.sum += item.y;
        current.y = current.sum / current.items.length;
      } else {
        current = { y: item.y, sum: item.y, items: [item] };
        bands.push(current);
      }
    });

    return bands.map(function (band) {
      band.items.sort(function (a, b) { return a.x - b.x; });
      var cells = [];
      var cell = null;
      band.items.forEach(function (item) {
        var text = item.str.replace(/\s+/g, ' ');
        var right = item.x + item.w;
        if (!cell) {
          cell = { text: text, x: item.x, x2: right, h: item.h };
          cells.push(cell);
          return;
        }
        var gap = item.x - cell.x2;
        var size = Math.max(cell.h, item.h);
        var columnGap = Math.max(5.5, size * 0.75);
        if (gap > columnGap) {
          cell = { text: text, x: item.x, x2: right, h: item.h };
          cells.push(cell);
          return;
        }
        var needsSpace = gap > size * 0.12 && !/\s$/.test(cell.text) && !/^\s/.test(text);
        cell.text += (needsSpace ? ' ' : '') + text;
        cell.x2 = Math.max(cell.x2, right);
        cell.h = size;
      });
      var out = cells
        .map(function (c) { return { text: c.text.trim(), x: round(c.x), x2: round(c.x2) }; })
        .filter(function (c) { return c.text.length > 0; });
      return {
        page: page,
        y: round(band.y),
        text: out.map(function (c) { return c.text; }).join(' '),
        cells: out
      };
    }).filter(function (row) { return row.cells.length > 0; });
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  function resolveLib(lib) {
    var found = lib || (typeof pdfjsLib !== 'undefined' ? pdfjsLib : null) ||
      (typeof globalThis !== 'undefined' ? globalThis.pdfjsLib : null);
    if (!found || typeof found.getDocument !== 'function') {
      throw new Error('The PDF engine (pdf.js) has not finished loading. Check your connection to the CDN and reload the page.');
    }
    if (settings.workerSrc && found.GlobalWorkerOptions && !found.GlobalWorkerOptions.workerSrc) {
      found.GlobalWorkerOptions.workerSrc = settings.workerSrc;
    }
    return found;
  }

  function toBytes(source) {
    if (source instanceof Uint8Array) return Promise.resolve(source);
    if (source instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(source));
    if (source && typeof source.arrayBuffer === 'function') {
      return source.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    }
    return Promise.reject(new Error('Unsupported PDF source.'));
  }

  function now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /**
   * Read a PDF (File, Blob, ArrayBuffer or Uint8Array) and return reconstructed rows.
   * Nothing is transmitted anywhere: the bytes are handed to pdf.js in this tab.
   */
  function extractDocument(source, options) {
    options = options || {};
    var started = now();
    var lib;
    try {
      lib = resolveLib(options.pdfjsLib);
    } catch (err) {
      return Promise.reject(err);
    }
    var name = options.name || (source && source.name) || 'document.pdf';
    var size = (source && (source.size || source.byteLength)) || 0;

    return toBytes(source).then(function (bytes) {
      var params = {
        data: bytes,
        disableAutoFetch: true,
        disableStream: true,
        disableRange: true,
        isEvalSupported: false,
        stopAtErrors: false
      };
      if (settings.cMapUrl) {
        params.cMapUrl = settings.cMapUrl;
        params.cMapPacked = true;
      }
      if (options.password) params.password = options.password;
      return lib.getDocument(params).promise;
    }).then(function (pdf) {
      var pageCount = pdf.numPages;
      var limit = Math.min(pageCount, settings.maxPages);
      var rows = [];
      var itemCount = 0;
      var chain = Promise.resolve();

      function readPage(number) {
        return pdf.getPage(number).then(function (page) {
          return page.getTextContent().then(function (content) {
            var items = [];
            for (var i = 0; i < content.items.length; i++) {
              var raw = content.items[i];
              if (!raw || typeof raw.str !== 'string' || !raw.transform) continue;
              var t = raw.transform;
              var height = raw.height || Math.hypot(t[2], t[3]) || Math.abs(t[3]) || 10;
              items.push({ str: raw.str, x: t[4], y: t[5], w: raw.width || 0, h: height });
            }
            itemCount += items.length;
            var pageRows = reconstructRows(items, { tolerance: options.tolerance, page: number });
            for (var r = 0; r < pageRows.length; r++) rows.push(pageRows[r]);
            if (typeof page.cleanup === 'function') page.cleanup();
            if (typeof options.onProgress === 'function') options.onProgress(number, limit);
          });
        });
      }

      for (var n = 1; n <= limit; n++) {
        chain = chain.then(readPage.bind(null, n));
      }

      return chain.then(function () {
        var result = {
          name: name,
          size: size,
          pageCount: pageCount,
          pagesRead: limit,
          itemCount: itemCount,
          rows: rows,
          ms: Math.round(now() - started)
        };
        var done = typeof pdf.destroy === 'function' ? pdf.destroy() : null;
        return Promise.resolve(done).then(function () { return result; }, function () { return result; });
      });
    }).catch(function (err) {
      var label = err && err.name ? err.name : '';
      if (label === 'PasswordException') {
        var locked = new Error('"' + name + '" is password-protected. Remove the password (open it and re-save or print to PDF), then drop it again.');
        locked.code = 'PASSWORD';
        throw locked;
      }
      if (label === 'InvalidPDFException') {
        var invalid = new Error('"' + name + '" is not a readable PDF file.');
        invalid.code = 'INVALID';
        throw invalid;
      }
      throw err;
    });
  }

  return {
    configure: configure,
    reconstructRows: reconstructRows,
    extractDocument: extractDocument,
    settings: settings
  };
});

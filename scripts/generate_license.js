#!/usr/bin/env node
/**
 * Generate VaultParse Pro license keys that pass the in-browser checksum.
 *
 *   node scripts/generate_license.js          one key
 *   node scripts/generate_license.js 25       twenty-five keys (one per line)
 *   node scripts/generate_license.js --verify VP-XXXXX-XXXXX-XXXXX-XXXXX
 *
 * Keys are derived from pro.licenseSalt in config/app.config.json. Paste a
 * batch into your LemonSqueezy / Gumroad product as pre-generated license
 * keys so each buyer receives a unique one. Changing the salt invalidates
 * every key issued before the change.
 */
'use strict';

const crypto = require('crypto');
const path = require('path');
const { License } = require(path.join(__dirname, '..', 'src', 'js', 'app.js'));
const config = require(path.join(__dirname, '..', 'config', 'app.config.json'));

const salt = config.pro.licenseSalt;
const args = process.argv.slice(2);

if (args[0] === '--verify') {
  const key = args.slice(1).join(' ');
  const ok = License.verify(key, salt);
  console.log(License.normalize(key) + '  ' + (ok ? 'VALID' : 'INVALID'));
  process.exit(ok ? 0 : 1);
}

const count = Math.max(1, Math.min(10000, parseInt(args[0], 10) || 1));
const seen = new Set();
while (seen.size < count) {
  const key = License.generate(salt, (n) => crypto.randomBytes(n));
  if (!License.verify(key, salt)) throw new Error('Generated key failed self-verification.');
  seen.add(key);
}
console.log(Array.from(seen).join('\n'));

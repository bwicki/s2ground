// node --test: every t('key') used in src exists in de.json; en.json has the same keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const de = JSON.parse(readFileSync(join(root, 'i18n/de.json'), 'utf8'));
const en = JSON.parse(readFileSync(join(root, 'i18n/en.json'), 'utf8'));

function walk(dir, out = []) { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith('.js')) out.push(p); } return out; }

test('en.json covers all de.json keys (and nothing more)', () => {
  const missing = Object.keys(de).filter((k) => !(k in en));
  const extra = Object.keys(en).filter((k) => !(k in de));
  assert.deepEqual(missing, []); assert.deepEqual(extra, []);
});

test('all static t() keys exist in de.json', () => {
  const used = new Set();
  for (const f of walk(join(root, 'src'))) {
    if (f.endsWith('i18n.js')) continue;                 // its doc comment shows t('key')
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) used.add(m[1]);
  }
  const missing = [...used].filter((k) => !(k in de));
  assert.deepEqual(missing, []);
  const prefixes = ['chk.item.', 'detail.layer.', 'detail.tab.', 'role.', 'mode.'];
  for (const p of prefixes) assert.ok(Object.keys(de).some((k) => k.startsWith(p)), p);
});

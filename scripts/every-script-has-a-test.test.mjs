/**
 * Every scripts/*.mjs has a sibling <name>.test.mjs, except the ones listed in
 * untested-scripts.json. That list may only shrink: a new script brings its
 * test, and once a listed script gets one its entry must go.
 */
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(HERE);
const scripts = files.filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
const hasTest = (script) => files.includes(script.replace(/\.mjs$/, '.test.mjs'));
const allowed = JSON.parse(fs.readFileSync(path.join(HERE, 'untested-scripts.json'), 'utf8')).allowed;

test('every script has a sibling test, or is on the shrinking allow-list', () => {
    const missing = scripts.filter((s) => !hasTest(s) && !allowed.includes(s));
    assert.deepStrictEqual(missing, [], `no test next to: ${missing.join(', ')}. Add <name>.test.mjs (do not add the script to untested-scripts.json).`);
});

test('the allow-list holds only scripts that exist and still lack a test', () => {
    const stale = allowed.filter((s) => !scripts.includes(s) || hasTest(s));
    assert.deepStrictEqual(stale, [], `remove from untested-scripts.json (gone or now tested): ${stale.join(', ')}`);
});

test('the allow-list is sorted and has no duplicates', () => {
    assert.deepStrictEqual(allowed, [...new Set(allowed)].sort());
});

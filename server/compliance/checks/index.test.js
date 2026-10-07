'use strict';

/**
 * The check auto-loader runs at BOOT and requires every file in gdpr/, aia/ and
 * iso27001/. Tests in this repo live next to their source, so those directories
 * contain *.test.js files too — and requiring a test file executes it in the
 * live server process.
 *
 * That is how the server came to crash-loop on 2026-09-04: a colocated check
 * test stubbed the require cache, replacing db.js's exports with a four-function
 * mock. Every store required afterwards destructured `makeStoreInit` from that
 * mock, got undefined, and threw at module load. The loader's try/catch reported
 * only "Check must have an id" — the registration failure — while the real
 * damage (a poisoned shared module) went unnoticed.
 *
 * Run: node --test --test-force-exit compliance/checks/index.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const CHECK_DIRS = ['gdpr', 'aia', 'iso27001'];

test('the loader registers checks without loading any colocated test file', () => {
    const registry = require('./index');

    const loadedTests = Object.keys(require.cache)
        .filter(f => f.includes(`${path.sep}compliance${path.sep}checks${path.sep}`))
        .filter(f => /\.(test|spec)\.js$/.test(f))
        .filter(f => path.basename(f) !== path.basename(__filename));
    assert.deepStrictEqual(loadedTests, [], `the loader required test files: ${loadedTests.join(', ')}`);

    assert.ok(registry.getAll().length > 0, 'checks must still register');
});

test('a shared module the checks touch is left intact — nothing stubbed db', () => {
    require('./index');
    const db = require('../../db');
    // The exact symptom of the boot poisoning: the store helper vanished
    // because a test's mock stood in for the real module.
    assert.strictEqual(typeof db.makeStoreInit, 'function');
    assert.ok(Object.keys(db).length > 8, `db exports look stubbed: ${Object.keys(db).join(',')}`);
});

test('every check file that is loaded registers with an id (the loader stays silent)', () => {
    const registry = require('./index');
    const ids = new Set(registry.getAll().map(c => c.id));
    let files = 0;
    for (const dir of CHECK_DIRS) {
        const abs = path.join(__dirname, dir);
        if (!fs.existsSync(abs)) continue;
        for (const file of fs.readdirSync(abs)) {
            if (!file.endsWith('.js') || /\.(test|spec)\.js$/.test(file)) continue;
            files++;
            const mod = require(path.join(abs, file));
            assert.ok(mod && typeof mod.id === 'string' && mod.id, `${dir}/${file} exports no check id`);
            assert.ok(ids.has(mod.id), `${dir}/${file} (${mod.id}) is not in the registry`);
        }
    }
    assert.ok(files > 0, 'no check files found — the directories moved?');
});

test('every registered check has its title, description and fix in the English dictionary', () => {
    // A missing key does not fail anywhere else: the table falls back to the
    // check id, and "GDPR-Art30-personal-data-flows" shipped as a title that way.
    const registry = require('./index');
    const { GUI_DEFAULTS } = require('../../i18n/defaults/en');
    const missing = [];
    for (const c of registry.getAll()) {
        for (const field of ['titleKey', 'descriptionKey', 'remediationKey']) {
            const key = c[field];
            if (typeof key !== 'string' || !key) missing.push(`${c.id}: no ${field}`);
            else if (typeof GUI_DEFAULTS[key] !== 'string' || !GUI_DEFAULTS[key].trim()) missing.push(`${c.id}: ${field} ${key}`);
        }
    }
    assert.deepStrictEqual(missing, [], `checks without English copy:\n${missing.join('\n')}`);
});

// @typecheck
/**
 * GET /api/documents/list: a file that disappears between the directory read
 * and its stat (the renderer cleans its output directory up) is left out of
 * the listing; it does not fail the request.
 *
 * Run: cd server && node --test routes/documents.list.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../testUtils/routeHarness');

const { api } = h.routeUnderTest(test, '/', () => require('./documents'));

const OUTPUT_DIR = path.join(os.tmpdir(), 'document-renderer');
const inOutputDir = (p) => path.dirname(String(p)) === OUTPUT_DIR;

test('a document that vanished after the directory was read is skipped', async (t) => {
    const realStat = fs.statSync;
    const realExists = fs.existsSync;
    const realReaddir = fs.readdirSync;
    t.mock.method(fs, 'existsSync', (p) => (p === OUTPUT_DIR ? true : realExists(p)));
    t.mock.method(fs, 'readdirSync', (p, ...rest) => (p === OUTPUT_DIR ? ['a1_report.pdf', 'b2_gone.pdf', 'c3_notes.pdf'] : realReaddir(p, ...rest)));
    t.mock.method(fs, 'statSync', (p, ...rest) => {
        if (!inOutputDir(p)) return realStat(p, ...rest);
        if (path.basename(p) === 'b2_gone.pdf') throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${p}'`), { code: 'ENOENT' });
        return { size: 42, birthtime: new Date(path.basename(p) === 'a1_report.pdf' ? '2026-01-02T00:00:00Z' : '2026-01-01T00:00:00Z') };
    });

    const res = await api.call('GET', '/list');
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.documents.map((d) => [d.id, d.name, d.sizeBytes]), [
        ['a1_report.pdf', 'report.pdf', 42],
        ['c3_notes.pdf', 'notes.pdf', 42],
    ]);
});

'use strict';
/**
 * core/documents/documentParsePool — what happens to the parses QUEUED behind one
 * that runs past its deadline.
 *
 * Run: cd server && node --test core/documents/documentParsePool.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const pool = require('./documentParsePool');

test('a parse queued behind one that hits the deadline runs on a fresh worker, not the one being stopped', async () => {
    const saved = { t: process.env.DOCUMENT_PARSE_TIMEOUT_MS, w: process.env.DOCUMENT_PARSE_WORKERS };
    process.env.DOCUMENT_PARSE_TIMEOUT_MS = '100';
    process.env.DOCUMENT_PARSE_WORKERS = '1';
    await pool._useWorkerScript(path.join(__dirname, 'documentParseWorker.selective.fixture.js'));
    try {
        const job = (/** @type {string} */ filename) => ({ buffer: Buffer.from('x'), mimeType: 'application/pdf', filename, options: {} });
        const hung = pool.parseInWorker(job('hang'));
        const queued = pool.parseInWorker(job('next.pdf'));
        await assert.rejects(hung, /parsing took longer than/);
        assert.strictEqual(await queued, 'parsed next.pdf');
    } finally {
        await pool._useWorkerScript(null);
        for (const [k, v] of [['DOCUMENT_PARSE_TIMEOUT_MS', saved.t], ['DOCUMENT_PARSE_WORKERS', saved.w]]) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
});

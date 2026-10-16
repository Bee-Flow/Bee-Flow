/**
 * The page runtime's database routes (window.beeflowDB) go through the page
 * database statement check. The real router and the real store are mounted;
 * only requests that are refused (or touch nothing) are sent, so no database
 * or storage is needed.
 *
 * Run: cd server && node --test routes/webpagesPreview.dbGuard.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.WEBPAGE_PREVIEW_TOKEN_SECRET = 'x'.repeat(40);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const { issuePreviewToken } = require('../auth/webpagePreviewToken');
const router = require('./webpagesPreview');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beeflow-route-guard-'));
const target = path.join(dir, 'x.db');
let server;
let base;
const { token } = issuePreviewToken({ userId: 'author-1', webpageId: 'wp-guard' });

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/preview', router);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}/preview/wp-guard`;
});
test.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
});

async function post(route, body) {
    const res = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

test('db routes refuse a statement that leaves the page database', async () => {
    const sql = `ATTACH DATABASE '${target}' AS x`;
    for (const [route, body] of [
        ['/db/exec', { sql }],
        ['/db/query', { sql }],
        ['/db/batch', { statements: [{ sql }] }],
        ['/db/exec', { sql: `CREATE TABLE t (a); ${sql}` }],
        ['/db/query', { sql: 'PRAGMA database_list' }],
    ]) {
        const res = await post(route, body);
        assert.strictEqual(res.status, 400, route);
        assert.strictEqual(res.body.error, 'This statement is not allowed in a page database');
    }
    assert.strictEqual(fs.existsSync(target), false, 'no file appeared');
});

test('a failing statement that passes the check answers with SQL text and no path', async () => {
    const res = await post('/db/query', { sql: 'SELECT * FROM no_such_table' });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /no such table/);
    assert.doesNotMatch(res.body.error, /[\\/]/);
});

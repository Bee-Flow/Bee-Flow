/**
 * Tests for the nextcloud_create_spreadsheet / nextcloud_create_document tool
 * handlers — verifies the WebDAV wiring (parent-folder MKCOL, then a PUT of the
 * generated BINARY with the right Content-Type) without any network or DB, by
 * stubbing nextcloudClient.resolveAuth with a recording fake fetch.
 *
 * Run: node --test integrations/nextcloudTools.officegen.test.js
 */

const { test } = require('node:test');
const assert = require('assert');
const JSZip = require('jszip');
const ncClient = require('./nextcloudClient');

// Stub auth BEFORE requiring the tools module uses it (resolveAuth is read at
// call time, so patching the export is enough).
function installFakeAuth() {
    const calls = [];
    ncClient.resolveAuth = async () => ({
        baseUrl: 'https://nc.example.test',
        uid: 'alice',
        authError: 'auth failed',
        fetch: async (url, opts = {}) => {
            calls.push({ url, method: opts.method, headers: opts.headers || {}, body: opts.body });
            // MKCOL → 201; PUT → 201 created
            return { ok: true, status: 201, text: async () => '' };
        },
    });
    return calls;
}

const { executeNextcloudTool } = require('./nextcloudTools');

test('nextcloud_create_spreadsheet → MKCOLs parents then PUTs a real xlsx', async () => {
    const calls = installFakeAuth();
    const res = await executeNextcloudTool('nextcloud_create_spreadsheet', {
        path: '/Reports/2026/invoices.xlsx',
        rows: [{ Invoice: '202600117', Amount: 47.87 }, { Invoice: '202600342', Amount: 9.08 }],
        sheetName: 'Invoices',
    }, 'user-1', {});

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.path, '/Reports/2026/invoices.xlsx');
    assert.strictEqual(res.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const mkcols = calls.filter((c) => c.method === 'MKCOL').map((c) => c.url);
    assert.ok(mkcols.some((u) => u.endsWith('/Reports')), 'created /Reports');
    assert.ok(mkcols.some((u) => u.endsWith('/Reports/2026')), 'created /Reports/2026');

    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(put, 'a PUT was made');
    assert.strictEqual(put.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.ok(put.headers['OC-Total-Length'], 'declares OC-Total-Length');
    assert.ok(Buffer.isBuffer(put.body), 'PUT body is a binary Buffer');
    const zip = await JSZip.loadAsync(put.body);
    const sheet = await zip.file('xl/worksheets/sheet1.xml').async('string');
    assert.ok(sheet.includes('<v>47.87</v>'), 'uploaded xlsx contains the numeric data');
});

test('nextcloud_create_document → format inferred from .odt extension', async () => {
    const calls = installFakeAuth();
    const res = await executeNextcloudTool('nextcloud_create_document', {
        path: '/Notes/summary.odt',
        content: '# Summary\n\nAll good.',
    }, 'user-1', {});
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.contentType, 'application/vnd.oasis.opendocument.text');
    const put = calls.find((c) => c.method === 'PUT');
    assert.ok(Buffer.isBuffer(put.body));
    const zip = await JSZip.loadAsync(put.body);
    assert.strictEqual(await zip.file('mimetype').async('string'), 'application/vnd.oasis.opendocument.text');
});

test('nextcloud_create_spreadsheet → appends extension when missing', async () => {
    const calls = installFakeAuth();
    const res = await executeNextcloudTool('nextcloud_create_spreadsheet', {
        path: '/data', rows: [{ a: 1 }], format: 'xlsx',
    }, 'user-1', {});
    assert.strictEqual(res.path, '/data.xlsx');
    assert.ok(calls.find((c) => c.method === 'PUT').url.endsWith('/data.xlsx'));
});

test('nextcloud_create_spreadsheet → rejects empty rows', async () => {
    installFakeAuth();
    const res = await executeNextcloudTool('nextcloud_create_spreadsheet', { path: '/x.xlsx', rows: [] }, 'user-1', {});
    assert.ok(res.error && /non-empty/.test(res.error));
});

test('auth failure surfaces the friendly authError', async () => {
    const calls = [];
    ncClient.resolveAuth = async () => ({
        baseUrl: 'https://nc.example.test', uid: 'alice', authError: 'Reconnect Nextcloud',
        fetch: async (url, opts = {}) => { calls.push(opts.method); return { ok: false, status: 401, text: async () => '' }; },
    });
    const res = await executeNextcloudTool('nextcloud_create_document', { path: '/x.docx', content: 'hi' }, 'user-1', {});
    assert.strictEqual(res.error, 'Reconnect Nextcloud');
});

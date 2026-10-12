'use strict';

/**
 * Account erasure removes the leaver's CMS MCP upload tickets (config rows
 * `cms_mcp_upload_<id>`) and nobody else's.
 *
 * Run: cd server && node --test stores/user/users.cmsUploadTickets.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { eraseCmsUploadTickets } = require('./users');

function fakeConfigStore(rows) {
    return {
        deleted: [],
        listKeysWithPrefix: async (prefix) => Object.keys(rows).filter((k) => k.startsWith(prefix)),
        getConfigFresh: async (k) => rows[k] ?? null,
        async deleteConfig(k) { this.deleted.push(k); delete rows[k]; },
    };
}

test('the leaver\'s tickets go, a colleague\'s and unrelated rows stay', async () => {
    const rows = {
        cms_mcp_upload_aaa: { userId: 'leaver', secretHash: 'x' },
        cms_mcp_upload_bbb: { userId: 'colleague', secretHash: 'y' },
        cms_mcp_upload_ccc: { userId: 'leaver', secretHash: 'z', used: true },
        cms_mcp_upload_junk: 'not a ticket',
        other_key: { userId: 'leaver' },
    };
    const store = fakeConfigStore(rows);
    assert.strictEqual(await eraseCmsUploadTickets('leaver', store), 2);
    assert.deepStrictEqual(store.deleted.sort(), ['cms_mcp_upload_aaa', 'cms_mcp_upload_ccc']);
    assert.deepStrictEqual(Object.keys(rows).sort(), ['cms_mcp_upload_bbb', 'cms_mcp_upload_junk', 'other_key']);
});

test('no tickets, nothing to do', async () => {
    assert.strictEqual(await eraseCmsUploadTickets('u1', fakeConfigStore({})), 0);
});

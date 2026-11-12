/**
 * Account erasure removes the person's MCP server credentials (exact `_user_<id>` suffix) and closes their MCP
 * connections; another person's credentials for the same server stay.
 *
 * Run: cd server && node --test stores/user/mcpCredentialErasure.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { eraseMcpCredentials } = require('./mcpCredentialErasure.mts');

function fakeDeps(keys) {
    const store = new Set(keys);
    const disconnected = [];
    return {
        store, disconnected,
        listKeysWithPrefix: async (prefix) => [...store].filter((k) => k.startsWith(prefix)),
        deleteConfig: async (key) => { store.delete(key); },
        disconnectUser: async (userId) => { disconnected.push(userId); },
    };
}

test('deletes only the leaver\'s keys and closes the leaver\'s connections', async () => {
    const deps = fakeDeps([
        'mcp_cred_frappe_FRAPPE_API_SECRET_user_U',
        'mcp_cred_frappe_FRAPPE_URL_user_U',
        'mcp_cred_frappe_FRAPPE_API_SECRET_user_U2',
        'mcp_cred_tuya_TOKEN_user_XU',
        'other_key_user_U',
    ]);
    assert.strictEqual(await eraseMcpCredentials('U', deps), 2);
    assert.deepStrictEqual([...deps.store].sort(), [
        'mcp_cred_frappe_FRAPPE_API_SECRET_user_U2', 'mcp_cred_tuya_TOKEN_user_XU', 'other_key_user_U',
    ]);
    assert.deepStrictEqual(deps.disconnected, ['U']);
});

test('an empty id erases nothing', async () => {
    const deps = fakeDeps(['mcp_cred_a_K_user_']);
    assert.strictEqual(await eraseMcpCredentials('', deps), 0);
    assert.strictEqual(deps.store.size, 1);
    assert.deepStrictEqual(deps.disconnected, []);
});

// @typecheck
'use strict';
/**
 * Legacy MCP tokens stop verifying LEGACY_MCP_TOKEN_MAX_AGE_DAYS after they
 * were issued (default 365, 0 = unlimited); a re-mint starts a new lifetime.
 * Run: cd server && node --test auth/mcpToken.test.js
 */

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeSwaps } = require('../testUtils/swaps');

/** @type {Map<string, any>} */
const secrets = new Map();
/** @type {Map<string, any>} */
const config = new Map();
const { swap, restore } = makeSwaps();
const configStore = require('../stores/configStore');
swap(configStore, 'getSecret', async (/** @type {string} */ k) => secrets.get(k) ?? null);
swap(configStore, 'getConfig', async (/** @type {string} */ k) => config.get(k) ?? null);
swap(configStore, 'setConfig', async (/** @type {string} */ k, /** @type {any} */ v) => { config.set(k, v); });
swap(configStore, 'deleteConfig', async (/** @type {string} */ k) => { config.delete(k); });
const mcp = require('./mcpToken');
after(() => { restore(); delete process.env.LEGACY_MCP_TOKEN_MAX_AGE_DAYS; });

const DAY = 24 * 60 * 60 * 1000;
/** Mint for u1 the way the mint route does, issued `ageDays` ago. */
async function minted(ageDays = 0) {
    const { token, random } = mcp.mintToken('u1');
    secrets.set(mcp.SECRET_KEY('u1'), random);
    await mcp.recordIssued('u1', random, Date.now() - ageDays * DAY);
    return `Bearer ${token}`;
}

beforeEach(() => { secrets.clear(); config.clear(); delete process.env.LEGACY_MCP_TOKEN_MAX_AGE_DAYS; });

test('a fresh token verifies; one past the default 365 days does not', async () => {
    assert.strictEqual(await mcp.authenticateToken(await minted(10)), 'u1');
    assert.strictEqual(await mcp.authenticateToken(await minted(366)), null);
});

test('the lifetime follows LEGACY_MCP_TOKEN_MAX_AGE_DAYS, and 0 is unlimited', async () => {
    process.env.LEGACY_MCP_TOKEN_MAX_AGE_DAYS = '30';
    assert.strictEqual(await mcp.authenticateToken(await minted(31)), null);
    process.env.LEGACY_MCP_TOKEN_MAX_AGE_DAYS = '0';
    assert.strictEqual(await mcp.authenticateToken(await minted(5000)), 'u1');
    process.env.LEGACY_MCP_TOKEN_MAX_AGE_DAYS = 'nonsense';
    assert.strictEqual(mcp.maxAgeMs(), 365 * DAY);
});

test('a token without an issue record is stamped on first use, and a re-mint starts a new lifetime', async () => {
    const { token, random } = mcp.mintToken('u1');
    secrets.set(mcp.SECRET_KEY('u1'), random);
    assert.strictEqual(await mcp.authenticateToken(`Bearer ${token}`), 'u1');
    assert.ok(config.get(mcp.ISSUED_KEY('u1')).at <= Date.now());
    // An old record for a previous stored half does not age the new token.
    await mcp.recordIssued('u1', 'previous-half', Date.now() - 400 * DAY);
    assert.strictEqual(await mcp.authenticateToken(`Bearer ${token}`), 'u1');
});

test('a wrong secret still fails', async () => {
    await minted(0);
    const { token } = mcp.mintToken('u1');
    assert.strictEqual(await mcp.authenticateToken(`Bearer ${token}`), null);
});

test('clearIssued removes the issue record of a revoked token', async () => {
    await minted(0);
    assert.ok(config.has(mcp.ISSUED_KEY('u1')));
    await mcp.clearIssued('u1');
    assert.strictEqual(config.has(mcp.ISSUED_KEY('u1')), false);
});

/**
 * Direct chat offers the Studio Documents tools only to someone who holds
 * `studio_documents` (the enterprise split, 2026-10).
 *
 * The tools create and change documents, and routes/studioDocuments.js
 * refuses exactly those writes without the capability. Offering them anyway
 * would hand the model tools whose every call fails. documentToolsAllowed is
 * the question assembleToolStack asks; the check is injected here.
 *
 * Run: cd server && node --test routes/ai/directChat/toolStackAssembly.documentTools.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { documentToolsAllowed } = require('./toolStackAssembly');

const req = { session: { user: { id: 'u1', organizationId: 'org1' } } };

test('without Studio Documents the document tools are not offered', async () => {
    const asked = [];
    const allowed = await documentToolsAllowed({
        userId: 'u1', req,
        hasCapability: async (capId, who) => { asked.push({ capId, ...who }); return false; },
    });
    assert.strictEqual(allowed, false);
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].capId, 'studio_documents');
    assert.strictEqual(asked[0].userId, 'u1');
    assert.strictEqual(asked[0].orgId, 'org1', 'asked for the session\'s organisation, as requireCapability asks');
    assert.strictEqual(asked[0].session, req.session);
});

test('with Studio Documents they are', async () => {
    assert.strictEqual(await documentToolsAllowed({ userId: 'u1', req, hasCapability: async () => true }), true);
});

test('simple mode leaves them out without asking', async () => {
    let asked = false;
    const allowed = await documentToolsAllowed({
        userId: 'u1', req, userSimpleMode: true,
        hasCapability: async () => { asked = true; return true; },
    });
    assert.strictEqual(allowed, false);
    assert.strictEqual(asked, false);
});

test('a check that throws leaves them out: the tools are never offered on an unknown licence', async () => {
    const allowed = await documentToolsAllowed({
        userId: 'u1', req,
        hasCapability: async () => { throw new Error('resolver down'); },
    });
    assert.strictEqual(allowed, false);
});

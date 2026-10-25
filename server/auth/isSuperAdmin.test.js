/**
 * Unit — canonical isSuperAdmin predicate + requireSession light gate (H3).
 * DB-free. Run: node --test auth/isSuperAdmin.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { isSuperAdmin } = require('./permissions');
const { requireSession } = require('../utils/routeHelpers');

test('isSuperAdmin: true when session.isAdmin', () => {
    assert.strictEqual(isSuperAdmin({ session: { isAdmin: true } }), true);
});

test('isSuperAdmin: true when user.role === admin', () => {
    assert.strictEqual(isSuperAdmin({ session: { user: { role: 'admin' } } }), true);
});

test('isSuperAdmin: false for a plain user, and never throws on missing session', () => {
    assert.strictEqual(isSuperAdmin({ session: { user: { role: 'member' } } }), false);
    assert.strictEqual(isSuperAdmin({ session: {} }), false);
    assert.strictEqual(isSuperAdmin({}), false);
    assert.strictEqual(isSuperAdmin({ session: null }), false);
});

test('isSuperAdmin: always returns a strict boolean', () => {
    assert.strictEqual(typeof isSuperAdmin({ session: { isAdmin: 1 } }), 'boolean');
});

function runGate(req) {
    return new Promise((resolve) => {
        const res = { status: (code) => ({ json: (body) => resolve({ code, body }) }) };
        requireSession(req, res, () => resolve({ next: true }));
    });
}

test('requireSession: calls next() for a session with a user', async () => {
    const out = await runGate({ session: { user: { id: 'u1' } } });
    assert.deepStrictEqual(out, { next: true });
});

test('requireSession: 401 Not authenticated without a session user', async () => {
    const out = await runGate({ session: {} });
    assert.strictEqual(out.code, 401);
    assert.deepStrictEqual(out.body, { error: 'Not authenticated' });
});

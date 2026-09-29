/**
 * auth/permissions.requireSuperAdmin — the platform-operator gate itself.
 *
 * WHY: until 2026-08-10 there was no test anywhere for requireAdmin, and that
 * absence is how the platform/org scope confusion survived. requireAdmin passes
 * on the `manage_users` permission, which config/orgRoles.json grants to every
 * org_admin, so it answers "may manage users" rather than "runs this
 * installation" — and it was guarding licence issuance and instance-wide
 * signup/SSO policy. This file pins the replacement's contract so the same
 * mistake cannot be made silently again.
 *
 * The critical assertions are the negative ones: holding the `all` permission,
 * or orgRole 'org_admin', must NOT satisfy this gate. That asymmetry is what
 * stops the POST /auth/roles -> group -> 'all' escalation ladder from reaching
 * platform scope.
 *
 * Run: node --test auth/requireSuperAdmin.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { requireSuperAdmin, isSuperAdmin } = require('./permissions');
const { readGate } = require('./gateMeta');

// Drives the middleware and reports whichever happened: next(), or a response.
function run(session) {
    const result = { nexted: false, status: null, body: null };
    const res = {
        status(code) { result.status = code; return this; },
        json(body) { result.body = body; return this; },
    };
    requireSuperAdmin({ session }, res, () => { result.nexted = true; });
    return result;
}

test('a platform admin passes (users.role === "admin")', () => {
    const r = run({ isAuthenticated: true, user: { id: 'a', role: 'admin' } });
    assert.strictEqual(r.nexted, true);
});

test('a session flagged isAdmin passes', () => {
    // Set by establishSession from the DB role, and re-synced by requireAuth
    // every 5s, so it cannot outlive a demotion for long.
    const r = run({ isAuthenticated: true, isAdmin: true, user: { id: 'a', role: 'user' } });
    assert.strictEqual(r.nexted, true);
});

test('an anonymous caller gets 401, not 403', () => {
    const r = run(null);
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(r.status, 401);
});

test('an authenticated session without a user gets 401', () => {
    const r = run({ isAuthenticated: true });
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(r.status, 401);
});

test('an org_admin is REFUSED — the pentest actor', () => {
    const r = run({
        isAuthenticated: true,
        user: { id: 'pentester2', role: 'user', orgRole: 'org_admin', organizationId: 'someorg' },
    });
    assert.strictEqual(r.nexted, false, 'an org admin must never reach a platform-scoped route');
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body?.error, 'Operator access required');
});

test("a holder of the 'all' permission is REFUSED", () => {
    // 'all' is reachable from inside a tenant: an org admin can POST /auth/roles
    // with permissions:['all'] and attach that role to one of their own groups.
    // If this gate honoured 'all', that ladder would reach platform scope.
    const r = run({ isAuthenticated: true, user: { id: 'x', role: 'user', permissions: ['all'] } });
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(r.status, 403);
});

test('the legacy orgRole "admin" is REFUSED', () => {
    // permissions.js normalises orgRole 'admin' to 'org_admin' when resolving
    // permissions, so this legacy spelling carries manage_users too.
    const r = run({ isAuthenticated: true, user: { id: 'x', role: 'user', orgRole: 'admin' } });
    assert.strictEqual(r.nexted, false);
    assert.strictEqual(r.status, 403);
});

test('it agrees with the isSuperAdmin predicate', () => {
    const cases = [
        { isAuthenticated: true, user: { id: 'a', role: 'admin' } },
        { isAuthenticated: true, isAdmin: true, user: { id: 'a', role: 'user' } },
        { isAuthenticated: true, user: { id: 'a', role: 'user', orgRole: 'org_admin' } },
        { isAuthenticated: true, user: { id: 'a', role: 'user', permissions: ['all'] } },
    ];
    for (const session of cases) {
        assert.strictEqual(
            run(session).nexted, isSuperAdmin({ session }),
            `gate and predicate disagree for ${JSON.stringify(session)}`,
        );
    }
});

test('it carries a platform gate tag for the route walker', () => {
    // auth/routeWalk.cli.js recovers this; without it the chain slot reads as
    // an anonymous function and accessRegistry.drift.test.js assertion 4 fails.
    const gate = readGate(requireSuperAdmin);
    assert.ok(gate, 'requireSuperAdmin must be tagged via gateMeta.tagGate');
    assert.strictEqual(gate.axis, 'platform');
    assert.strictEqual(gate.kind, 'superAdmin');
});

test('it is synchronous — no DB lookup can soften it', () => {
    // requireAdmin resolves permissions through getUserPermissions, which has a
    // degraded-lookup fallback. This gate reads the session only, so there is
    // no code path in which a DB failure turns a denial into an allow.
    assert.notStrictEqual(
        requireSuperAdmin.constructor.name, 'AsyncFunction',
        'requireSuperAdmin must not be async',
    );
    const r = requireSuperAdmin({ session: null }, {
        status() { return this; }, json() { return this; },
    }, () => {});
    assert.ok(!(r instanceof Promise), 'must not return a promise');
});

/**
 * Tests for gate tagging.
 *
 * Two things matter here, and the second matters more:
 *
 * 1. The tag says the right thing — a router walk must be able to recover which
 *    permission/capability/tier a gate enforces.
 * 2. The tag is INERT. permissions.js is the most security-critical file in the
 *    repo and `requireAuth` alone is referenced from 69 files / 570 sites. A tag
 *    that altered a middleware's identity, arity, enumerability or behaviour
 *    would be a terrible trade for a diagnostic. These tests pin that it does not.
 *
 * Run: cd server && node --test auth/gateMeta.test.js
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { GATE, tagGate, readGate, lazyGate } = require('./gateMeta');

describe('tagGate', () => {
    test('returns the same function object, not a wrapper', () => {
        const fn = (req, res, next) => next();
        assert.strictEqual(tagGate(fn, { axis: 'rbac' }), fn);
    });

    test('preserves arity and name — the walk reads fn.name', () => {
        const fn = function namedGate(req, res, next) { next(); };
        tagGate(fn, { axis: 'auth' });
        assert.strictEqual(fn.name, 'namedGate');
        assert.strictEqual(fn.length, 3);
    });

    test('does not change what the middleware does', async () => {
        let called = false;
        const fn = tagGate((req, res, next) => { called = true; next(); }, { axis: 'auth' });
        await new Promise((resolve) => fn({}, {}, resolve));
        assert.equal(called, true);
    });

    test('is invisible to JSON.stringify, Object.keys and spread', () => {
        const fn = tagGate((req, res, next) => next(), { axis: 'rbac', anyOf: ['x'] });
        assert.deepEqual(Object.keys(fn), []);
        assert.deepEqual(Object.getOwnPropertyNames(fn).filter((k) => k === 'gate'), []);
        assert.equal(JSON.stringify({ fn }), '{}');
        assert.deepEqual(Object.keys({ ...fn }), []);
    });

    test('freezes the metadata so a consumer cannot mutate a gate description', () => {
        const fn = tagGate((req, res, next) => next(), { axis: 'rbac', anyOf: ['x'] });
        // This file is CJS (sloppy mode), so the write silently no-ops rather
        // than throwing — assert the guarantee that matters, not the mechanism.
        readGate(fn).axis = 'auth';
        assert.equal(readGate(fn).axis, 'rbac');
        assert.equal(Object.isFrozen(readGate(fn)), true);
    });

    test('copies the metadata so a later mutation of the caller object cannot rewrite a tag', () => {
        const meta = { axis: 'rbac', anyOf: ['x'] };
        const fn = tagGate((req, res, next) => next(), meta);
        meta.axis = 'auth';
        assert.equal(readGate(fn).axis, 'rbac');
    });

    test('tolerates a non-function without throwing', () => {
        assert.equal(tagGate(null, { axis: 'auth' }), null);
        assert.equal(tagGate(undefined, { axis: 'auth' }), undefined);
    });
});

describe('readGate', () => {
    test('returns null for an untagged function — the walk must distinguish these', () => {
        assert.equal(readGate((req, res, next) => next()), null);
        assert.equal(readGate(null), null);
        assert.equal(readGate(undefined), null);
    });

    test('round-trips the metadata', () => {
        const fn = tagGate((req, res, next) => next(), { axis: 'capability', id: 'notebooks' });
        assert.deepEqual(readGate(fn), { axis: 'capability', id: 'notebooks' });
    });

    test('reads through the shared Symbol.for registry, not a module-local symbol', () => {
        // A separately-resolved copy of gateMeta must still read the tag,
        // otherwise the walker in a child process would see nothing.
        const fn = tagGate((req, res, next) => next(), { axis: 'auth' });
        assert.deepEqual(fn[Symbol.for('bf.gate')], { axis: 'auth' });
        assert.strictEqual(GATE, Symbol.for('bf.gate'));
    });
});

describe('lazyGate', () => {
    test('defers the factory to request time but is tagged immediately', () => {
        let built = 0;
        const mw = lazyGate(() => { built += 1; return (req, res, next) => next(); }, { axis: 'capability', id: 'z' });

        assert.deepEqual(readGate(mw), { axis: 'capability', id: 'z' });
        assert.equal(built, 0, 'the factory must not run at mount time — that is the point of the deferral');
    });

    test('invokes the built middleware on a request', async () => {
        let ran = false;
        const mw = lazyGate(() => (req, res, next) => { ran = true; next(); }, { axis: 'capability', id: 'z' });
        await new Promise((resolve) => mw({}, {}, resolve));
        assert.equal(ran, true);
    });
});

// ── The real factories ───────────────────────────────────────────────
// These are the tags auth/routeWalk.cli.js depends on. If a factory stops
// tagging, the route table silently degrades to "USE:anonymous" and the Access
// Map starts reporting "Not determined" for routes it used to know.

describe('the shipped gate factories are tagged', () => {
    const permissions = require('./permissions');

    test('requireAuth declares the auth axis', () => {
        assert.deepEqual(readGate(permissions.requireAuth), { axis: 'auth' });
    });

    // Regression: tagging these as `const x = tagGate(async () => {...})` passes
    // the arrow as an ARGUMENT, which defeats JS name inference from the const
    // and silently renames the middleware to ''. That broke
    // routes/automation.routetable.test.js's frozen baseline
    // ('USE:requireAuth' → 'USE:anonymous'), degrades every stack trace through
    // these functions, and blinds the walker's fn.name fallback. Tag AFTER
    // definition instead.
    for (const name of ['requireAuth', 'requireAdmin', 'requirePluginAdmin']) {
        test(`${name} keeps its name — tagging must not anonymise a middleware`, () => {
            assert.equal(permissions[name].name, name);
        });
    }

    test('requirePermission carries the permission id it closed over', () => {
        assert.deepEqual(readGate(permissions.requirePermission('manage_users')), {
            axis: 'rbac',
            anyOf: ['manage_users', 'all'],
        });
    });

    test('requireAdmin declares what it actually accepts', () => {
        // Not "admin" — manage_users OR all. The tag records the real rule.
        assert.deepEqual(readGate(permissions.requireAdmin), { axis: 'rbac', anyOf: ['manage_users', 'all'] });
    });

    test('requirePluginAdmin declares admin_components', () => {
        assert.deepEqual(readGate(permissions.requirePluginAdmin), { axis: 'rbac', anyOf: ['admin_components', 'all'] });
    });

    test('requireOrgAdmin records the param it depends on', () => {
        const gate = readGate(permissions.requireOrgAdmin('orgId'));
        assert.equal(gate.axis, 'scope');
        assert.equal(gate.param, 'orgId');
        assert.equal(gate.paramDependent, true, 'no static verdict exists for a param-dependent gate');
    });

    test('requirePrimaryOrgAdmin is scope but NOT param-dependent', () => {
        const gate = readGate(permissions.requirePrimaryOrgAdmin());
        assert.equal(gate.kind, 'orgAdminOfOwnOrg');
        assert.notEqual(gate.paramDependent, true);
    });

    test('requireActiveOrg records that it fails open', () => {
        const gate = readGate(permissions.requireActiveOrg());
        assert.equal(gate.axis, 'orgStatus');
        assert.equal(gate.failsOpen, true, 'the Access Map must render this unknown, not deny, when degraded');
        assert.equal(gate.mutationsOnly, false);
    });

    test('requireActiveOrgForMutations records that it only bites on writes', () => {
        const gate = readGate(permissions.requireActiveOrgForMutations());
        assert.equal(gate.axis, 'orgStatus');
        assert.equal(gate.mutationsOnly, true);
    });
});

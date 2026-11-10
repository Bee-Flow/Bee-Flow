// @typecheck
/**
 * Shared seams of the platform-admin tests of the instance-wide AI routers
 * (ai/providers.platformAdmin.test.js, ai/config/instanceConfig.platformAdmin.test.js).
 *
 * The router runs behind a real express app (testUtils/routeHarness) with the
 * database recorded; the gate is the real auth/requirePlatformAdmin, built
 * with a fixture super-admin predicate and put in the barrel's place.
 */

'use strict';

const assert = require('node:assert');
const h = require('../../testUtils/routeHarness');
const { createPlatformAdminGate } = require('../../auth/requirePlatformAdmin');

const gate = createPlatformAdminGate({
    isSuperAdmin: (req) => {
        const { session } = /** @type {{ session?: { isAdmin?: boolean, user?: { role?: string } } }} */ (/** @type {unknown} */ (req));
        return !!(session?.isAdmin || session?.user?.role === 'admin');
    },
});

const PLATFORM_ADMIN = { ...h.USER, role: 'admin' };
const ORG_ADMIN = { ...h.USER, role: 'user', orgRole: 'org_admin' };
const MEMBER = h.USER;

/**
 * Runs `fn` once per deployment mode (license.deploymentMode reads the env).
 * @param {(mode: string) => Promise<void>} fn
 */
async function inEachMode(fn) {
    const before = process.env.DEPLOYMENT_MODE;
    try {
        for (const mode of ['cloud', 'self-hosted']) {
            process.env.DEPLOYMENT_MODE = mode;
            await fn(mode);
        }
    } finally {
        if (before === undefined) delete process.env.DEPLOYMENT_MODE;
        else process.env.DEPLOYMENT_MODE = before;
    }
}

/**
 * The router `load()` returns, served at /ai behind the real platform-admin
 * gate; `answer` answers the recorded database's reads. `writes()` lists the
 * statements that changed something.
 * @param {typeof import('node:test')} test
 * @param {() => import('express').Router} load
 * @param {(sql: string, params?: unknown[]) => unknown} answer
 */
function platformGatedRoute(test, load, answer) {
    const { db, api } = h.routeUnderTest(test, '/ai', load, {
        gates: { hasPlatformAdminAccess: gate.hasPlatformAdminAccess, requirePlatformAdmin: gate.requirePlatformAdmin },
        answer,
    });
    const writes = () => db.queries.filter((/** @type {string} */ q) => /INSERT|UPDATE|DELETE/i.test(q));
    return { db, api, writes };
}

/**
 * An org_admin is refused on every call with the gate's answer, in cloud and
 * self-hosted alike, and nothing is written.
 * @param {ReturnType<typeof platformGatedRoute>} route
 * @param {Array<[string, string, unknown]>} calls  method, path under /ai, body
 */
async function assertOrgAdminRefused(route, calls) {
    await inEachMode(async (mode) => {
        route.db.reset();
        for (const [method, url, body] of calls) {
            const res = await route.api.call(method, `/ai${url}`, { body, user: ORG_ADMIN });
            assert.strictEqual(res.status, 403, `${mode} ${method} ${url}: ${res.text}`);
            assert.deepStrictEqual(res.body, { error: 'Admin access required' });
        }
        assert.deepStrictEqual(route.writes(), [], mode);
    });
}

module.exports = { PLATFORM_ADMIN, ORG_ADMIN, MEMBER, inEachMode, platformGatedRoute, assertOrgAdminRefused };

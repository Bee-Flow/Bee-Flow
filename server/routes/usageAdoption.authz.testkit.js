'use strict';
/**
 * The test bed of the Adoption report's route tests: the real router chain
 * (session → query → admin_monitoring → the organisation from the session)
 * over the real Adoption store and users on PGlite
 * (stores/adoption/adoption.testkit.js: two organisations, A and B).
 * Injected: the permission lookup (a table per user, behind the same 401/403
 * answers as auth/permissions requirePermission), the cost lens and the clock.
 *
 *   const r = require('./usageAdoption.authz.testkit');
 *   r.useAdoptionApi();                       // before / after / beforeEach of the file
 *   const res = await r.get('/summary?days=30', r.as('a-owner'));
 *
 * Test-only (`.testkit.js`: neither the server nor the layering scan loads it).
 */

const { before, after, beforeEach } = require('node:test');
const kit = require('../stores/adoption/adoption.testkit');
const h = require('../testUtils/routeHarness');

/** @type {Record<string, string[]>} */
const PERMS = {
    'a-owner': ['all'],
    'a-colleague': ['admin_monitoring'],
    'a-seen': ['page_chat'],
    solo: ['all'],
};

/** The 401/403 answers of auth/permissions requirePermission, over the table above. */
const permissions = {
    requirePermission: (/** @type {string} */ perm) => async (req, res, next) => {
        if (!req.session?.isAuthenticated || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
        const held = PERMS[req.session.user.id] || [];
        if (held.includes(perm) || held.includes('all')) return next();
        return res.status(403).json({ error: `Permission '${perm}' required` });
    },
};

const rawLens = { costLens: async () => ({ raw: true, cost: (v) => (v == null ? null : v), calls: (v) => Number(v) || 0 }) };

/** What a test may change for one test; reset before every test. */
const state = { lens: rawLens, auditFails: false, api: null, router: null };

/** Set one column of a users or groups row (the test's own setup, restored by the test that changes it). */
async function setRow(table, id, column, value) {
    const { run } = kit.db();
    await run(`UPDATE ${table} SET "${column}" = $2 WHERE id = $1`, [id, value]);
}

async function setUp() {
    await kit.setUp();
    const userStore = require('../stores/userStore');
    await userStore.createUser({ id: 'solo', username: 'solo', email: 'solo@adopt.test', role: 'user', passwordHash: 'x' });
    const realStore = kit.store();
    const store = new Proxy(realStore, {
        get(target, prop) {
            if (prop === 'recordReveal' && state.auditFails) return async () => { throw new Error('db down'); };
            if (prop === 'periodOf') return require('../stores/adoptionStore').periodOf;
            return target[prop];
        },
    });
    // The roles the report's own check reads: the owner administers org A, the colleague is its DPO.
    await setRow('users', 'a-owner', 'orgRole', 'org_admin');
    await setRow('users', 'a-colleague', 'orgRole', 'dpo');
    const { createAdoptionRouter } = require('./usageAdoption');
    state.router = createAdoptionRouter({
        store, userStore, permissions,
        scope: require('./usageScope'),
        redact: { costLens: (req) => state.lens.costLens(req) },
        pseudonym: require('../core/privacy/pseudonym'),
        orgRoles: require('../auth/orgRolePolicy'),
        catalog: require('../auth/permissionsCatalog'),
        now: () => kit.NOW,
    });
    state.api = h.serve('/api/usage/adoption', state.router);
}

/** Registers the file's before, after and beforeEach. */
function useAdoptionApi() {
    before(setUp, { timeout: 240_000 });
    after(async () => {
        if (state.api) await state.api.close();
        await kit.tearDown();
    });
    beforeEach(() => {
        state.router?.__clearCacheForTests?.();
        state.lens = rawLens;
        state.auditFails = false;
    });
}

const as = (id, orgId = kit.ORG_A) => ({ id, username: id, organizationId: orgId, role: 'user' });
const ID = /^[0-9a-f]{16}$/;
const LABEL = /^Member · [A-HJ-NP-Z2-9]{4}$/;

function pseudonyms() {
    const { pseudonymFor, pseudonymId, pseudonymSecret } = require('../core/privacy/pseudonym');
    const secret = pseudonymSecret();
    return {
        id: (userId, orgId = kit.ORG_A) => pseudonymId(userId, orgId, secret),
        label: (userId, orgId = kit.ORG_A) => pseudonymFor(userId, orgId, secret),
        top: (userId, orgId = kit.ORG_A) => pseudonymFor(userId, orgId, secret, { domain: 'top-people' }),
    };
}
const get = (url, user) => state.api.call('GET', `/api/usage/adoption${url}`, { user });

async function revealRows() {
    const { getAll } = kit.db();
    return getAll(`SELECT * FROM access_audit_log WHERE action = 'usage_adoption_people_revealed' ORDER BY created_at`);
}

/** The text of a report answer leaks nothing of organisation B. */
const B_TRACE = /\bb-|Owner B|Big b|org-adopt-b/;

module.exports = { useAdoptionApi, state, PERMS, setRow, as, ID, LABEL, pseudonyms, get, revealRows, B_TRACE, kit };

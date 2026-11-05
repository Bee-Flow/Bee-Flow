'use strict';
/**
 * Who may read the Adoption report, and what reaches them.
 *
 * The real router chain (session → query → admin_monitoring → the
 * organisation from the session) over the real Adoption store and users on
 * PGlite (stores/adoption/adoption.testkit.js: two organisations, A and B).
 * Injected: the permission lookup (a table per user, behind the same 401/403
 * answers as auth/permissions requirePermission), the cost lens and the clock.
 *
 *   - an org admin and an admin_monitoring holder get 200, a plain member 403,
 *     an account without an organisation 403 `no_organisation`;
 *   - nothing of organisation B reaches a caller of A;
 *   - people are pseudonymous by default, stable across calls, and differ per
 *     organisation; `?reveal=true` writes exactly one access-audit row with the
 *     allow-listed payload, then shows names; a failed write answers 503 and
 *     shows nothing;
 *   - a customer lens shows marked-up cost and no call counts.
 *
 * Run: cd server && node --test routes/usageAdoption.authz.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
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
let lens = rawLens;
let auditFails = false;

let api;
let router;
before(async () => {
    await kit.setUp();
    const userStore = require('../stores/userStore');
    await userStore.createUser({ id: 'solo', username: 'solo', email: 'solo@adopt.test', role: 'user', passwordHash: 'x' });
    const realStore = kit.store();
    const store = new Proxy(realStore, {
        get(target, prop) {
            if (prop === 'recordReveal' && auditFails) return async () => { throw new Error('db down'); };
            if (prop === 'periodOf') return require('../stores/adoptionStore').periodOf;
            return target[prop];
        },
    });
    const { createAdoptionRouter } = require('./usageAdoption');
    router = createAdoptionRouter({
        store, userStore, permissions,
        scope: require('./usageScope'),
        redact: { costLens: (req) => lens.costLens(req) },
        pseudonym: require('../core/privacy/pseudonym'),
        now: () => kit.NOW,
    });
    api = h.serve('/api/usage/adoption', router);
}, { timeout: 240_000 });

after(async () => {
    if (api) await api.close();
    await kit.tearDown();
});

beforeEach(() => {
    router?.__clearCacheForTests?.();
    lens = rawLens;
    auditFails = false;
});

const as = (id, orgId = kit.ORG_A) => ({ id, username: id, organizationId: orgId, role: 'user' });
const get = (url, user) => api.call('GET', `/api/usage/adoption${url}`, { user });

async function revealRows() {
    const { getAll } = require('../db');
    return getAll(`SELECT * FROM access_audit_log WHERE action = 'usage_adoption_people_revealed' ORDER BY created_at`);
}

test('an org admin and an admin_monitoring holder read the report', async () => {
    for (const who of ['a-owner', 'a-colleague']) {
        const res = await get('/summary?days=30', as(who));
        assert.equal(res.status, 200, `${who}: ${res.text}`);
        assert.equal(res.headers.get('cache-control'), 'private, no-store');
        assert.equal(res.body.members.total, 5, 'the pending invitation is no member');
    }
});

test('a plain member is refused; an account without an organisation too', async () => {
    const member = await get('/summary', as('a-seen'));
    assert.equal(member.status, 403);
    assert.equal(member.body.error, "Permission 'admin_monitoring' required");
    const solo = await get('/summary', { id: 'solo', username: 'solo', role: 'user' });
    assert.equal(solo.status, 403);
    assert.equal(solo.body.code, 'no_organisation');
});

test('the summary counts organisation A only, and the colleague as AI-active', async () => {
    const res = await get('/summary?days=30', as('a-owner'));
    const s = res.body;
    assert.equal(s.range.relative, true);
    assert.equal(s.members.aiActive, 2, 'owner and colleague; the run counts for the colleague');
    assert.equal(s.members.seenOnly, 1);
    assert.equal(s.members.dormant, 1);
    assert.equal(s.members.never, 1);
    assert.equal(s.members.seats.max, 25);
    assert.equal(s.makers.total, 2, 'owner, and the colleague who recorded a meeting');
    assert.equal(s.spend.cost, 3.6, 'guest rows and the row outside the period are left out');
    assert.equal(s.spend.calls, 4, 'the tool row is not a call');
    assert.equal(s.adoptionRate, 40);
});

test('people are pseudonymous, stable, and different per organisation', async () => {
    const first = await get('/people?days=30', as('a-owner'));
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.reveal, false);
    assert.equal(first.body.auditRecorded, false);
    for (const p of first.body.people) {
        assert.match(p.id, /^Member · [A-HJ-NP-Z2-9]{4}$/);
        assert.equal(p.name, p.id);
        assert.equal(p.avatar, null);
    }
    assert.ok(!JSON.stringify(first.body).includes('Owner A'), 'no name');
    assert.ok(!JSON.stringify(first.body).includes('a-owner'), 'no user id');
    router.__clearCacheForTests();
    const again = await get('/people?days=30', as('a-owner'));
    assert.deepEqual(again.body.people.map((p) => p.id), first.body.people.map((p) => p.id));

    const { pseudonymFor, pseudonymSecret } = require('../core/privacy/pseudonym');
    assert.notEqual(pseudonymFor('a-owner', kit.ORG_A, pseudonymSecret()), pseudonymFor('a-owner', kit.ORG_B, pseudonymSecret()));
    assert.equal(first.body.audit, undefined);
    assert.equal(first.body.total, 5);
    // The colleague's runs are theirs: the top row is the colleague, at 2.5.
    assert.equal(first.body.people[0].id, pseudonymFor('a-colleague', kit.ORG_A, pseudonymSecret()));
    assert.equal(first.body.people[0].cost, 2.5);
    assert.deepEqual(first.body.people[0].areas, ['apps', 'automations']);
    assert.equal(first.body.people[0].status, 'ai_active');
    assert.deepEqual(first.body.people[0].groups, ['Big a']);
});

test('reveal writes one audit row with the allow-listed payload, then shows names', async () => {
    const before = (await revealRows()).length;
    const res = await get('/people?days=30&limit=20', as('a-colleague'));
    assert.equal((await revealRows()).length, before, 'no audit without a reveal');
    const shown = await get('/people?days=30&limit=20&reveal=true', as('a-colleague'));
    assert.equal(shown.status, 200, shown.text);
    assert.equal(shown.body.reveal, true);
    assert.equal(shown.body.auditRecorded, true);
    assert.deepEqual(shown.body.people.map((p) => p.id).sort(), ['a-colleague', 'a-dormant', 'a-new', 'a-owner', 'a-seen']);
    assert.ok(shown.body.people.some((p) => p.name === 'Owner A'));
    const rows = await revealRows();
    assert.equal(rows.length, before + 1);
    const row = rows.at(-1);
    assert.equal(row.organization_id, kit.ORG_A);
    assert.equal(row.target_type, 'organization');
    assert.equal(row.target_id, kit.ORG_A);
    assert.equal(row.changed_by, 'a-colleague');
    const payload = JSON.parse(row.new_values);
    assert.deepEqual(Object.keys(payload).sort(), ['endDate', 'group', 'limit', 'startDate']);
    assert.equal(payload.limit, 20);
    assert.equal(payload.group, null);
    assert.equal(res.status, 200);
});

test('a reveal that cannot be recorded shows nothing', async () => {
    auditFails = true;
    const res = await get('/people?reveal=true', as('a-owner'));
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'audit_unavailable');
    assert.equal(res.body.people, undefined);
});

test('nothing of organisation B reaches organisation A', async () => {
    const urls = ['/summary', '/areas', '/studio', '/studio/items?kind=agent', '/studio/items?kind=automation', '/groups', '/people?reveal=true'];
    for (const url of urls) {
        const res = await get(url, as('a-owner'));
        assert.equal(res.status, 200, `${url}: ${res.text}`);
        assert.ok(!/\bb-|Owner B|Big b|org-adopt-b/.test(res.text), `${url} leaks org B: ${res.text.slice(0, 300)}`);
    }
});

test('?group narrows within the organisation and never widens to another', async () => {
    const own = await get('/people?group=a-grp-big&reveal=true', as('a-owner'));
    assert.deepEqual(own.body.people.map((p) => p.id).sort(), ['a-colleague', 'a-new', 'a-owner', 'a-seen']);
    const foreign = await get('/people?group=b-grp-big&reveal=true', as('a-owner'));
    assert.equal(foreign.status, 200);
    assert.deepEqual(foreign.body.people, [], "another organisation's group narrows to nobody");
    const sum = await get('/summary?group=b-grp-big', as('a-owner'));
    assert.equal(sum.body.members.total, 0);
    assert.equal(sum.body.spend.cost, 0);
});

test('groups fold the small ones, and the drill-down names owners but not users', async () => {
    const groups = await get('/groups?days=30', as('a-owner'));
    assert.equal(groups.status, 200, groups.text);
    assert.deepEqual(groups.body.groups, [], 'both groups have fewer than five members');
    assert.equal(groups.body.folded.count, 2);
    assert.equal(groups.body.folded.members, 5);
    const items = await get('/studio/items?kind=app', as('a-owner'));
    assert.equal(items.body.items[0].ownerName, 'Owner A');
    assert.match(items.body.topPeople[0].person, /^Member · /);
});

test('the drill-down needs a kind', async () => {
    const res = await get('/studio/items', as('a-owner'));
    assert.equal(res.status, 400);
});

test('a customer sees marked-up cost and no call counts', async () => {
    lens = { costLens: async () => ({ raw: false, cost: (v) => (v == null ? null : v * 1.5), calls: () => undefined }) };
    const s = await get('/summary?days=30', as('a-owner'));
    assert.equal(s.body.spend.cost, 3.6 * 1.5);
    assert.equal('calls' in s.body.spend, false);
    const areas = await get('/areas?days=30', as('a-owner'));
    const apps = areas.body.areas.find((a) => a.area === 'apps');
    assert.equal(apps.cost, 3);
    assert.equal('calls' in apps, false);
    assert.ok(apps.sources.every((src) => !('calls' in src)));
    assert.equal(areas.body.areas.length, 16, 'every area, zero rows included');
    const people = await get('/people', as('a-owner'));
    assert.ok(people.body.people.every((p) => !('calls' in p)));
});

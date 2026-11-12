'use strict';
/**
 * Who may read the Adoption report, and what reaches them.
 *
 * The real router chain (session → query → admin_monitoring → the
 * organisation from the session) over the real Adoption store and users on
 * PGlite (stores/adoption/adoption.testkit.js: two organisations, A and B).
 * Injected: the permission lookup (a table per user, behind the same 401/403
 * answers as auth/permissions requirePermission), the cost lens and the clock.
 * The check that admin_monitoring is held IN the reported organisation runs
 * for real (routes/usageAdoptionAccess.js over the users, groups and roles).
 *
 *   - an org admin and an admin_monitoring holder get 200, a plain member 403,
 *     an account without an organisation 403 `no_organisation`;
 *   - a super admin reads the organisation on their record, or is refused
 *     without one;
 *   - a role held only through a group of another organisation opens nothing;
 *   - nothing of organisation B reaches a caller of A;
 *   - people are pseudonymous by default (an opaque row id and the label),
 *     stable across calls, and differ per organisation; the top users of a
 *     Studio kind never carry their people-table label; `?reveal=true` writes exactly one access-audit row with the
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
    // The roles the report's own check reads: the owner administers org A, the colleague is its DPO.
    await setRow('users', 'a-owner', 'orgRole', 'org_admin');
    await setRow('users', 'a-colleague', 'orgRole', 'dpo');
    const { createAdoptionRouter } = require('./usageAdoption');
    router = createAdoptionRouter({
        store, userStore, permissions,
        scope: require('./usageScope'),
        redact: { costLens: (req) => lens.costLens(req) },
        pseudonym: require('../core/privacy/pseudonym'),
        orgRoles: require('../auth/orgRolePolicy'),
        catalog: require('../auth/permissionsCatalog'),
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
const ID = /^[0-9a-f]{16}$/;
const LABEL = /^Member · [A-HJ-NP-Z2-9]{4}$/;

/** Set one column of a users or groups row (the test's own setup, restored by the test that changes it). */
async function setRow(table, id, column, value) {
    const { run } = require('../db');
    await run(`UPDATE ${table} SET "${column}" = $2 WHERE id = $1`, [id, value]);
}

function pseudonyms() {
    const { pseudonymFor, pseudonymId, pseudonymSecret } = require('../core/privacy/pseudonym');
    const secret = pseudonymSecret();
    return {
        id: (userId, orgId = kit.ORG_A) => pseudonymId(userId, orgId, secret),
        label: (userId, orgId = kit.ORG_A) => pseudonymFor(userId, orgId, secret),
        top: (userId, orgId = kit.ORG_A) => pseudonymFor(userId, orgId, secret, { domain: 'top-people' }),
    };
}
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

test('a super admin reads the organisation on their record; without one they are refused', async () => {
    const root = await get('/summary?days=30', { ...as('a-owner'), role: 'admin' });
    assert.equal(root.status, 200, root.text);
    assert.equal(root.body.members.total, 5, 'organisation A, from the record');
    assert.equal(root.body.spend.cost, 3.6);
    const people = await get('/people?days=30&reveal=true', { ...as('a-owner'), role: 'admin' });
    assert.equal(people.status, 200, people.text);
    assert.ok(people.body.people.every((p) => p.id.startsWith('a-')), 'no member of organisation B');
    const none = await get('/summary', { id: 'solo', username: 'solo', role: 'admin' });
    assert.equal(none.status, 403);
    assert.equal(none.body.code, 'no_organisation');
});

test('a platform admin names the organisation with orgId; an organisation admin only their own', async () => {
    const root = { ...as('a-owner'), role: 'admin' };
    const people = await get(`/people?days=30&reveal=true&orgId=${kit.ORG_B}`, root);
    assert.equal(people.status, 200, people.text);
    assert.ok(people.body.people.length > 0 && people.body.people.every((p) => p.id.startsWith('b-')), 'members of organisation B only');
    const unknown = await get('/summary?days=30&orgId=no-such-org', root);
    assert.equal(unknown.status, 404, unknown.text);

    const own = await get(`/summary?days=30&orgId=${kit.ORG_A}`, as('a-owner'));
    assert.equal(own.status, 200, own.text);
    const other = await get(`/summary?days=30&orgId=${kit.ORG_B}`, as('a-owner'));
    assert.equal(other.status, 403, other.text);
    assert.equal(other.body.code, 'org_admin_required');
});

test('admin_monitoring from a group of another organisation opens nothing here', async () => {
    // a-seen is a plain member of A (home org) and sits in a group of B whose orgRole is dpo:
    // the union of permissions holds admin_monitoring, organisation A does not grant it.
    PERMS['a-seen'] = ['page_chat', 'admin_monitoring'];
    await setRow('groups', 'b-grp-small', 'orgRole', 'dpo');
    await setRow('users', 'a-seen', 'groups', JSON.stringify(['a-grp-big', 'b-grp-small']));
    try {
        const audits = (await revealRows()).length;
        for (const url of ['/summary', '/people?reveal=true', '/studio/items?kind=app']) {
            const res = await get(url, as('a-seen'));
            assert.equal(res.status, 403, `${url}: ${res.text}`);
            assert.equal(res.body.code, 'not_in_organisation');
            assert.equal(res.body.people, undefined);
        }
        assert.equal((await revealRows()).length, audits, 'a refused reveal writes no audit row');

        // The same role from a group of A itself does count.
        await setRow('groups', 'a-grp-small', 'orgRole', 'dpo');
        await setRow('users', 'a-seen', 'groups', JSON.stringify(['a-grp-big', 'a-grp-small']));
        const own = await get('/summary', as('a-seen'));
        assert.equal(own.status, 200, own.text);
    } finally {
        PERMS['a-seen'] = ['page_chat'];
        await setRow('groups', 'b-grp-small', 'orgRole', null);
        await setRow('groups', 'a-grp-small', 'orgRole', null);
        await setRow('users', 'a-seen', 'groups', JSON.stringify(['a-grp-big']));
    }
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
    const ps = pseudonyms();
    for (const p of first.body.people) {
        assert.match(p.id, ID, 'an opaque row id, not the four-symbol label');
        assert.match(p.name, LABEL);
        assert.equal(p.avatar, null);
    }
    assert.equal(new Set(first.body.people.map((p) => p.id)).size, first.body.people.length);
    assert.ok(!JSON.stringify(first.body).includes('Owner A'), 'no name');
    assert.ok(!JSON.stringify(first.body).includes('a-owner'), 'no user id');
    router.__clearCacheForTests();
    const again = await get('/people?days=30', as('a-owner'));
    assert.deepEqual(again.body.people.map((p) => p.id), first.body.people.map((p) => p.id));

    assert.notEqual(ps.label('a-owner', kit.ORG_A), ps.label('a-owner', kit.ORG_B));
    assert.notEqual(ps.id('a-owner', kit.ORG_A), ps.id('a-owner', kit.ORG_B));
    assert.equal(first.body.audit, undefined);
    assert.equal(first.body.total, 5);
    // The colleague's runs are theirs: the top row is the colleague, at 2.5 (shown as 3: one significant digit).
    assert.equal(first.body.people[0].id, ps.id('a-colleague'));
    assert.equal(first.body.people[0].name, ps.label('a-colleague'));
    assert.equal(first.body.people[0].cost, 3);
    assert.deepEqual(first.body.people[0].areas, ['apps', 'automations']);
    assert.equal(first.body.people[0].status, 'ai_active');
    assert.deepEqual(first.body.people[0].groups, ['Big a']);
});

test('under a pseudonym cost and calls are rough and moments are weeks; revealed, they are exact', async () => {
    const hidden = await get('/people?days=30', as('a-owner'));
    const shown = await get('/people?days=30&reveal=true', as('a-owner'));
    const exact = new Map(shown.body.people.map((p) => [p.cost, p]));
    for (const p of hidden.body.people) {
        for (const at of [p.lastSeenAt, p.firstAiUseAt]) {
            if (at === null) continue;
            assert.match(at, /^\d{4}-\d{2}-\d{2}$/, 'a date, not a timestamp');
            assert.equal(new Date(`${at}T00:00:00Z`).getUTCDay(), 1, 'the Monday of its week');
        }
        if (p.cost) assert.equal(Number(p.cost.toPrecision(1)), p.cost, 'one significant digit');
    }
    assert.ok(exact.has(2.5), 'the revealed row carries the exact cost');
    assert.ok(shown.body.people.some((p) => typeof p.lastSeenAt === 'string' && p.lastSeenAt.includes('T')), 'revealed moments stay timestamps');
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
    assert.match(items.body.topPeople[0].person, LABEL);
});

test('a top user of a kind never carries the label a people reveal names', async () => {
    const ps = pseudonyms();
    const items = await get('/studio/items?kind=app', as('a-owner'));
    assert.equal(items.status, 200, items.text);
    assert.deepEqual(items.body.topPeople.map((p) => p.person), [ps.top('a-colleague')]);
    const people = await get('/people?days=30', as('a-owner'));
    const tableLabels = new Set(people.body.people.map((p) => p.name));
    assert.ok(tableLabels.has(ps.label('a-colleague')));
    for (const p of items.body.topPeople) assert.ok(!tableLabels.has(p.person), `${p.person} is also a people-table label`);
});

test('the cache keys on the clamped page and holds people as rows, not as member records', async () => {
    router.__clearCacheForTests();
    const a = await get('/people?days=30&limit=500', as('a-owner'));
    const b = await get('/people?days=30&limit=9999', as('a-owner'));
    const c = await get('/people?days=30&limit=500&reveal=true', as('a-owner'));
    assert.equal(a.status, 200);
    assert.deepEqual(b.body.people, a.body.people);
    assert.equal(c.status, 200);
    assert.deepEqual(router.__cacheStatsForTests(), { entries: 1, rows: 5 }, 'one entry for the three requests');
    assert.ok(!JSON.stringify(c.body).includes('@adopt.test'), 'no e-mail address reaches the answer');
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

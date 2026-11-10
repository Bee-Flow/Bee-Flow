/**
 * Who may read the termination monitor, what its routes accept, and what they
 * say when they refuse (routes/terminations.js).
 *
 * The generic routes checked only for a session, under a mount gate that is a
 * licence capability every member of an entitled organisation holds: any
 * member read the organisation's termination log. They now ask for
 * `admin_monitoring`, as the admin console's Monitoring tab does; /org/* keeps
 * its org-admin role check.
 *
 * Each filter used to be read on its own and dropped when it did not parse,
 * and on a monitor a dropped filter is a WIDER answer under the narrow
 * heading: `?days=week` returned all time, `?agnet=` every agent, `?type=`
 * with a type the store never writes an empty list. And the other way round:
 * both screens ask for "All" by sending no range, which used to mean the last
 * 30 days. What this file pins:
 *
 *   - the 400 NAMES the field (`query.days`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request reads nothing;
 *   - no range is all time, and the ranges the screens send still narrow.
 *
 * Run: cd server && node --test routes/terminations.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'q'.repeat(40);

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store read lands in `touched`. A refused request must leave it empty.
const touched = [];
// Who holds `admin_monitoring`, and which org role each user has.
const fx = {
    monitoring: new Set(['u1']), orgRole: { u1: 'org_admin' }, rows: [],
    /** Home organisation per user (org-1 when unlisted), groups per user, the organisations that exist. */
    homeOrg: {}, groups: {}, orgs: { 'org-1': { id: 'org-1', name: 'Org One' }, 'org-2': { id: 'org-2', name: 'Org Two' } },
};

const MOCKS = {
    '../stores/terminationStore': {
        getList: async (filters, limit) => { touched.push({ what: 'getList', filters, limit }); return fx.rows; },
        getSummary: async (filters) => { touched.push({ what: 'getSummary', filters }); return { total: 0, by_type: {} }; },
        getTimeline: async (filters, interval) => { touched.push({ what: 'getTimeline', filters, interval }); return []; },
        getByAgent: async (filters) => { touched.push({ what: 'getByAgent', filters }); return []; },
    },
    '../auth': {
        // null for a platform admin, as the real one answers.
        resolveUserOrgIds: async (req) => (req.session?.isAdmin ? null : new Set(['org-1'])),
        isOrgAdminRole: (role) => role === 'org_admin',
        // The decision lines of the real requirePermission (auth/permissions.js).
        requirePermission: (permission) => (req, res, next) => {
            if (!req.session?.isAuthenticated || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
            if (permission === 'admin_monitoring' && fx.monitoring.has(req.session.user.id)) return next();
            return res.status(403).json({ error: `Permission '${permission}' required` });
        },
    },
    '../stores/userStore': {
        getUser: async (id) => ({ id, orgRole: fx.orgRole[id] || 'member', organizationId: fx.homeOrg[id] ?? 'org-1', groups: fx.groups[id] || [] }),
        getOrganization: async (id) => fx.orgs[id] || null,
    },
};
// The /org routes' organisation: the real decision (auth/adminOrg.mts) over the users above.
MOCKS['../auth/permissions'] = require('../auth/adminOrg.mts').createAdminOrgGate({
    isSuperAdmin: (req) => !!(req.session?.isAdmin || req.session?.user?.role === 'admin'),
    evalOrgAdmin: (user, groups, orgId) => (user.organizationId === orgId && user.orgRole === 'org_admin')
        || groups.some((g) => user.groups.includes(g.id) && g.organizationId === orgId && g.roles.includes('org_admin')),
    getUser: (id) => MOCKS['../stores/userStore'].getUser(id),
    getAllGroups: async () => [{ id: 'g-b-admins', organizationId: 'org-2', roles: ['org_admin'] }],
    getOrganization: (id) => MOCKS['../stores/userStore'].getOrganization(id),
});

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:terminations-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

// The person column (core/privacy/personColumn.js) reaches the database for the audit row and the names.
const audit = { rows: [], fail: false };
const PERSON_MOCKS = {
    '../../db': { run: async (sql, params) => { if (audit.fail) throw new Error('db down'); audit.rows.push(params); } },
    '../../stores/userStore': { getUserAvatarsByIds: async () => [{ id: 'u1', username: 'kim', displayName: 'Kim Jansen' }] },
};
for (const [request, exportsObj] of Object.entries(PERSON_MOCKS)) {
    const mockId = `mock:terminations-validation:person:${request}`;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /core[\\/]privacy[\\/]personColumn\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(PERSON_MOCKS, request)) {
        return `mock:terminations-validation:person:${request}`;
    }
    if (parent && /routes[\\/]terminations\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./terminations');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const SIGNED_IN = { isAuthenticated: true, user: { id: 'u1' } };

function dispatch(url, session = SIGNED_IN) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, body: undefined, headers: {},
            session, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => {
    touched.length = 0;
    fx.monitoring = new Set(['u1']);
    fx.orgRole = { u1: 'org_admin' };
    fx.rows = [];
    fx.homeOrg = {};
    fx.groups = {};
    audit.rows.length = 0;
    audit.fail = false;
});

async function refuses(url, field) {
    const res = await dispatch(url);
    assert.strictEqual(res.statusCode, 400, `${url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ Filters that used to widen the answer ══════════════════════════

test('a range that is not a number of days is refused, not answered with all time', async () => {
    const res = await refuses('/?days=week', 'query.days');
    assert.strictEqual(res.body.error, 'days is a whole number of days (1 or more), or "all".');
    await refuses('/summary?days=0', 'query.days');
    await refuses('/org/summary?days=-7', 'query.days');
});

test('a misspelled filter is refused, not dropped into every agent', async () => {
    await refuses('/?agnet=agent-1', 'query');
});

test('a type the store never writes is refused, not answered with an empty list', async () => {
    const res = await refuses('/?type=timeout', 'query.type');
    assert.strictEqual(res.body.error, 'type is one of: max_tokens, max_iterations, error, aborted.');
});

test('an interval the timeline does not draw is refused, not drawn per day', async () => {
    await refuses('/timeline?interval=hours', 'query.interval');
});

test('a start that is not a date is refused in words, not a 500 from Postgres', async () => {
    const res = await refuses('/org?startDate=yesterday', 'query.startDate');
    assert.match(res.body.error, /^startDate is a date/);
});

// ═══ "All" is all ════════════════════════════════════════════════════

test('no range at all — how both screens ask for "All" — is all time, not the last 30 days', async () => {
    const res = await dispatch('/summary');
    assert.strictEqual(res.statusCode, 200);
    const { filters } = touched.find((t) => t.what === 'getSummary');
    assert.strictEqual(filters.startDate, undefined);
    assert.strictEqual(filters.endDate, undefined);
    assert.strictEqual(filters.organizationId, 'org-1', 'the org scope still applies');
});

test('days=all still means all', async () => {
    const res = await dispatch('/?days=all');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].filters.startDate, undefined);
});

// ═══ What the screens send still narrows ════════════════════════════

test('?days=7 is the last seven days', async () => {
    const res = await dispatch('/by-agent?days=7');
    assert.strictEqual(res.statusCode, 200);
    const { filters } = touched[0];
    const span = new Date(filters.endDate) - new Date(filters.startDate);
    assert.strictEqual(Math.round(span / 86400000), 7);
});

test('the org panel\'s explicit window, interval and page size still arrive', async () => {
    const start = '2026-09-01T00:00:00.000Z';
    const end = '2026-09-22T00:00:00.000Z';
    const tl = await dispatch(`/org/timeline?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&interval=hour`);
    assert.strictEqual(tl.statusCode, 200);
    assert.strictEqual(touched[0].interval, 'hour');
    assert.deepStrictEqual(touched[0].filters, { startDate: start, endDate: end, organizationId: 'org-1' });
    touched.length = 0;
    const list = await dispatch('/org?days=30&limit=200');
    assert.strictEqual(list.statusCode, 200);
    assert.strictEqual(touched[0].limit, 200);
});

test('a caller without a session still hears 401 first, whatever the query says', async () => {
    const res = await dispatch('/?days=week', null);
    assert.strictEqual(res.statusCode, 401);
    const org = await dispatch('/org?days=week', null);
    assert.strictEqual(org.statusCode, 401);
    assert.deepStrictEqual(touched, []);
});

// ═══ Who may read the organisation's terminations ═══════════════════

const MEMBER = { isAuthenticated: true, user: { id: 'u2' } };

test('a plain member cannot read the org\'s termination log through the generic routes', async () => {
    for (const url of ['/?days=30', '/summary', '/timeline', '/by-agent']) {
        const res = await dispatch(url, MEMBER);
        assert.strictEqual(res.statusCode, 403, `${url} -> ${JSON.stringify(res.body)}`);
        assert.deepStrictEqual(res.body, { error: "Permission 'admin_monitoring' required" });
    }
    assert.deepStrictEqual(touched, [], 'no colleague\'s row was read');
});

test('the permission is asked before the query is judged', async () => {
    const res = await dispatch('/?days=week', MEMBER);
    assert.strictEqual(res.statusCode, 403);
});

test('a holder of admin_monitoring still reads the list, scoped to their organisation', async () => {
    fx.monitoring.add('u2');
    const res = await dispatch('/?days=30', MEMBER);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].filters.organizationId, 'org-1');
});

test('the org admin\'s own view is unchanged: the org-admin role, not the permission', async () => {
    fx.monitoring = new Set();
    const admin = await dispatch('/org/summary');
    assert.strictEqual(admin.statusCode, 200, 'an org admin without admin_monitoring still has /org');
    touched.length = 0;
    const member = await dispatch('/org/summary', MEMBER);
    assert.strictEqual(member.statusCode, 403);
    assert.deepStrictEqual(touched, []);
});

test('an organisation admin of org-1 in an admin group of org-2 reads org-1 only', async () => {
    fx.groups = { u1: ['g-b-admins'] };
    const own = await dispatch('/org/summary');
    assert.strictEqual(own.statusCode, 200);
    assert.strictEqual(touched[0].filters.organizationId, 'org-1');
    assert.deepStrictEqual(own.body.scope, { organizationId: 'org-1', organizationName: 'Org One', allOrganizations: false });

    touched.length = 0;
    const other = await dispatch('/org/summary?orgId=org-2');
    assert.strictEqual(other.statusCode, 403);
    assert.strictEqual(other.body.code, 'org_admin_required');
    assert.deepStrictEqual(touched, [], 'no store read on a refused request');
});

test('a platform admin is not refused on /org: ?orgId, else their own organisation, else 403', async () => {
    const ADMIN = { isAuthenticated: true, isAdmin: true, user: { id: 'op', role: 'admin' } };
    const chosen = await dispatch('/org/summary?orgId=org-2', ADMIN);
    assert.strictEqual(chosen.statusCode, 200);
    assert.strictEqual(touched[0].filters.organizationId, 'org-2');
    assert.strictEqual(chosen.body.scope.organizationName, 'Org Two');

    touched.length = 0;
    const picked = await dispatch('/org', { ...ADMIN, adminSelectedOrgId: 'org-2' });
    assert.strictEqual(picked.statusCode, 200);
    assert.strictEqual(touched[0].filters.organizationId, 'org-1', 'the Access panel\'s session key does not choose');

    touched.length = 0;
    const own = await dispatch('/org/summary', ADMIN);
    assert.strictEqual(own.statusCode, 200);
    assert.strictEqual(touched[0].filters.organizationId, 'org-1', 'nothing chosen: the organisation on their record');

    fx.homeOrg = { op: '' };
    touched.length = 0;
    const none = await dispatch('/org/summary', ADMIN);
    assert.strictEqual(none.statusCode, 403);
    assert.strictEqual(none.body.code, 'no_organisation');
    assert.deepStrictEqual(touched, []);
});

test('the generic summary of a platform admin covers every organisation, and says so', async () => {
    fx.monitoring = new Set(['op']);
    const res = await dispatch('/summary', { isAuthenticated: true, isAdmin: true, user: { id: 'op', role: 'admin' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.scope, { organizationId: null, organizationName: null, allOrganizations: true });
});

test('only /org takes an orgId; the generic routes refuse a filter they would not apply', async () => {
    const res = await dispatch('/summary?orgId=org-1');
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(touched, []);
});

// ═══ The person behind a row ═════════════════════════════════════════

const pseudonym = require('../core/privacy/pseudonym');
const ORG_LABEL = pseudonym.pseudonymFor('u1', 'org-1', process.env.SESSION_SECRET);
const ORG_ID = pseudonym.pseudonymId('u1', 'org-1', process.env.SESSION_SECRET);

test('terminations: rows carry the Adoption pseudonym and no user id by default', async () => {
    fx.rows = [{ id: 't1', user_id: 'u1' }, { id: 't2', user_id: null }];
    const res = dispatch('/org');
    const out = await res;
    assert.strictEqual(out.statusCode, 200);
    const rows = out.body.rows;
    assert.deepStrictEqual(rows[0].person, { id: ORG_ID, name: ORG_LABEL });
    assert.match(rows[0].person.name, /^Member · [A-Z2-9]{4}$/);
    assert.strictEqual(rows[1].person, null, 'an anonymous row stays null');
    assert.ok(rows.every((r) => !('user_id' in r)));
    assert.strictEqual(audit.rows.length, 0, 'no reveal, no audit row');
    assert.ok(!JSON.stringify(out.body).includes('Kim'));
});

test('terminations: reveal=true records the audit row first and names the person', async () => {
    fx.rows = [{ id: 't1', user_id: 'u1' }, { id: 't2', user_id: null }];
    const out = await dispatch('/org?reveal=true');
    assert.strictEqual(out.statusCode, 200);
    assert.strictEqual(audit.rows.length, 1);
    assert.strictEqual(audit.rows[0][1], 'usage_quality_people_revealed');
    assert.strictEqual(audit.rows[0][2], 'org-1');
    const rows = out.body.rows;
    assert.deepStrictEqual(rows[0].person, { id: 'u1', name: 'Kim Jansen' });
    assert.strictEqual(rows[1].person, null);
    assert.ok(rows.every((r) => !('user_id' in r)));
});

test('terminations: a failed audit write answers 503 audit_unavailable and no rows', async () => {
    fx.rows = [{ id: 't1', user_id: 'u1' }, { id: 't2', user_id: null }];
    audit.fail = true;
    const out = await dispatch('/org?reveal=true');
    assert.strictEqual(out.statusCode, 503);
    assert.strictEqual(out.body.code, 'audit_unavailable');
    assert.ok(!JSON.stringify(out.body).includes('Kim'));
});

test('terminations: reveal must be true or false', async () => {
    const out = await dispatch('/org?reveal=yes');
    assert.strictEqual(out.statusCode, 400);
    assert.strictEqual(audit.rows.length, 0);
});

test('terminations: the envelope says whether names are shown', async () => {
    assert.strictEqual((await dispatch('/org')).body.revealed, false);
    assert.strictEqual((await dispatch('/org?reveal=true')).body.revealed, true);
});

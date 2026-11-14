/**
 * Route tests for GET /api/studio/search (routes/studio/search.js).
 *
 * Every dependency is injected through createSearchRouter(deps), so no DB or
 * pool is opened; requests go over real HTTP against express app.listen(0).
 *
 * What is pinned is the CONTRACT, not the data:
 *   - a gated kind is OMITTED and is NOT an error (no entitlement oracle),
 *   - a kind whose store OR gate throws is named in `errors` and the answer
 *     is still 200 — the one thing this endpoint exists for: a list that came
 *     out of a failure must never read as "no matches",
 *   - a kind that searched and matched nothing is an EMPTY ARRAY, so the two
 *     empty answers are different shapes,
 *   - a query under two characters touches no store at all,
 *   - the visibility scoping each kind inherits from its list route reaches
 *     the store the way that route passes it,
 *   - LIKE wildcards in the query are escaped,
 *   - and the transcriptions predicate is PARENTHESISED before the name
 *     filter is ANDed onto it (without the brackets the AND would bind to the
 *     last OR branch and the first two branches would return the whole table).
 *
 * The three raw-SQL kinds (automations, agents, meeting notes) run on a real
 * Postgres: the boot ladder's schema on PGlite, handed in as the db dependency.
 *
 * Run: node --test routes/studio/search.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    createSearchRouter, KIND_KEYS, MAX_PER_KIND, MIN_QUERY_LENGTH, MAX_QUERY_LENGTH, escapeLike, nameOf,
} = require('./search');
const { studioApp, studioServer } = require('./studioServer.testkit');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');

// ── A fully-open, fully-populated fake dependency set ───────────────────────
function makeDeps(overrides = {}) {
    const calls = { sql: [] };
    const bump = (name) => { calls[name] = (calls[name] || 0) + 1; };
    const deps = {
        _calls: calls,
        modules: { isModuleActive: async () => true },
        license: { featureAllowedForRequest: async () => ({ allowed: true, resolution: {} }) },
        entitlements: { hasCapability: async () => true },
        permissions: { hasPermission: async () => true },
        auth: {
            resolveUserOrgIds: async () => new Set(['orgA']),
            resolveUserGroups: async () => ['g1'],
        },
        audience: { resolveAudienceContext: async () => ({ userId: 'u1', orgIds: new Set(['orgA']), userGroups: ['g1'] }) },
        datatableAccess: {
            resolveDatatablePrincipal: async () => ({ userId: 'u1', orgId: 'orgA' }),
            datatableScopesFor: () => [{ kind: 'user', id: 'u1' }, { kind: 'org', id: 'orgA' }],
            // 'nogrant' is a table whose NAME matches but on which this
            // principal holds nothing.
            gradeForPrincipal: (t) => (t.id === 'nogrant' ? null : 'reader'),
        },
        automationCore: {
            getAll: async (sql, params) => {
                bump('automations');
                calls.sql.push({ sql, params });
                return [{ id: 'a1', title: 'Invoice reminder' }];
            },
        },
        datatableStore: {
            listDatatablesForScope: async (scope) => (scope.kind === 'user'
                ? [{ id: 't1', name: 'Invoices' }]
                : [{ id: 'nogrant', name: 'Invoices (finance)' }, { id: 't2', name: 'Suppliers' }]),
            listGrantsForTables: async (ids) => { bump('grants'); calls.grantIds = ids; return new Map(ids.map((id) => [id, []])); },
        },
        studioAppStore: { getAccessibleStudioApps: async () => [{ id: 'app1', name: 'Invoice portal' }, { id: 'app2', name: 'Holiday planner' }] },
        webpageStore: { getAccessibleWebpages: async () => [{ id: 'w1', name: 'Invoice help' }, { id: 'w2', name: 'About us' }] },
        skillStore: { getAvailableSkills: async () => [{ id: 's1', name: 'Invoice parsing' }, { id: 's2', name: 'Translate' }] },
        userStore: { getUser: async () => ({ id: 'u1', organizationId: 'orgA' }) },
        kbStore: {
            listKBs: async () => [{ id: 'kb1', name: 'Invoice archive' }, { id: 'kbx', name: 'Invoice secrets' }, { id: 'kb2', name: 'Handbook' }],
            // The group filter removes a base whose name matches — the check
            // that org scoping alone is not the visibility answer.
            filterByGroupAccess: (kbs) => kbs.filter((kb) => kb.id !== 'kbx'),
        },
        kbShared: {
            resolveAdminOrgIds: async () => new Set(),
            resolveEnabledSystemSlugs: async () => [],
            listFilterFromQuery: () => ({ sourceKind: 'manual' }),
            resolveUserGroups: async () => ['g1'],
        },
        transcriptionsShared: { resolveAccessContext: async () => ({ orgIds: ['orgA'], userGroupIds: ['g1'], isSuperAdmin: false }) },
        db: {
            getAll: async (sql, params) => {
                calls.sql.push({ sql, params });
                if (/FROM agents/.test(sql)) { bump('agents'); return [{ id: 'ag1', name: 'Invoice bot' }]; }
                bump('meetingNotes');
                return [{ id: 'm1', title: 'Invoice call', file_name: 'call.m4a' }];
            },
        },
        projectStore: { listUserProjects: async () => [{ id: 'pr1', name: 'Invoice rollout' }, { id: 'pr2', name: 'Onboarding' }] },
        configStore: { getConfig: async () => null },
    };
    return Object.assign(deps, overrides);
}

// ── Server harness ──────────────────────────────────────────────────────────
let deps;
const mount = (nextDeps) => studioApp(createSearchRouter(deps = nextDeps), { errors: true });
const srv = studioServer(test);
const listen = srv.listen;

const get = (q = 'invoice', user = 'u1') => fetch(
    `${srv.baseUrl}/api/studio/search?q=${encodeURIComponent(q)}`,
    { headers: user ? { 'x-test-user': user } : {} },
);


// ── The happy path ──────────────────────────────────────────────────────────

test('searches every kind with its list route\'s scoping when everything is open', async () => {
    await listen(mount(makeDeps()));
    const res = await get('invoice');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.query, 'invoice');
    assert.strictEqual(body.tooShort, false);
    assert.deepStrictEqual(body.errors, []);
    assert.deepStrictEqual(Object.keys(body.results).sort(), [...KIND_KEYS].sort());
    assert.deepStrictEqual(body.results.automations, [{ id: 'a1', name: 'Invoice reminder' }]);
    assert.deepStrictEqual(body.results.apps, [{ id: 'app1', name: 'Invoice portal' }]);
    assert.deepStrictEqual(body.results.webpages, [{ id: 'w1', name: 'Invoice help' }]);
    assert.deepStrictEqual(body.results.skills, [{ id: 's1', name: 'Invoice parsing' }]);
    assert.deepStrictEqual(body.results.solutions, [{ id: 'pr1', name: 'Invoice rollout' }]);
    assert.deepStrictEqual(body.results.agents, [{ id: 'ag1', name: 'Invoice bot' }]);
    // A transcript with no title falls back to its file name (nameOf).
    assert.deepStrictEqual(body.results.meetingNotes, [{ id: 'm1', name: 'Invoice call' }]);
});

test('the per-kind visibility filters run — a name match you may not see is not a hit', async () => {
    await listen(mount(makeDeps()));
    const body = await (await get('invoice')).json();
    // Datatables: 'nogrant' matches the name but the principal holds no grade.
    assert.deepStrictEqual(body.results.datatables, [{ id: 't1', name: 'Invoices' }]);
    // Grants are only read for the rows whose name matched.
    assert.deepStrictEqual(deps._calls.grantIds, ['t1', 'nogrant']);
    // Knowledge: filterByGroupAccess removes a matching base.
    assert.deepStrictEqual(body.results.knowledge, [{ id: 'kb1', name: 'Invoice archive' }]);
});

test('a kind that matches nothing is an EMPTY ARRAY, not an omission', async () => {
    await listen(mount(makeDeps()));
    const body = await (await get('zzzz')).json();
    // Every kind still answered; they just found nothing. The in-memory kinds
    // prove it directly (the two SQL kinds are faked and always return a row).
    assert.deepStrictEqual(body.results.apps, []);
    assert.deepStrictEqual(body.results.skills, []);
    assert.deepStrictEqual(body.results.datatables, []);
    assert.deepStrictEqual(body.results.knowledge, []);
    assert.deepStrictEqual(body.results.solutions, []);
    assert.deepStrictEqual(body.errors, []);
    assert.ok('apps' in body.results, 'searched-and-empty must be present, or it reads as gated');
});

// ── Refusal paths ───────────────────────────────────────────────────────────

test('an unauthenticated request is refused before any store is touched', async () => {
    await listen(mount(makeDeps()));
    const res = await fetch(`${srv.baseUrl}/api/studio/search?q=invoice`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(deps._calls.sql.length, 0);
    assert.strictEqual(deps._calls.apps, undefined);
});

test('a gated kind is OMITTED, never 403, and is not reported as an error', async () => {
    // Community-shaped org: no licence, no capabilities, no manage_agents.
    await listen(mount(makeDeps({
        license: { featureAllowedForRequest: async () => ({ allowed: false }) },
        entitlements: { hasCapability: async () => false },
        permissions: { hasPermission: async () => false },
    })));
    const res = await get('invoice');
    assert.strictEqual(res.status, 200, 'a whole-response 403 would be an entitlement oracle');
    const body = await res.json();
    // Knowledge is the one ungated kind (Community).
    assert.deepStrictEqual(Object.keys(body.results), ['knowledge']);
    assert.deepStrictEqual(body.errors, [], 'gated is not failed');
});

test('an inactive module drops its kinds and nothing else', async () => {
    await listen(mount(makeDeps({
        modules: { isModuleActive: async (id) => id !== 'automation' },
    })));
    const body = await (await get('invoice')).json();
    assert.ok(!('automations' in body.results));
    assert.ok(!('datatables' in body.results));
    assert.ok('apps' in body.results);
    assert.deepStrictEqual(body.errors, []);
});

test('the operator kill switch closes Solutions', async () => {
    await listen(mount(makeDeps({ configStore: { getConfig: async () => false } })));
    const body = await (await get('invoice')).json();
    assert.ok(!('solutions' in body.results));
    assert.deepStrictEqual(body.errors, []);
});

// ── The fail-open guard ─────────────────────────────────────────────────────

test('a kind whose store throws is NAMED in errors, not silently dropped', async () => {
    await listen(mount(makeDeps({
        skillStore: { getAvailableSkills: async () => { throw new Error('pool exhausted'); } },
        studioAppStore: { getAccessibleStudioApps: async () => { throw new Error('down'); } },
    })));
    const res = await get('invoice');
    assert.strictEqual(res.status, 200, 'one bad store drops one kind, never the response');
    const body = await res.json();
    assert.deepStrictEqual(body.errors, ['apps', 'skills']);
    assert.ok(!('skills' in body.results), 'a failed kind carries no list');
    assert.ok(!('apps' in body.results));
    // The rest of the answer is intact — that is why the drop is per kind.
    assert.deepStrictEqual(body.results.webpages, [{ id: 'w1', name: 'Invoice help' }]);
});

test('a GATE that throws closes the kind AND says so — a gate that cannot answer is not an open door', async () => {
    await listen(mount(makeDeps({
        entitlements: { hasCapability: async () => { throw new Error('entitlements unreachable'); } },
    })));
    const body = await (await get('invoice')).json();
    // Every capability-gated kind is out, and each is reported.
    assert.deepStrictEqual(body.errors, ['apps', 'meetingNotes', 'skills', 'solutions', 'webpages']);
    for (const key of body.errors) assert.ok(!(key in body.results), `${key} must not carry a list`);
    // The kinds that do not ask about capabilities still answered.
    assert.ok('knowledge' in body.results);
    assert.ok('agents' in body.results);
});

test('when EVERY kind fails the answer is an explicit failure list, never a silent empty set', async () => {
    // The worst shape this endpoint can produce: `results: {}`. It is also
    // what a Community org legitimately gets for most kinds, so the ONLY
    // thing separating "nothing to find" from "we could not look" is
    // `errors`. If a total outage came back with an empty `errors`, every
    // search would read as "no matches" for as long as the outage lasted.
    const broken = makeDeps();
    // Every gate dependency down, plus the one knowledge asks for during its
    // search (its gate is unconditional — Knowledge is Community).
    for (const name of ['modules', 'permissions', 'entitlements', 'license', 'auth']) {
        Object.defineProperty(broken, name, { get() { throw new Error('boom'); } });
    }
    await listen(mount(broken));
    const res = await get('invoice');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.results, {});
    assert.deepStrictEqual(body.errors, [...KIND_KEYS].sort(), 'every dropped kind is named');
    assert.notDeepStrictEqual(body.errors, [], 'an empty errors list here would be the fail-open');
});

// ── The cheap path ──────────────────────────────────────────────────────────

test('a query under two characters touches no store at all', async () => {
    await listen(mount(makeDeps()));
    for (const q of ['', ' ', 'a', '   ']) {
        const res = await get(q);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.tooShort, true, `q=${JSON.stringify(q)}`);
        assert.deepStrictEqual(body.results, {});
        assert.deepStrictEqual(body.errors, []);
    }
    assert.strictEqual(deps._calls.sql.length, 0);
    assert.strictEqual(deps._calls.apps, undefined);
    assert.strictEqual(MIN_QUERY_LENGTH, 2);
});

test('a missing q parameter is the same cheap path, not a crash', async () => {
    await listen(mount(makeDeps()));
    const res = await fetch(`${srv.baseUrl}/api/studio/search`, { headers: { 'x-test-user': 'u1' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).tooShort, true);
    // An array-shaped q (?q=a&q=b) is not a string and must not reach a store.
    // It used to be answered 200 `tooShort` — "keep typing" to somebody who
    // had typed; the schema now refuses it by name.
    const res2 = await fetch(`${srv.baseUrl}/api/studio/search?q=aa&q=bb`, { headers: { 'x-test-user': 'u1' } });
    assert.strictEqual(res2.status, 400);
    assert.ok((await res2.json()).details.some((d) => d.path === 'query.q'));
    assert.strictEqual(deps._calls.sql.length, 0);
});

// ── Query handling ──────────────────────────────────────────────────────────

// ── The raw-SQL kinds, on a real Postgres ───────────────────────────────────
// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js), handed in
// as `db` and `automationCore`; the statements are recorded so "no query" is a fact.

const pg = ladderPglite();
test.after(() => pg.close());
const sqlSeen = [];
const realGetAll = async (sql, params) => { sqlSeen.push(sql); return (await pg.query(sql, params)).rows; };
const realDeps = (over = {}) => makeDeps({ db: { getAll: realGetAll }, automationCore: { getAll: realGetAll }, ...over });
async function resetTables() {
    await pg.exec('TRUNCATE automations, agents, transcriptions CASCADE');
    sqlSeen.length = 0;
}
let seq = 0;
const automation = (title, over = {}) => insertRow(pg, 'automations', { id: `au${++seq}`, user_id: 'u1', title, definition_json: {}, ...over });
const transcription = (title, over = {}) => insertRow(pg, 'transcriptions', { id: `t${++seq}`, user_id: 'u9', title, shared_with: [], is_published: false, shared_groups: [], ...over });
const agentRow = (name, over = {}) => insertRow(pg, 'agents', { id: `ag${++seq}`, name, owner_id: 'u1', ...over });
const ids = (rows) => rows.map((r) => r.id).sort();

test('LIKE wildcards in the query are escaped, so "100%" searches for "100%"', async () => {
    assert.strictEqual(escapeLike('100%'), '100\\%');
    assert.strictEqual(escapeLike('a_b'), 'a\\_b');
    assert.strictEqual(escapeLike('c:\\x'), 'c:\\\\x');
    await resetTables();
    const hit = await automation('Done 100% of it');
    await automation('Done 1000 times');
    await automation('A_B plan');
    const theirs = await automation('100% theirs', { user_id: 'u2' });
    await listen(mount(realDeps()));
    const body = await (await get('100%')).json();
    assert.deepStrictEqual(ids(body.results.automations), [hit.id], 'the % is a character, and another user\'s automation is not searched');
    assert.ok(theirs);
    assert.deepStrictEqual((await (await get('a_b')).json()).results.automations.map((r) => r.name), ['A_B plan']);
});

test('an over-long query is truncated rather than sent on', async () => {
    await resetTables();
    const exact = await automation('x'.repeat(MAX_QUERY_LENGTH));
    await listen(mount(realDeps()));
    const body = await (await get('x'.repeat(MAX_QUERY_LENGTH + 50))).json();
    assert.strictEqual(body.query.length, MAX_QUERY_LENGTH);
    assert.deepStrictEqual(ids(body.results.automations), [exact.id], 'the truncated query is what was searched');
});

test('results are capped per kind, prefix matches first', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, name: `Zeta invoice ${i}` }));
    many.push({ id: 'first', name: 'Invoice first' });
    await listen(mount(makeDeps({ skillStore: { getAvailableSkills: async () => many } })));
    const body = await (await get('invoice')).json();
    assert.strictEqual(body.results.skills.length, MAX_PER_KIND);
    assert.strictEqual(body.results.skills[0].id, 'first', 'a name that STARTS with the query ranks first');
});

test('the transcriptions visibility predicate is bracketed before the name filter is ANDed on', async () => {
    // The visibility clauses are ORed INSIDE brackets. Without them the
    // trailing AND binds to the last branch only and the first branches return
    // every row the caller may see, whatever its name.
    await resetTables();
    const own = await transcription('Invoice call', { user_id: 'u1' });
    await transcription('Weekly sync', { user_id: 'u1' });
    const shared = await transcription('Invoice review', { shared_with: ['u1'] });
    await transcription('Other review', { shared_with: ['u1'] });
    const org = await transcription('Invoice org', { is_published: true, organization_id: 'orgA', shared_groups: ['g1'] });
    await transcription('Invoice other group', { is_published: true, organization_id: 'orgA', shared_groups: ['g2'] });
    await transcription('Invoice other org', { is_published: true, organization_id: 'orgB' });
    const byFile = await transcription('', { user_id: 'u1', file_name: 'invoice-call.m4a' });
    await listen(mount(realDeps()));
    const body = await (await get('invoice')).json();
    assert.deepStrictEqual(ids(body.results.meetingNotes), ids([own, shared, org, byFile]));
});

test('a super admin searches every transcription by name', async () => {
    await resetTables();
    const a = await transcription('Invoice A', { organization_id: 'orgA' });
    const b = await transcription('Invoice B', { organization_id: 'orgZ' });
    await transcription('Unrelated');
    await listen(mount(realDeps({
        transcriptionsShared: { resolveAccessContext: async () => ({ orgIds: [], userGroupIds: [], isSuperAdmin: true }) },
    })));
    const body = await (await get('invoice')).json();
    assert.deepStrictEqual(ids(body.results.meetingNotes), ids([a, b]));
});

test('the agents search is narrowed to the caller\'s orgs, without system or swarm agents', async () => {
    await resetTables();
    const mine = await agentRow('Invoice bot', { organization_id: 'orgA' });
    await agentRow('Invoice bot B', { organization_id: 'orgB' });
    await agentRow('Invoice system', { organization_id: 'orgA', owner_id: 'system' });
    await agentRow('Invoice swarm', { organization_id: 'orgA', owner_id: 'swarm' });
    await agentRow('Holiday bot', { organization_id: 'orgA' });
    await listen(mount(realDeps()));
    const body = await (await get('invoice')).json();
    assert.deepStrictEqual(ids(body.results.agents), [mine.id]);
});

test('a super admin searches agents without an org filter; a member of no org searches nothing', async () => {
    await resetTables();
    const a = await agentRow('Invoice A', { organization_id: 'orgA' });
    const b = await agentRow('Invoice B', { organization_id: 'orgB' });
    await agentRow('Invoice system', { owner_id: 'system' });
    await listen(mount(realDeps({
        auth: { resolveUserOrgIds: async () => null, resolveUserGroups: async () => [] },
    })));
    assert.deepStrictEqual(ids((await (await get('invoice')).json()).results.agents), ids([a, b]));

    sqlSeen.length = 0;
    await listen(mount(realDeps({
        auth: { resolveUserOrgIds: async () => new Set(), resolveUserGroups: async () => [] },
    })));
    const body = await (await get('invoice')).json();
    assert.deepStrictEqual(body.results.agents, [], 'no org = no agents, and no query either');
    assert.strictEqual(sqlSeen.filter((q) => q.includes('agents')).length, 0);
});

// ── Response hygiene ────────────────────────────────────────────────────────

test('the answer is never cached by the browser', async () => {
    await listen(mount(makeDeps()));
    const res = await get('invoice');
    assert.strictEqual(res.headers.get('cache-control'), 'private, no-store');
});

test('nameOf reads whatever the store called the name, and never returns non-strings', async () => {
    assert.strictEqual(nameOf({ name: 'A' }), 'A');
    assert.strictEqual(nameOf({ title: 'B' }), 'B');
    assert.strictEqual(nameOf({ file_name: 'c.m4a' }), 'c.m4a');
    assert.strictEqual(nameOf({ fileName: 'd.m4a' }), 'd.m4a');
    assert.strictEqual(nameOf({ name: 42 }), '');
    assert.strictEqual(nameOf(null), '');
});

test('solutions searches Solutions and unclassified legacy projects, never a collaborative project', async () => {
    let asked = null;
    await listen(mount(makeDeps({
        projectStore: {
            listUserProjects: async (userId, groupIds, opts) => {
                asked = opts;
                return [{ id: 'pr1', name: 'Invoice rollout' }];
            },
        },
    })));
    const body = await (await get()).json();
    assert.deepStrictEqual(asked, { kind: 'solution' });
    assert.deepStrictEqual(body.results.solutions, [{ id: 'pr1', name: 'Invoice rollout' }]);
});

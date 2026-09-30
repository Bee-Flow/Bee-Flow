/**
 * Route tests for GET /api/studio/counts (routes/studio/counts.js).
 *
 * Every dependency is injected through createCountsRouter(deps), so no DB or
 * pool is opened; requests go over real HTTP against express app.listen(0).
 * What is pinned is the CONTRACT, not the SQL: a gated key is omitted rather
 * than 403'd, a failing store drops one number rather than the response (and
 * that partial body is not cached), scoping arguments reach the stores the
 * way the list routes pass them — the org filter of the agents COUNT and its
 * super-admin no-filter path included — makers is the distinct-owner count
 * across kinds, the 60s cache, and the no-store response header.
 *
 * Run: node --test --test-force-exit routes/studio/counts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { createCountsRouter, KIND_KEYS, CACHE_TTL_MS, ownerOf } = require('./counts');

const USER = { id: 'u1', organizationId: 'orgA' };

// ── A fully-open, fully-populated fake dependency set ───────────────────────
function makeDeps(overrides = {}) {
    const calls = {};
    const rec = (name) => { calls[name] = (calls[name] || 0) + 1; };
    let clock = 1_000_000;
    const deps = {
        now: () => clock,
        _tick: (ms) => { clock += ms; },
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
            gradeForPrincipal: (t) => (t.id === 'hidden' ? null : 'reader'),
        },
        automationCore: { getOne: async () => { rec('automations'); return { n: 9 }; } },
        automationStore: {
            // Studio → Runs & log counts the CALLER's runs in a 24h window.
            getRunCountForUserSince: async (userId, sinceTs) => { rec('runs'); return { userId, sinceTs, n: 12 }.n; },
            listFormPagesForOrg: async () => [
                // Two pages for the same form: the busiest wins, counted once.
                { id: 'p1', automationId: 'a1', triggerStepId: 'trg', submissions: 2, userId: 'u1', definition: { trigger: { id: 'trg', kind: 'form' } } },
                { id: 'p2', automationId: 'a1', triggerStepId: 'trg', submissions: 9, userId: 'u1', definition: { trigger: { id: 'trg', kind: 'form' } } },
                // A page whose trigger is no longer a form is dropped.
                { id: 'p3', automationId: 'a2', triggerStepId: null, submissions: 0, userId: 'u2', definition: { trigger: { id: 'trg', kind: 'manual' } } },
                // A secondary trigger that is a form.
                { id: 'p4', automationId: 'a3', triggerStepId: 't2', submissions: 0, userId: 'u3', definition: { trigger: { id: 'trg', kind: 'manual' }, triggers: [{ id: 't2', kind: 'form' }] } },
            ],
        },
        datatableStore: {
            listDatatablesForScope: async (scope) => (scope.kind === 'user'
                ? [{ id: 't1', ownerUserId: 'u1' }]
                : [{ id: 't2', ownerUserId: 'u2' }, { id: 'hidden', ownerUserId: 'u9' }]),
            listGrantsForTables: async (ids) => new Map(ids.map(id => [id, []])),
        },
        studioAppStore: { getAccessibleStudioApps: async () => [{ id: 'app1', userId: 'u1' }, { id: 'app2', userId: 'u4' }, { id: 'app3', userId: 'u4' }, { id: 'app4', userId: 'u5' }] },
        playbookStore: { listPlaybooksForUser: async (uid) => (uid ? [{ id: 'pb1', userId: uid }, { id: 'pb2', userId: uid }] : []) },
        webpageStore: { getAccessibleWebpages: async () => [{ id: 'w1', userId: 'u1' }, { id: 'w2', userId: 'u2' }] },
        skillStore: { getAvailableSkills: async () => Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, userId: 'u1' })) },
        userStore: { getUser: async () => ({ id: 'u1', organizationId: 'orgA' }) },
        kbStore: {
            listKBs: async () => [{ id: 'kb1', tenant_id: 'u1' }, { id: 'kb2', tenant_id: 'u7' }, { id: 'kb3', tenant_id: 'u7' }, { id: 'kbx', tenant_id: 'u8' }],
            filterByGroupAccess: (kbs) => kbs.filter(kb => kb.id !== 'kbx'),
        },
        kbShared: {
            resolveIsOrgAdmin: async () => false,
            resolveEnabledSystemSlugs: async () => [],
            listFilterFromQuery: () => ({ sourceKind: 'manual', usageContext: null, excludeContext: null }),
            resolveUserGroups: async () => ['g1'],
        },
        transcriptionsShared: { resolveAccessContext: async () => ({ orgIds: ['orgA'], userGroupIds: ['g1'], isSuperAdmin: false }) },
        // Two kinds share the core-DB pool: the agents COUNT (org-scoped in
        // the WHERE) and the transcriptions COUNT. Dispatch on the table.
        db: { getOne: async (sql) => (/FROM agents/.test(sql)
            ? { n: 2, owners: ['u1', 'u6'] }
            : { n: 13, owners: ['u1', 'u10'] }) },
        projectStore: { listUserProjects: async () => [{ id: 'pr1', ownerId: 'u1' }, { id: 'pr2', ownerId: 'u11' }, { id: 'pr3', ownerId: 'u11' }] },
        configStore: { getConfig: async () => null },
    };
    return Object.assign(deps, overrides);
}

// ── Server harness ──────────────────────────────────────────────────────────
let server;
let baseUrl;
let deps;

function mount(nextDeps) {
    deps = nextDeps;
    const app = express();
    // The real mount sits behind requireAuth; here a header stands in for the
    // session so an unauthenticated request can be exercised too.
    app.use((req, _res, next) => {
        const who = req.headers['x-test-user'];
        req.session = who ? { isAuthenticated: true, user: { ...USER, id: who } } : {};
        next();
    });
    app.use('/api/studio', createCountsRouter(deps));
    return app;
}

async function listen(app) {
    if (server) await new Promise((resolve) => server.close(resolve));
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
});

const get = (user = 'u1') => fetch(`${baseUrl}/api/studio/counts`, { headers: user ? { 'x-test-user': user } : {} });

test('every kind is counted with its list route\'s scoping when everything is open', async () => {
    await listen(mount(makeDeps()));
    const res = await get();
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(Object.keys(body.counts).sort(), [...KIND_KEYS].sort());
    assert.deepStrictEqual(body.counts, {
        automations: 9,
        runs: 12,        // events in a window, not things — see the KINDS entry
        forms: 2,        // a1 once (busiest page), a3 via its secondary trigger; a2 dropped
        datatables: 2,   // t1 + t2; 'hidden' has no grade
        apps: 4,
        playbooks: 2,    // the caller's own; the owner is the caller (u1, already a maker)
        webpages: 2,
        agents: 2,       // the COUNT's WHERE carries the org filter
        skills: 7,
        knowledge: 3,    // kbx removed by filterByGroupAccess
        meetingNotes: 13,
        solutions: 3,
    });
    // Distinct owners across kinds: u1, u3 (form), u2 (table/webpage), u4, u5
    // (apps), u6 (agent), u7 (kb), u10 (meeting), u11 (solution).
    assert.strictEqual(body.makers, 9);
});

test('runs counts the CALLER\'s own runs over a 24-hour window, and adds no makers', async () => {
    // The one key that counts events rather than things (Track H2). Two things
    // are pinned because both would be invisible if they broke: the window the
    // rail's number stands for, and the fact that it is scoped to the caller —
    // the section it labels opens on "my runs", and a rail number counted over
    // a wider set than the list it labels is exactly what this file's rule 2
    // exists to prevent.
    let seen = null;
    const d = makeDeps();
    d.automationStore.getRunCountForUserSince = async (userId, sinceTs) => { seen = { userId, sinceTs }; return 4; };
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.runs, 4);
    assert.strictEqual(seen.userId, 'u1');
    const hours = (d.now() - Date.parse(seen.sinceTs)) / 3_600_000;
    assert.ok(Math.abs(hours - 24) < 0.01, `expected a 24h window, got ${hours}h`);
    // makers is unchanged by the runs key: a run is not a maker.
    assert.strictEqual(body.makers, 9);
});

test('a runs count that cannot be read drops that ONE number, not the response', async () => {
    const d = makeDeps();
    d.automationStore.getRunCountForUserSince = async () => { throw new Error('runs table unreachable'); };
    await listen(mount(d));
    const res = await get();
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    // Omitted, never 0. The client reads an absent key as "not known" and
    // draws no number at all (hooks/useStudioCounts.js countFor).
    assert.ok(!('runs' in body.counts), 'a failed read must not become a zero');
    assert.strictEqual(body.counts.automations, 9, 'the other numbers survive');
});

test('the transcriptions COUNT uses the store\'s predicate and the KB count the route\'s default filter', async () => {
    let seen = null;
    let kbArgs = null;
    const d = makeDeps({
        db: { getOne: async (sql, params) => { if (/FROM transcriptions/.test(sql)) seen = { sql, params }; return { n: 1, owners: ['u1'] }; } },
    });
    d.kbStore.listKBs = async (userId, orgIds, opts) => { kbArgs = { userId, orgIds, opts }; return []; };
    await listen(mount(d));
    await get();
    assert.match(seen.sql, /COUNT\(\*\)/);
    assert.match(seen.sql, /user_id = \$1 OR shared_with @> \$2::jsonb OR \(is_published = true AND organization_id = ANY\(\$3::text\[\]\) AND \(shared_groups = '\[\]'::jsonb OR shared_groups \?\| \$4::text\[\]\)\)/);
    assert.deepStrictEqual(seen.params, ['u1', JSON.stringify(['u1']), ['orgA'], ['g1']]);
    assert.strictEqual(kbArgs.userId, 'u1');
    assert.deepStrictEqual(kbArgs.opts, { sourceKind: 'manual', usageContext: null, excludeContext: null, systemSlugs: [], isOrgAdmin: false });
});

test('a super admin counts every transcription', async () => {
    let seen = null;
    const d = makeDeps({
        transcriptionsShared: { resolveAccessContext: async () => ({ orgIds: [], userGroupIds: [], isSuperAdmin: true }) },
        db: { getOne: async (sql, params) => { if (/FROM transcriptions/.test(sql)) seen = { sql, params }; return { n: 400, owners: [] }; } },
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.meetingNotes, 400);
    assert.doesNotMatch(seen.sql, /WHERE/);
    assert.deepStrictEqual(seen.params, []);
});

test('agents are COUNTed in SQL with the /all predicate and the caller\'s orgs in the WHERE', async () => {
    // The old shape loaded every agent row in the database (all orgs, config
    // and tools) and filtered in JS — on every 30s poll of every
    // manage_agents user. The count must be ONE org-scoped query.
    let seen = null;
    const d = makeDeps({
        auth: { resolveUserOrgIds: async () => new Set(['orgA', 'orgC']), resolveUserGroups: async () => ['g1'] },
        db: { getOne: async (sql, params) => {
            if (/FROM agents/.test(sql)) { seen = { sql, params }; return { n: 5, owners: ['u1', 'u6', 'u6'] }; }
            return { n: 0, owners: [] };
        } },
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.agents, 5);
    assert.match(seen.sql, /COUNT\(\*\)/);
    assert.match(seen.sql, /array_agg\(DISTINCT owner_id\)/, 'makers come from the same query');
    assert.match(seen.sql, /owner_id NOT IN \('system', 'swarm'\)/, 'the getAllAgents predicate');
    assert.match(seen.sql, /organization_id = ANY\(\$1::text\[\]\)/);
    assert.deepStrictEqual(seen.params, [['orgA', 'orgC']]);
    // u6 counted once as a maker, alongside u1 and the other kinds' owners.
    assert.strictEqual(body.makers, 8);
});

test('a super admin (resolveUserOrgIds → null) counts agents with no org filter', async () => {
    let seen = null;
    const d = makeDeps({
        auth: { resolveUserOrgIds: async () => null, resolveUserGroups: async () => ['g1'] },
        db: { getOne: async (sql, params) => {
            if (/FROM agents/.test(sql)) { seen = { sql, params }; return { n: 250, owners: [] }; }
            return { n: 0, owners: [] };
        } },
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.agents, 250);
    assert.doesNotMatch(seen.sql, /organization_id/);
    assert.match(seen.sql, /owner_id NOT IN \('system', 'swarm'\)/, 'system and swarm rows stay out even for a super admin');
    assert.deepStrictEqual(seen.params, []);
});

test('a member of no organisation gets agents 0 without a query — as /all shows nothing', async () => {
    let queried = false;
    const d = makeDeps({
        auth: { resolveUserOrgIds: async () => new Set(), resolveUserGroups: async () => ['g1'] },
        db: { getOne: async (sql) => { if (/FROM agents/.test(sql)) queried = true; return { n: 0, owners: [] }; } },
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.agents, 0);
    assert.strictEqual(queried, false);
});

test('a key the caller may not see is OMITTED — never a 403 for the whole response', async () => {
    const d = makeDeps({
        // No licence for automations → automations, forms, datatables go.
        license: { featureAllowedForRequest: async (_req, feature) => ({ allowed: feature !== 'automations' }) },
        // No app_studio / meeting_notes capability; skills and projects stay.
        entitlements: { hasCapability: async (cap) => !['app_studio', 'meeting_notes'].includes(cap) },
        // No manage_agents.
        permissions: { hasPermission: async () => false },
        // Webpages module removed by the operator.
        modules: { isModuleActive: async (id) => id !== 'webpages' },
    });
    await listen(mount(d));
    const res = await get();
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(Object.keys(body.counts).sort(), ['knowledge', 'skills', 'solutions']);
    for (const k of ['automations', 'forms', 'datatables', 'apps', 'webpages', 'agents', 'meetingNotes']) {
        assert.ok(!(k in body.counts), `${k} must be absent, not null or 0`);
    }
    // makers only counts what was counted: u1 (skills/kb/solution), u7, u11.
    assert.strictEqual(body.makers, 3);
});

test('the operator kill switch (feature_projects_enabled=false) hides solutions', async () => {
    const d = makeDeps({ configStore: { getConfig: async (k) => (k === 'feature_projects_enabled' ? false : null) } });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.ok(!('solutions' in body.counts));
    assert.strictEqual(body.counts.skills, 7);
});

test('one failing store drops one number, never the response — and the partial body is NOT cached', async () => {
    let down = true;
    const d = makeDeps({
        skillStore: { getAvailableSkills: async () => { if (down) throw new Error('skills table locked'); return [{ id: 's1', userId: 'u1' }]; } },
        // A gate that throws is a closed gate — and, like a throwing count,
        // makes the body partial: a permission lookup's bad day must not pin
        // "no agents for you" for a cache window either.
        permissions: { hasPermission: async () => { if (down) throw new Error('perm lookup down'); return true; } },
    });
    const origWarn = console.warn;
    const warned = [];
    console.warn = (...args) => warned.push(args.join(' '));
    try {
        await listen(mount(d));
        const res = await get();
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.ok(!('skills' in body.counts));
        assert.ok(!('agents' in body.counts));
        assert.strictEqual(body.counts.automations, 9);
        assert.strictEqual(body.counts.knowledge, 3);
        assert.ok(warned.some(w => w.includes('skills failed')));
        // An absent key is what the client reads as "gated"; a transient
        // store error must not pin that reading for a cache window. The
        // `partial` flag itself stays server-side.
        assert.ok(!('partial' in body), 'partial is not sent to the client');
        assert.strictEqual(d._calls.automations, 1);
        down = false;
        const body2 = await (await get()).json();
        assert.strictEqual(d._calls.automations, 2, 'the partial body was not served from cache');
        assert.strictEqual(body2.counts.skills, 1, 'the recovered store is counted on the very next poll');
        assert.strictEqual(body2.counts.agents, 2, 'the recovered gate is open on the very next poll');
        // A full body IS cached.
        await get();
        assert.strictEqual(d._calls.automations, 2);
    } finally {
        console.warn = origWarn;
    }
});

test('Cache-Control is private, no-store on a fresh AND a cached response', async () => {
    // The 60s server cache is the only cache. A browser max-age stacked on top
    // let the visibilitychange catch-up fetch be answered stale.
    await listen(mount(makeDeps()));
    const fresh = await get();
    assert.strictEqual(fresh.headers.get('cache-control'), 'private, no-store');
    const cached = await get();
    assert.strictEqual(cached.headers.get('cache-control'), 'private, no-store');
    assert.strictEqual(deps._calls.automations, 1, 'second response came from the server cache');
});

test('a NULL org principal still counts forms (personal install) and an orgless skills user', async () => {
    let formsArgs = null;
    let skillsArgs = null;
    const d = makeDeps({
        datatableAccess: {
            resolveDatatablePrincipal: async () => ({ userId: 'u1', orgId: null }),
            datatableScopesFor: () => [{ kind: 'user', id: 'u1' }],
            gradeForPrincipal: () => 'owner',
        },
        userStore: { getUser: async () => ({ id: 'u1', organizationId: null }) },
    });
    d.automationStore.listFormPagesForOrg = async (orgId, userId) => { formsArgs = { orgId, userId }; return []; };
    d.skillStore.getAvailableSkills = async (orgId, userId) => { skillsArgs = { orgId, userId }; return []; };
    await listen(mount(d));
    const body = await (await get()).json();
    assert.deepStrictEqual(formsArgs, { orgId: null, userId: 'u1' });
    assert.deepStrictEqual(skillsArgs, { orgId: null, userId: 'u1' });
    assert.strictEqual(body.counts.forms, 0);
    assert.strictEqual(body.counts.datatables, 1);
});

test('cached for 60s per (org, user): a second call inside the window hits no store', async () => {
    const d = makeDeps();
    await listen(mount(d));
    await get();
    assert.strictEqual(d._calls.automations, 1);
    await get();
    assert.strictEqual(d._calls.automations, 1, 'second call served from cache');
    // Another user in the same org is another key.
    await get('u2');
    assert.strictEqual(d._calls.automations, 2);
    // Past the TTL the first user is recounted.
    d._tick(CACHE_TTL_MS + 1);
    await get();
    assert.strictEqual(d._calls.automations, 3);
});

test('401 without a session — the handler does not rely on the mount alone', async () => {
    await listen(mount(makeDeps()));
    const res = await get(null);
    assert.strictEqual(res.status, 401);
});

test('ownerOf reads whatever the store called the owner column', () => {
    assert.strictEqual(ownerOf({ ownerUserId: 'a' }), 'a');
    assert.strictEqual(ownerOf({ ownerId: 'b' }), 'b');
    assert.strictEqual(ownerOf({ owner_id: 'c' }), 'c');
    assert.strictEqual(ownerOf({ userId: 'd' }), 'd');
    assert.strictEqual(ownerOf({ user_id: 'e' }), 'e');
    assert.strictEqual(ownerOf({ tenant_id: 'f' }), 'f');
    assert.strictEqual(ownerOf({ id: 'g' }), null);
    assert.strictEqual(ownerOf(null), null);
});

test('a PARTIAL body carries no makers figure at all — 0 would be a claim about the workplace', async () => {
    // makers is a SET SIZE over the kinds that answered, so a kind that fell
    // over shrinks it silently. Studio Home turns 0 into "Nothing built here
    // yet", which is a sentence about the organisation; an absent key is the
    // answer this response already uses for "not known".
    const d = makeDeps();
    d.automationStore.getRunCountForUserSince = async () => { throw new Error('runs table unreachable'); };
    await listen(mount(d));
    const b = await (await get()).json();
    assert.ok(!('makers' in b), 'unknown is an ABSENT key here, never a zero');
    assert.ok(!('partial' in b), 'and the flag itself still never ships');
});

test('a whole body still carries makers', async () => {
    await listen(mount(makeDeps()));
    const b = await (await get()).json();
    assert.strictEqual(typeof b.makers, 'number');
});

test('solutions counts Solutions and unclassified legacy projects, never a collaborative project', async () => {
    let asked = null;
    const d = makeDeps({
        projectStore: {
            listUserProjects: async (userId, groupIds, opts) => {
                asked = opts;
                return [{ id: 'pr1', ownerId: 'u1' }];
            },
        },
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.deepStrictEqual(asked, { kind: 'solution' },
        'the store narrows the listing; legacy rows stay on both sides until classified');
    assert.strictEqual(body.counts.solutions, 1);
});

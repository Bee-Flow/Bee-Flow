/**
 * Route tests for GET /api/studio/counts (routes/studio/counts.js).
 *
 * Every dependency is injected through createCountsRouter(deps); requests go
 * over real HTTP against express app.listen(0).
 * The agents COUNT runs on PGlite (see below; the transcriptions COUNT is module meetingNotes', counts.meetingNotes.test.js). What is pinned is the CONTRACT: a gated key is omitted rather
 * than 403'd, a failing store drops one number rather than the response (and
 * that partial body is not cached), scoping arguments reach the stores the
 * way the list routes pass them — the org filter of the agents COUNT and its
 * super-admin no-filter path included — makers is the distinct-owner count
 * across kinds, the 60s cache, and the no-store response header.
 *
 * Run: node --test routes/studio/counts.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { createCountsRouter, KIND_KEYS, CACHE_TTL_MS, ownerOf } = require('./counts');
const { studioApp, studioServer } = require('./studioServer.testkit');
// The fake dependency set and the PGlite fixture, shared with the module half of this file
// (counts.meetingNotes.test.js).
const { makeDeps, countFixture } = require('./counts.testkit');

// ── Server harness ──────────────────────────────────────────────────────────
let deps;
const mount = (nextDeps) => studioApp(createCountsRouter(deps = nextDeps));
const srv = studioServer(test);
const listen = srv.listen;

const get = (user = 'u1') => fetch(`${srv.baseUrl}/api/studio/counts`, { headers: user ? { 'x-test-user': user } : {} });

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

// ── The agents COUNT runs SQL, on a real Postgres ───────────────────────────
// The boot ladder's schema on PGlite (testUtils/pgliteTemplate.js), handed in
// through the `db` dependency; the statements are recorded so "no query" is a fact.

const { sqlSeen, realDb, resetCountTables, agentRow } = countFixture(test, ['agents']);

test('the KB count uses the route\'s default filter', async () => {
    let kbArgs = null;
    const d = makeDeps();
    d.kbStore.listKBs = async (userId, orgIds, opts) => { kbArgs = { userId, orgIds, opts }; return []; };
    await listen(mount(d));
    await (await get()).json();
    assert.strictEqual(kbArgs.userId, 'u1');
    assert.deepStrictEqual(kbArgs.opts, { sourceKind: 'manual', usageContext: null, excludeContext: null, systemSlugs: [], adminOrgIds: new Set() });
});

test('agents are COUNTed in SQL with the /all predicate and the caller\'s orgs', async () => {
    // The count must be ONE org-scoped query, not every agent row in JS.
    await resetCountTables();
    await agentRow('a1', { organization_id: 'orgA', owner_id: 'u1' });
    await agentRow('a2', { organization_id: 'orgA', owner_id: 'u6' });
    await agentRow('a3', { organization_id: 'orgC', owner_id: 'u6' });
    await agentRow('a4', { organization_id: 'orgB', owner_id: 'u12' });
    await agentRow('a5', { organization_id: 'orgA', owner_id: 'system' });
    await agentRow('a6', { organization_id: 'orgA', owner_id: 'swarm' });
    const d = makeDeps({
        auth: { resolveUserOrgIds: async () => new Set(['orgA', 'orgC']), resolveUserGroups: async () => ['g1'] },
        db: realDb,
        // The meeting-notes COUNT is its module's (counts.meetingNotes.test.js): absent here, so
        // the only SQL on this database is the agents COUNT, with or without that module.
        transcriptionsShared: null,
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.agents, 3, 'system and swarm stay out, another org too');
    assert.strictEqual(sqlSeen.filter((q) => q.includes('agents')).length, 1, 'one query');
    // u6 counted once as a maker, alongside u1 and the other kinds' owners.
    assert.strictEqual(body.makers, 8);
});

test('a super admin (resolveUserOrgIds → null) counts agents with no org filter', async () => {
    await resetCountTables();
    await agentRow('a1', { organization_id: 'orgA' });
    await agentRow('a2', { organization_id: 'orgB' });
    await agentRow('a3', { organization_id: null });
    await agentRow('a4', { owner_id: 'system' });
    const d = makeDeps({
        auth: { resolveUserOrgIds: async () => null, resolveUserGroups: async () => ['g1'] },
        db: realDb,
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.agents, 3, 'system and swarm rows stay out even for a super admin');
});

test('a member of no organisation gets agents 0 without a query — as /all shows nothing', async () => {
    await resetCountTables();
    await agentRow('a1', { organization_id: 'orgA' });
    const d = makeDeps({
        auth: { resolveUserOrgIds: async () => new Set(), resolveUserGroups: async () => ['g1'] },
        db: realDb,
    });
    await listen(mount(d));
    const body = await (await get()).json();
    assert.strictEqual(body.counts.agents, 0);
    assert.strictEqual(sqlSeen.filter((q) => q.includes('agents')).length, 0);
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

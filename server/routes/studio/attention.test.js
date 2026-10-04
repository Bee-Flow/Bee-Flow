/**
 * Route tests for GET /api/studio/attention (routes/studio/attention.js).
 *
 * Every dependency is injected through createAttentionRouter(deps), so no DB or
 * pool is opened; requests go over real HTTP against express app.listen(0).
 *
 * The contract this pins, in the order it matters:
 *
 *   1. EACH OF THE SIX SOURCES ON ITS OWN — one fixture that makes exactly one
 *      source speak, six times, so a source that silently stopped contributing
 *      cannot hide behind the other five.
 *   2. EACH OF THE SIX FALLING OVER — the reason this endpoint exists. A source
 *      whose store throws is named in `unavailable` and `complete` goes false;
 *      it does NOT quietly contribute zero rows, because an attention list that
 *      came out of a failure would read as "nothing is wrong".
 *   3. THE COMBINATION — all six speaking at once, errors before warnings, and
 *      the pair of empty answers ("looked, nothing" vs "could not look") coming
 *      out as different bodies.
 *   4. Gating: a source the caller may not see is `gated`, not an error and not
 *      a gap; a gate that THROWS is a gap, because unknown narrows.
 *   5. Scoping: each source reaches its store the way that store's own list
 *      route reaches it, and a row's deep link points at a screen this caller
 *      can open.
 *
 * NO POSTGRES RUNS HERE (5432/55432 are closed in this container), so the one
 * raw-SQL source (agents) is checked by asserting on the generated statement
 * and its parameters — its SHAPE, not its result — and the two store functions
 * this track added (getRecentRunStatusesForUser, countErrorSourcesByKb) are
 * exercised through their injected stand-ins. That is a real limitation and is
 * reported as one.
 *
 * Run: node --test --test-reporter=tap routes/studio/attention.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const { createAttentionRouter, SOURCE_KEYS, CACHE_TTL_MS } = require('./attention');

const USER = { id: 'u1', organizationId: 'orgA' };

// One app with no screens → the App Studio validator's `screens.missing`.
const APP_BROKEN = { schemaVersion: 2, meta: { name: 'Order portal' }, screens: [] };

/**
 * A fully-open, fully-populated fake dependency set: every gate open and every
 * source holding exactly ONE problem, so a body has six rows — three errors
 * (app, automation, Solution) and three warnings (agent, empty base, stale base).
 */
function makeDeps(overrides = {}) {
    const calls = { sql: [] };
    const bump = (name) => { calls[name] = (calls[name] || 0) + 1; };
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
        studioAppStore: {
            getAccessibleStudioApps: async () => { bump('apps'); return [
                { id: 'app1', name: 'Order portal', userId: 'u1' },
                // Published into the org by somebody else: visible, NOT editable.
                { id: 'app2', name: 'Colleague portal', userId: 'u2' },
            ]; },
            canWriteStudioApp: (app, userId) => app.userId === userId,
            getStudioApp: async (id) => { bump('appDefinition'); calls.appIds = [...(calls.appIds || []), id];
                return { id, name: 'Order portal', definition: APP_BROKEN }; },
        },
        automationStore: {
            getRecentRunStatusesForUser: async (userId, opts) => {
                bump('runs'); calls.runArgs = { userId, ...opts };
                return [
                    { automationId: 'a1', title: 'Invoice reminder', status: 'error' },
                    { automationId: 'a1', title: 'Invoice reminder', status: 'error' },
                    { automationId: 'a1', title: 'Invoice reminder', status: 'error' },
                    { automationId: 'a2', title: 'Weekly digest', status: 'success' },
                ];
            },
        },
        kbStore: {
            listKBs: async () => { bump('listKBs'); return [
                { id: 'kb1', name: 'Handbook', document_count: 0 },
                { id: 'kb2', name: 'Policies', document_count: 5 },
                { id: 'kbx', name: 'Not yours', document_count: 0 },
            ]; },
            // The group filter removes a base whose emptiness would otherwise
            // be reported — org scoping alone is not the visibility answer.
            filterByGroupAccess: (kbs) => kbs.filter(kb => kb.id !== 'kbx'),
            // Reading a base is not being able to fix it: the two knowledge
            // sources ask this before they hand anyone an instruction.
            canUserManageKB: () => true,
        },
        kbShared: {
            resolveIsOrgAdmin: async () => false,
            resolveEnabledSystemSlugs: async () => [],
            listFilterFromQuery: () => ({ sourceKind: 'manual' }),
            resolveUserGroups: async () => ['g1'],
        },
        kbUsage: {
            usageForKb: async (kbId) => { bump('kbUsage'); calls.usageIds = [...(calls.usageIds || []), kbId];
                return { rows: [{ kind: 'agent', id: 'ag1', role: 'chat' }], partial: [] }; },
        },
        kbSourcesStore: {
            countErrorSourcesByKb: async (ids) => { bump('kbSources'); calls.kbSourceIds = ids;
                return new Map([['kb2', 1]]); },
        },
        projectStore: { listUserProjects: async () => { bump('projects'); return [{ id: 'pr1', name: 'Invoice rollout' }]; } },
        configStore: { getConfig: async () => null },
        db: {
            getAll: async (sql, params) => {
                bump('agents'); calls.sql.push({ sql, params });
                return [
                    { id: 'ag1', name: 'Helpdesk', config: JSON.stringify({ knowledge_base_ids: [] }) },
                    { id: 'ag2', name: 'Grounded', config: JSON.stringify({ knowledge_base_ids: ['kb2'] }) },
                ];
            },
        },
        // Order-preserving, bounded — the real one lives in projects/summary.js.
        mapLimited: async (items, _width, fn) => {
            const out = [];
            for (let i = 0; i < items.length; i += 1) out.push(await fn(items[i], i));
            return out;
        },
        solutionCompleteness: async (projectId) => {
            bump('completeness'); calls.completenessIds = [...(calls.completenessIds || []), projectId];
            return { blocked: true, complete: true, findings: [{ severity: 'error' }, { severity: 'warning' }], unavailable: [] };
        },
    };
    return Object.assign(deps, overrides);
}

// ── Server harness ──────────────────────────────────────────────────────────
let server;
let baseUrl;
let deps;
let router;

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
    router = createAttentionRouter(deps);
    app.use('/api/studio', router);
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

const get = (user = 'u1') => fetch(`${baseUrl}/api/studio/attention`, {
    headers: user ? { 'x-test-user': user } : {},
});

const body = async (o = {}) => { await listen(mount(makeDeps(o))); router.__clearCacheForTests(); return (await get()).json(); };
const rowsFrom = (b, source) => b.rows.filter(r => r.source === source);

// ── 1. Every source, on its own ─────────────────────────────────────────────

test('all six sources answer, each contributing its own producer\'s row', async () => {
    const b = await body();
    assert.deepStrictEqual(Object.keys(b.sources).sort(), [...SOURCE_KEYS].sort());
    for (const key of SOURCE_KEYS) {
        assert.strictEqual(b.sources[key].status, 'checked', `${key} must have been checked`);
        assert.strictEqual(b.sources[key].found, 1, `${key} found exactly one thing`);
    }
    assert.strictEqual(b.complete, true);
    assert.deepStrictEqual(b.unavailable, []);
    assert.deepStrictEqual(b.gated, []);
    assert.strictEqual(b.total, 6);
    assert.strictEqual(b.rows.length, 6);
});

test('each row carries the producer\'s own code, severity, target and deep link', async () => {
    const b = await body();
    const byCode = Object.fromEntries(b.rows.map(r => [r.code, r]));
    assert.deepStrictEqual(Object.keys(byCode).sort(), [
        'agent.no_knowledge_base',
        'automation.consecutive_failures',
        'kb_source.refresh_failed',
        'knowledge_base.empty_in_use',
        'screens.missing',
        'solution.blocked',
    ]);
    // The app row is the App Studio validator's record, unrephrased.
    assert.strictEqual(byCode['screens.missing'].severity, 'error');
    assert.strictEqual(byCode['screens.missing'].kind, 'app');
    assert.strictEqual(byCode['screens.missing'].targetId, 'app1');
    assert.strictEqual(byCode['screens.missing'].deepLink, '/app/studio/apps/app1');
    // And every row can be opened — on the BUILDER's screen for its own kind,
    // which is the segment studioApps.jsx uses. A row whose link 403'd or
    // landed on a page that cannot repair anything would be worse than a row
    // with no button at all.
    const SEGMENT = { app: 'apps', automation: 'automations', kb: 'knowledge', solution: 'solutions', agent: 'agents' };
    for (const row of b.rows) {
        assert.ok(row.message && row.message.length > 0, `${row.code} must carry a sentence`);
        assert.ok(['error', 'warning', 'info'].includes(row.severity));
        assert.strictEqual(
            row.deepLink,
            `/app/studio/${SEGMENT[row.kind]}/${row.targetId}`,
            `${row.code} links to its own kind`,
        );
    }
});

test('errors sort above warnings, so the top of the list is what blocks', async () => {
    const b = await body();
    const severities = b.rows.map(r => r.severity);
    assert.deepStrictEqual(severities, ['error', 'error', 'error', 'warning', 'warning', 'warning']);
});

// ── 2. Every source, fallen over ────────────────────────────────────────────

const BREAKERS = {
    appValidation: { studioAppStore: { getAccessibleStudioApps: async () => { throw new Error('app store down'); } } },
    agentNoKb: { db: { getAll: async () => { throw new Error('core pool exhausted'); } } },
    kbEmptyInUse: { kbUsage: { usageForKb: async () => { throw new Error('usage scan failed'); } } },
    automationFailing: { automationStore: { getRecentRunStatusesForUser: async () => { throw new Error('tasks pool down'); } } },
    solutionBlocked: { projectStore: { listUserProjects: async () => { throw new Error('projects down'); } } },
    kbSourceError: { kbSourcesStore: { countErrorSourcesByKb: async () => { throw new Error('kb_sources down'); } } },
};

for (const [key, override] of Object.entries(BREAKERS)) {
    test(`${key} falling over is UNAVAILABLE — never zero rows`, async () => {
        const b = await body(override);
        assert.strictEqual(b.sources[key].status, 'unavailable', 'a failed source must say so');
        assert.strictEqual(b.sources[key].found, null, 'null is not 0');
        assert.ok(b.unavailable.includes(key));
        assert.strictEqual(b.complete, false, 'one unchecked source makes the whole list incomplete');
        assert.deepStrictEqual(rowsFrom(b, key), [], 'a source that could not look contributes nothing');
        // The other five still answered — that is why they run independently.
        for (const other of SOURCE_KEYS.filter(k => k !== key)) {
            assert.strictEqual(b.sources[other].status, 'checked', `${other} must be unaffected by ${key}`);
        }
        assert.strictEqual(b.rows.length, 5);
        assert.strictEqual(b.total, 5);
    });
}

test('a source that fails PART-WAY keeps the rows it found AND is still unavailable', async () => {
    // Two apps, one of whose definitions will not load: the app that WAS
    // validated still reports, and the source cannot vouch for the other.
    const b = await body({
        studioAppStore: {
            getAccessibleStudioApps: async () => [
                { id: 'app1', name: 'Order portal', userId: 'u1' },
                { id: 'app9', name: 'Unreadable', userId: 'u1' },
            ],
            canWriteStudioApp: (app, userId) => app.userId === userId,
            getStudioApp: async (id) => (id === 'app9' ? null : { id, name: 'Order portal', definition: APP_BROKEN }),
        },
    });
    assert.strictEqual(rowsFrom(b, 'appValidation').length, 1, 'a real problem is never dropped to be tidy');
    assert.strictEqual(b.sources.appValidation.status, 'unavailable');
    assert.strictEqual(b.complete, false);
});

test('a part-way source keeps its rows but stops claiming a count', async () => {
    const b = await body({
        studioAppStore: {
            getAccessibleStudioApps: async () => [
                { id: 'app1', name: 'Order portal', userId: 'u1' },
                { id: 'app9', name: 'Unreadable', userId: 'u1' },
            ],
            canWriteStudioApp: (app, userId) => app.userId === userId,
            getStudioApp: async (id) => (id === 'app9' ? null : { id, name: 'Order portal', definition: APP_BROKEN }),
        },
    });
    assert.strictEqual(rowsFrom(b, 'appValidation').length, 1, 'the row it DID find is on the list');
    assert.strictEqual(b.sources.appValidation.found, null, 'but the count is not one it can stand behind');
    assert.strictEqual(b.total, 6, 'rows that were genuinely found still count towards the total');
});

test('a source with more rows than fit is capped, and the honest total says so', async () => {
    // Twenty-five broken automations, each with three failures in a row.
    const many = [];
    for (let i = 0; i < 25; i += 1) {
        for (let r = 0; r < 3; r += 1) many.push({ automationId: `a${i}`, title: `Automation ${i}`, status: 'error' });
    }
    const b = await body({ automationStore: { getRecentRunStatusesForUser: async () => many } });
    assert.strictEqual(rowsFrom(b, 'automationFailing').length, 20, 'the list stays readable');
    assert.strictEqual(b.sources.automationFailing.found, 25, 'the count is what was FOUND, not what is shown');
    assert.strictEqual(b.sources.automationFailing.truncated, true);
    assert.strictEqual(b.total, 30, '25 automations + the other five sources');
    assert.strictEqual(b.complete, true, 'a cap is not a gap — nothing went unchecked');
});

test('when EVERY source is down the answer is six named gaps, not an empty all-clear', async () => {
    const broken = makeDeps();
    for (const name of ['modules', 'permissions', 'entitlements', 'license', 'auth']) {
        Object.defineProperty(broken, name, { get() { throw new Error('boom'); } });
    }
    // Knowledge is ungated (Community), so its two sources fail at the store.
    broken.kbStore = { listKBs: async () => { throw new Error('kb store down'); } };
    await listen(mount(broken));
    router.__clearCacheForTests();
    const b = await (await get()).json();
    assert.deepStrictEqual(b.rows, []);
    assert.deepStrictEqual(b.unavailable, [...SOURCE_KEYS].sort(), 'every dropped source is named');
    assert.strictEqual(b.complete, false, 'an empty list here must NOT read as all clear');
    assert.strictEqual(b.total, 0);
});

test('THE CENTRAL DISTINCTION: two empty lists, two different bodies', async () => {
    // (a) everything was checked and there is genuinely nothing wrong.
    const quiet = await body({
        studioAppStore: {
            getAccessibleStudioApps: async () => [],
            canWriteStudioApp: () => true,
            getStudioApp: async () => null,
        },
        db: { getAll: async () => [] },
        kbStore: { listKBs: async () => [], filterByGroupAccess: () => [] },
        kbSourcesStore: { countErrorSourcesByKb: async () => new Map() },
        automationStore: { getRecentRunStatusesForUser: async () => [] },
        projectStore: { listUserProjects: async () => [] },
    });
    assert.deepStrictEqual(quiet.rows, []);
    assert.strictEqual(quiet.complete, true, 'THIS is the only body that licenses "nothing needs attention"');
    for (const key of SOURCE_KEYS) assert.strictEqual(quiet.sources[key].found, 0, `${key} answered zero`);

    // (b) nothing came back because nothing could be read.
    const blind = await body({
        studioAppStore: { getAccessibleStudioApps: async () => { throw new Error('down'); } },
        db: { getAll: async () => { throw new Error('down'); } },
        kbStore: { listKBs: async () => { throw new Error('down'); } },
        automationStore: { getRecentRunStatusesForUser: async () => { throw new Error('down'); } },
        projectStore: { listUserProjects: async () => { throw new Error('down'); } },
    });
    assert.deepStrictEqual(blind.rows, [], 'the SAME empty list…');
    assert.strictEqual(blind.complete, false, '…and a different verdict');
    assert.notDeepStrictEqual(quiet.sources, blind.sources);
});

// ── 3. Gating ───────────────────────────────────────────────────────────────

test('a gated source is GATED — not an error, not a gap, and not silence', async () => {
    // Community-shaped org: no licence, no capabilities, no manage_agents.
    const b = await body({
        license: { featureAllowedForRequest: async () => ({ allowed: false }) },
        entitlements: { hasCapability: async () => false },
        permissions: { hasPermission: async () => false },
    });
    assert.deepStrictEqual(b.gated, ['agentNoKb', 'appValidation', 'automationFailing', 'solutionBlocked']);
    for (const key of b.gated) {
        assert.strictEqual(b.sources[key].status, 'gated');
        assert.strictEqual(b.sources[key].found, null, 'gated is not "found nothing"');
    }
    assert.deepStrictEqual(b.unavailable, []);
    assert.strictEqual(b.complete, true, 'an entitlement is a known absence, not a gap in the check');
    // Knowledge is Community, so its two sources still answered.
    assert.strictEqual(b.sources.kbEmptyInUse.status, 'checked');
    assert.strictEqual(b.sources.kbSourceError.status, 'checked');
});

test('a GATE that throws closes its source and says so — never an open door', async () => {
    const b = await body({
        entitlements: { hasCapability: async () => { throw new Error('entitlements unreachable'); } },
    });
    assert.deepStrictEqual(b.unavailable, ['appValidation', 'solutionBlocked']);
    assert.deepStrictEqual(b.gated, []);
    assert.strictEqual(b.complete, false);
    assert.deepStrictEqual(rowsFrom(b, 'appValidation'), [], 'a gate that cannot answer yields no rows');
});

test('the operator kill switch closes Solutions without making it a gap', async () => {
    const b = await body({ configStore: { getConfig: async () => false } });
    assert.strictEqual(b.sources.solutionBlocked.status, 'gated');
    assert.strictEqual(b.complete, true);
});

test('an inactive module closes its sources and nothing else', async () => {
    const b = await body({ modules: { isModuleActive: async (id) => id !== 'automation' } });
    assert.strictEqual(b.sources.automationFailing.status, 'gated');
    assert.strictEqual(b.sources.appValidation.status, 'checked');
    assert.strictEqual(b.complete, true);
});

// ── 4. Scoping ──────────────────────────────────────────────────────────────

test('only apps this caller can OPEN are validated — a link that would 403 is no link', async () => {
    const b = await body();
    assert.deepStrictEqual(deps._calls.appIds, ['app1'], 'a colleague\'s published app is not read at all');
    assert.strictEqual(rowsFrom(b, 'appValidation').length, 1);
    assert.strictEqual(b.sources.appValidation.status, 'checked', 'out of scope is not a gap');
});

test('the agents query carries the org narrowing in its WHERE, and asks only for published rows', async () => {
    await body();
    const { sql, params } = deps._calls.sql[0];
    assert.match(sql, /owner_id NOT IN \('system', 'swarm'\)/);
    assert.match(sql, /is_published = TRUE/);
    assert.match(sql, /organization_id = ANY\(\$1::text\[\]\)/);
    assert.deepStrictEqual(params[0], ['orgA']);
    // Printed rather than executed: no Postgres runs in this container, so the
    // statement is reviewed for SHAPE and that limitation is stated.
    console.log('[shape-only, not executed]', sql.replace(/\s+/g, ' '));
});

test('a super admin scans agents without an org filter; a member of no org scans nothing', async () => {
    await body({ auth: { resolveUserOrgIds: async () => null, resolveUserGroups: async () => [] } });
    assert.ok(!deps._calls.sql[0].sql.includes('organization_id'));

    const b = await body({ auth: { resolveUserOrgIds: async () => new Set(), resolveUserGroups: async () => [] } });
    assert.deepStrictEqual(rowsFrom(b, 'agentNoKb'), [], 'no org = no agents');
    assert.strictEqual(deps._calls.sql.length, 0, 'and no query either');
    assert.strictEqual(b.sources.agentNoKb.status, 'checked');
});

test('the knowledge sources see the same bases the knowledge list would show', async () => {
    const b = await body();
    // kbx is removed by filterByGroupAccess and must reach neither source.
    assert.deepStrictEqual(deps._calls.usageIds, ['kb1'], 'only the EMPTY base is probed for usage');
    assert.deepStrictEqual(deps._calls.kbSourceIds, ['kb1', 'kb2']);
    assert.strictEqual(rowsFrom(b, 'kbEmptyInUse')[0].targetId, 'kb1');
    assert.strictEqual(rowsFrom(b, 'kbSourceError')[0].targetId, 'kb2');
    // Both sources share ONE visibility read per request.
    assert.strictEqual(deps._calls.listKBs, 1);
});

test('a failure in the shared knowledge read marks BOTH its sources unavailable', async () => {
    const b = await body({ kbStore: { listKBs: async () => { throw new Error('kb store down'); } } });
    assert.deepStrictEqual(b.unavailable, ['kbEmptyInUse', 'kbSourceError']);
    assert.strictEqual(b.complete, false);
    assert.strictEqual(b.sources.appValidation.status, 'checked', 'sharing a read does not share a verdict');
});

test('runs are asked for the caller only, bounded in time and per automation', async () => {
    await body();
    assert.strictEqual(deps._calls.runArgs.userId, 'u1');
    assert.strictEqual(deps._calls.runArgs.perAutomation, 10);
    assert.ok(deps._calls.runArgs.sinceTs < new Date(1_000_000).toISOString(), 'the window reaches into the past');
});

test('Solutions are checked only for the projects the caller already holds', async () => {
    await body();
    assert.deepStrictEqual(deps._calls.completenessIds, ['pr1']);
});

// ── 5. Response hygiene ─────────────────────────────────────────────────────

test('an unauthenticated request is refused before any store is touched', async () => {
    await listen(mount(makeDeps()));
    const res = await fetch(`${baseUrl}/api/studio/attention`);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(deps._calls.apps, undefined);
    assert.strictEqual(deps._calls.listKBs, undefined);
});

test('the answer is never cached by the browser', async () => {
    await listen(mount(makeDeps()));
    router.__clearCacheForTests();
    const res = await get();
    assert.strictEqual(res.headers.get('cache-control'), 'private, no-store');
});

test('a COMPLETE answer is cached for a minute; an INCOMPLETE one never is', async () => {
    await listen(mount(makeDeps()));
    router.__clearCacheForTests();
    await get();
    await get();
    assert.strictEqual(deps._calls.listKBs, 1, 'the second request was served from the cache');
    deps._tick(CACHE_TTL_MS + 1);
    await get();
    assert.strictEqual(deps._calls.listKBs, 2, 'and the cache expires');

    // A body with a gap must be recomputed every time: holding it would turn a
    // two-second hiccup into a minute of a screen that cannot say anything.
    await listen(mount(makeDeps({ projectStore: { listUserProjects: async () => { throw new Error('down'); } } })));
    router.__clearCacheForTests();
    const first = await (await get()).json();
    assert.strictEqual(first.complete, false);
    await get();
    assert.strictEqual(deps._calls.listKBs, 2, 'an incomplete body is never cached');
});

test('the cache is per person, so one caller\'s entitlements never answer another\'s request', async () => {
    await listen(mount(makeDeps()));
    router.__clearCacheForTests();
    await get('u1');
    await get('u2');
    assert.strictEqual(deps._calls.listKBs, 2);
});

// ── 6. A gate that FAILS CLOSED is a gap, never a locked door ───────────────
//
// The three checks under routes/studio/shared.js all answer `false` when they
// could not determine the answer, and `false` on this endpoint means "not
// yours" — a known absence that deliberately does NOT clear `complete`. Left
// alone, one degraded store therefore turns into "Nothing needs attention"
// over four unchecked sources. Each of the three has its own test because each
// fails closed for its own reason.

test('a licence tier that could not be RESOLVED is a gap, not a Community org', async () => {
    // license/middleware.js:228 — requireFeature turns this into a 503, not a
    // 403, precisely because it is not an entitlement answer.
    const b = await body({
        license: {
            featureAllowedForRequest: async () => ({ allowed: false, resolution: { error: 'tier_unavailable' } }),
        },
    });
    assert.ok(b.unavailable.includes('automationFailing'), 'it could not be checked');
    assert.ok(!b.gated.includes('automationFailing'), 'and it is NOT "you do not have automations"');
    assert.strictEqual(b.sources.automationFailing.found, null);
    assert.strictEqual(b.complete, false, 'a screen may not reassure over this');
});

test('a DEGRADED capability snapshot is a gap, not a locked feature', async () => {
    // entitlements.js:648-657 — hasCapability fails closed on a degraded
    // resolve; resolveCapabilitySet is the same resolution that says so.
    const b = await body({
        entitlements: {
            hasCapability: async () => false,
            resolveCapabilitySet: async () => ({ degraded: true, snapshot: null, has: () => false }),
        },
    });
    assert.deepStrictEqual(b.unavailable, ['appValidation', 'solutionBlocked']);
    assert.deepStrictEqual(b.gated, []);
    assert.strictEqual(b.complete, false);
});

test('a DEGRADED permission lookup is a gap, not "you do not manage agents"', async () => {
    // permissions.js:676-686 returns ['page_chat'] on a DB error and sets the
    // sticky flag this reads.
    const b = await body({
        permissions: { hasPermission: async () => false, isPermissionLookupDegraded: () => true },
    });
    assert.ok(b.unavailable.includes('agentNoKb'));
    assert.ok(!b.gated.includes('agentNoKb'));
    // The two knowledge sources ask the same question before handing out an
    // instruction, so they cannot answer either.
    assert.ok(b.unavailable.includes('kbEmptyInUse'));
    assert.ok(b.unavailable.includes('kbSourceError'));
    assert.strictEqual(b.complete, false);
});

test('a permission that is simply absent stays GATED — the flag is what tells them apart', async () => {
    const b = await body({
        permissions: { hasPermission: async () => false, isPermissionLookupDegraded: () => false },
    });
    assert.ok(b.gated.includes('agentNoKb'));
    assert.ok(!b.unavailable.includes('agentNoKb'));
});

test('an UNREADABLE org list is not "a member of no organisation"', async () => {
    // auth/permissions.js:832-866 swallows a store failure and returns an
    // empty Set unless asked strictly; the empty Set path is a hard "we looked
    // and there is no published agent without a knowledge base".
    const b = await body({
        auth: {
            resolveUserOrgIds: async (_req, opts) => {
                if (opts && opts.strict) throw new Error('user store down');
                return new Set();
            },
            resolveUserGroups: async () => [],
        },
    });
    assert.strictEqual(b.sources.agentNoKb.status, 'unavailable');
    assert.strictEqual(b.sources.agentNoKb.found, null);
    assert.strictEqual(deps._calls.sql.length, 0, 'and nothing was queried on a guess');
    assert.strictEqual(b.complete, false);
});

// ── 7. A budget is a SIZE, not a breakdown — and not a clean bill either ────

const overBudget = (n, make) => Array.from({ length: n }, (_, i) => make(i));

test('more apps than the budget → capped, named, and NOT complete', async () => {
    const b = await body({
        studioAppStore: {
            getAccessibleStudioApps: async () => overBudget(26, i => ({ id: `app${i}`, name: `App ${i}`, userId: 'u1' })),
            canWriteStudioApp: () => true,
            getStudioApp: async (id) => ({ id, name: id, definition: { schemaVersion: 2, meta: { name: id }, screens: [{ id: 's', elements: [] }] } }),
        },
    });
    assert.strictEqual(b.sources.appValidation.status, 'capped');
    assert.deepStrictEqual(b.capped, ['appValidation']);
    assert.deepStrictEqual(b.unavailable, [], 'a big organisation is not a broken one');
    assert.strictEqual(b.complete, false, 'and it is not a clean bill of health either');
});

test('more published agents than the budget → capped', async () => {
    const b = await body({
        db: { getAll: async () => overBudget(201, i => ({ id: `ag${i}`, name: `Agent ${i}`, config: '{"knowledge_base_ids":["kb2"]}' })) },
    });
    assert.strictEqual(b.sources.agentNoKb.status, 'capped');
    assert.ok(b.capped.includes('agentNoKb'));
    assert.strictEqual(b.complete, false);
});

test('more empty knowledge bases than the budget → capped', async () => {
    const b = await body({
        kbStore: {
            listKBs: async () => overBudget(21, i => ({ id: `kb${i}`, name: `Base ${i}`, document_count: 0 })),
            filterByGroupAccess: (kbs) => kbs,
            canUserManageKB: () => true,
        },
        kbUsage: { usageForKb: async () => ({ rows: [], partial: [] }) },
        kbSourcesStore: { countErrorSourcesByKb: async () => new Map() },
    });
    assert.strictEqual(b.sources.kbEmptyInUse.status, 'capped');
    assert.strictEqual(b.sources.kbSourceError.status, 'checked', 'the cap belongs to one source only');
    assert.strictEqual(b.complete, false);
});

test('more Solutions than the budget → capped', async () => {
    const b = await body({
        projectStore: { listUserProjects: async () => overBudget(13, i => ({ id: `pr${i}`, name: `Solution ${i}` })) },
        solutionCompleteness: async () => ({ blocked: false, complete: true, findings: [], unavailable: [] }),
    });
    assert.strictEqual(b.sources.solutionBlocked.status, 'capped');
    assert.strictEqual(b.complete, false);
});

test('a real breakdown outranks a cap on the same source', async () => {
    const b = await body({
        studioAppStore: {
            getAccessibleStudioApps: async () => overBudget(26, i => ({ id: `app${i}`, name: `App ${i}`, userId: 'u1' })),
            canWriteStudioApp: () => true,
            getStudioApp: async () => { throw new Error('definition unreadable'); },
        },
    });
    assert.strictEqual(b.sources.appValidation.status, 'unavailable');
    assert.deepStrictEqual(b.capped, [], 'one word per source, and the worse one wins');
});

// ── 8. The row's own contract ───────────────────────────────────────────────

test('a producer\'s remediation travels to the client, and an absent one is omitted', async () => {
    const b = await body();
    const withHint = b.rows.filter(r => typeof r.remediation === 'string' && r.remediation.length > 0);
    assert.ok(withHint.length >= 4, 'the producers that write a fix keep it');
    for (const row of b.rows) {
        assert.ok(!('remediation' in row) || typeof row.remediation === 'string');
    }
    // The one field the pill renders as its "→" line; losing it silently is
    // how every row on Studio Home stops saying what to do.
    const kbRow = b.rows.find(r => r.code === 'kb_source.refresh_failed');
    assert.strictEqual(kbRow.remediation, 'Open the knowledge base and check its sources.');
});

test('`truncated` is true only when a source found more than it could send', async () => {
    const clean = await body();
    for (const key of SOURCE_KEYS) assert.strictEqual(clean.sources[key].truncated, false);

    // 21 failing automations, one row each, over a per-source cap of 20.
    const many = [];
    for (let i = 0; i < 21; i += 1) {
        for (let r = 0; r < 3; r += 1) many.push({ automationId: `a${i}`, title: `Automation ${i}`, status: 'error' });
    }
    const b = await body({ automationStore: { getRecentRunStatusesForUser: async () => many } });
    assert.strictEqual(b.sources.automationFailing.truncated, true);
    assert.strictEqual(b.sources.automationFailing.found, 21, 'the true count, not the drawn one');
    assert.strictEqual(rowsFrom(b, 'automationFailing').length, 20);
    assert.strictEqual(b.total, 26, 'and the header can still say how many there really are');
});

// ── 9. A knowledge row is an instruction, so it goes to who can follow it ───

test('a base this reader may READ but not MANAGE is not an instruction for them', async () => {
    const b = await body({
        kbStore: {
            listKBs: async () => [
                { id: 'kb1', name: 'Handbook', document_count: 0, tenant_id: 'u1' },
                { id: 'kbShared', name: 'Someone else\'s', document_count: 0, tenant_id: 'u2' },
            ],
            filterByGroupAccess: (kbs) => kbs,
            // The store's own rule: owner, super admin, or same org + the
            // manage_knowledge permission (knowledgeBases.js:601).
            canUserManageKB: (kb, userId) => kb.tenant_id === userId,
        },
    });
    const ids = rowsFrom(b, 'kbEmptyInUse').map(r => r.targetId);
    assert.deepStrictEqual(ids, ['kb1'], 'the row whose "add a document" button this reader actually has');
    assert.deepStrictEqual(deps._calls.usageIds, ['kb1'], 'and the other one is not even probed');
    assert.strictEqual(b.sources.kbEmptyInUse.status, 'checked', 'out of reach is not a gap');
});

test('only Solutions (and unclassified legacy projects) are checked for publishing', async () => {
    // A collaborative project is never published, so it must neither produce a
    // "cannot be published yet" row nor use up the budget of Solutions checked.
    let asked = null;
    const b = await body({
        projectStore: {
            listUserProjects: async (userId, groupIds, opts) => {
                asked = opts;
                return [{ id: 'pr1', name: 'Invoice rollout' }];
            },
        },
        solutionCompleteness: async () => ({ blocked: false, complete: true, findings: [], unavailable: [] }),
    });
    assert.deepStrictEqual(asked, { kind: 'solution' });
    assert.strictEqual(b.sources.solutionBlocked.status, 'checked');
});

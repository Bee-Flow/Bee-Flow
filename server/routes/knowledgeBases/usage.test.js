/**
 * The usage endpoints, through the REAL facade (routes/knowledgeBases.js), so
 * the mount order is under test too — `/usage-summary` and `/suggestions` are
 * literal paths that `GET /:id` would otherwise swallow, exactly as
 * `/categories` and `/system` would have been.
 *
 * The properties worth protecting are the two the module exists for:
 *
 *   • "I could not check apps" must never render as "nothing uses this". The
 *     delete confirmation reads that as safe to remove, and the person believes
 *     it because they asked.
 *   • The Used-by list must not become a way to enumerate an organisation. A
 *     thing the asker cannot see for themselves is COUNTED but not named.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/usage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('node:path');

const fx = {
    kb: null,
    canAccess: true,
    usage: { rows: [], partial: [] },
    summary: {},
    kbs: [],
    agents: [],
    agentScanFails: false,
};

const KB = { id: 'kb1', tenant_id: 'owner1', name: 'Handbook', organization_id: 'org1' };
const mw = (req, res, next) => next();

function resetFx() {
    fx.kb = { ...KB };
    fx.canAccess = true;
    fx.usage = { rows: [], partial: [] };
    fx.summary = {};
    fx.kbs = [];
    fx.agents = [];
    fx.agentScanFails = false;
}
resetFx();

const MOCKS = {
    '../stores/knowledgeBases': {
        getKB: async (id) => (fx.kb && fx.kb.id === id ? fx.kb : null),
        listKBs: async () => fx.kbs,
        isSystemKB: () => false,
    },
    '../auth': {
        requireAuth: mw,
        requirePermission: () => mw,
        requireActiveOrgForMutations: () => mw,
        resolveUserOrgIds: async () => new Set(['org1']),
        hasPermission: async () => true,
        resolveUserGroups: async () => [],
        validateSharedGroupsForOrg: async () => {},
    },
    '../support/kbAccess': {
        canAccessKB: async () => fx.canAccess,
        resolveIsOrgAdmin: async () => false,
    },
    '../core/kb/kbUsage': {
        usageForKb: async () => fx.usage,
        usageSummary: async (ids) => Object.fromEntries((ids || []).map(id => [id, fx.summary[id] || { counts: {}, partial: [] }])),
        scrubReferences: async () => ({}),
    },
    '../db': {
        pool: {
            query: async () => {
                if (fx.agentScanFails) throw new Error('relation "agents" does not exist');
                return { rows: fx.agents };
            },
        },
    },
    'multer': Object.assign(() => ({ any: () => mw, single: () => mw, array: () => mw }), { memoryStorage: () => ({}) }),
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-usage:${request}`;
    MOCK_IDS[request] = mockId;
    MOCK_IDS[request.replace(/^\.\.\//, '../../')] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]knowledgeBases(\.js|[\\/][^\\/]+\.js)$/.test(parent.filename)
        && !/\.test\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require(path.join(__dirname, '..', 'knowledgeBases.js'));
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ method = 'GET', url, body = {}, session = { user: { id: 'u1' } } }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const request = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {}, session,
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

test.beforeEach(resetFx);

// ── GET /:id/usage ──────────────────────────────────────────────────

test('returns the Used-by rows for a base the asker may read', async () => {
    fx.usage = {
        rows: [{ kind: 'agent', id: 'ag1', title: 'Support assistant', role: 'chat', ownerId: 'u1', lastAt: null }],
        partial: [],
    };
    const res = await dispatch({ url: '/kb1/usage' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.usage[0].title, 'Support assistant');
    assert.deepStrictEqual(res.body.unchecked, []);
});

test('a kind that could not be checked is reported, not silently dropped', async () => {
    // "The apps table is not on this install" is not "no app uses this", and
    // only one of them is safe to press delete on.
    fx.usage = { rows: [], partial: ['app', 'automation'] };
    const res = await dispatch({ url: '/kb1/usage' });
    assert.deepStrictEqual(res.body.usage, []);
    assert.deepStrictEqual(res.body.unchecked, ['app', 'automation']);
});

test("somebody else's thing is counted but not named", async () => {
    // "Used by 3 agents" from one shared base must not become a directory of
    // what the rest of the organisation is building.
    fx.usage = {
        rows: [
            { kind: 'agent', id: 'ag1', title: 'Mine', role: 'chat', ownerId: 'u1', lastAt: null },
            { kind: 'agent', id: 'ag2', title: 'Payroll questions', role: 'chat', ownerId: 'u_other', lastAt: null },
        ],
        partial: [],
    };
    const res = await dispatch({ url: '/kb1/usage' });
    const [mine, theirs] = res.body.usage;
    assert.strictEqual(mine.title, 'Mine');
    assert.strictEqual(theirs.title, null, 'the name is withheld');
    assert.strictEqual(theirs.foreign, true);
    assert.strictEqual(theirs.kind, 'agent', 'but it still counts, and still says what it is');
    assert.ok(!JSON.stringify(res.body).includes('Payroll questions'));
});

test('a base the asker may not read answers 403, not a usage list', async () => {
    fx.canAccess = false;
    const res = await dispatch({ url: '/kb1/usage' });
    assert.strictEqual(res.statusCode, 403);
});

test('a base that does not exist answers 404', async () => {
    const res = await dispatch({ url: '/kb_gone/usage' });
    assert.strictEqual(res.statusCode, 404);
});

// ── GET /usage-summary ──────────────────────────────────────────────

test('the summary is a literal path, not a knowledge base called "usage-summary"', async () => {
    // Mounted before `detail`, or `GET /:id` swallows it — the same ordering
    // rule /categories and /system already live under.
    fx.kbs = [{ id: 'kb1' }, { id: 'kb2' }];
    fx.summary = { kb1: { counts: { agent: 3 }, partial: [] } };
    const res = await dispatch({ url: '/usage-summary' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.summary.kb1.counts, { agent: 3 });
    assert.deepStrictEqual(res.body.summary.kb2.counts, {});
});

test('the summary only covers bases the asker can already see', async () => {
    // Asking for a summary must not be a way to probe for ids.
    fx.kbs = [{ id: 'kb1' }];
    fx.summary = { kb1: { counts: {}, partial: [] }, kb_secret: { counts: { agent: 9 }, partial: [] } };
    const res = await dispatch({ url: '/usage-summary' });
    assert.deepStrictEqual(Object.keys(res.body.summary), ['kb1']);
});

// ── GET /suggestions ────────────────────────────────────────────────

test('suggests an agent with no knowledge for a base nothing uses', async () => {
    fx.kbs = [{ id: 'kb1', name: 'Nextcloud handleidingen', description: '' }];
    fx.summary = { kb1: { counts: {}, partial: [] } };
    fx.agents = [{ id: 'ag1', name: 'Nextcloud Buddy', description: 'Beantwoordt vragen over Nextcloud' }];
    const res = await dispatch({ url: '/suggestions' });
    assert.strictEqual(res.body.suggestions.length, 1);
    assert.strictEqual(res.body.suggestions[0].agentId, 'ag1');
    assert.strictEqual(res.body.suggestions[0].kbId, 'kb1');
});

test('a base something already uses is not suggested', async () => {
    // The pill beside it already says "3 agents"; suggesting it is noise.
    fx.kbs = [{ id: 'kb1', name: 'Nextcloud handleidingen', description: '' }];
    fx.summary = { kb1: { counts: { agent: 3 }, partial: [] } };
    fx.agents = [{ id: 'ag1', name: 'Nextcloud Buddy', description: '' }];
    const res = await dispatch({ url: '/suggestions' });
    assert.deepStrictEqual(res.body.suggestions, []);
});

test('no word overlap is no suggestion — it never guesses', async () => {
    fx.kbs = [{ id: 'kb1', name: 'Nextcloud handleidingen', description: '' }];
    fx.summary = { kb1: { counts: {}, partial: [] } };
    fx.agents = [{ id: 'ag1', name: 'Vakantieplanner', description: 'Regelt verlofaanvragen' }];
    const res = await dispatch({ url: '/suggestions' });
    assert.deepStrictEqual(res.body.suggestions, []);
});

test('the same request twice gives the same answer', async () => {
    // Deterministic on purpose: this sits on the section's front page, where
    // it is seen far more often than acted on, and a suggestion that changes
    // between two page loads reads as a system that is guessing.
    fx.kbs = [
        { id: 'kb1', name: 'Nextcloud handleidingen', description: '' },
        { id: 'kb2', name: 'Verlofregeling handleidingen', description: '' },
    ];
    fx.summary = { kb1: { counts: {}, partial: [] }, kb2: { counts: {}, partial: [] } };
    fx.agents = [
        { id: 'ag1', name: 'Nextcloud Buddy', description: 'handleidingen' },
        { id: 'ag2', name: 'Verlofbot', description: 'verlofregeling handleidingen' },
    ];
    const a = await dispatch({ url: '/suggestions' });
    const b = await dispatch({ url: '/suggestions' });
    assert.deepStrictEqual(a.body, b.body);
});

test('an agent scan that fails costs a suggestion, never an error', async () => {
    fx.kbs = [{ id: 'kb1', name: 'Nextcloud handleidingen', description: '' }];
    fx.summary = { kb1: { counts: {}, partial: [] } };
    fx.agentScanFails = true;
    const res = await dispatch({ url: '/suggestions' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.suggestions, []);
});

test('at most three, best first', async () => {
    fx.kbs = Array.from({ length: 6 }, (_, i) => ({ id: `kb${i}`, name: `alpha beta gamma delta ${i}`, description: '' }));
    fx.summary = Object.fromEntries(fx.kbs.map(k => [k.id, { counts: {}, partial: [] }]));
    fx.agents = [{ id: 'ag1', name: 'alpha beta gamma delta', description: '' }];
    const res = await dispatch({ url: '/suggestions' });
    assert.strictEqual(res.body.suggestions.length, 3);
    const scores = res.body.suggestions.map(s => s.score);
    assert.deepStrictEqual(scores, [...scores].sort((a, b) => b - a));
});

// ── The scoring helpers ─────────────────────────────────────────────

describe_matching();
function describe_matching() {
    const { wordsOf, overlap } = require('./usage');

    test('short words are dropped — they would pair everything with everything', () => {
        const words = wordsOf('de AI en the handleidingen');
        assert.deepStrictEqual([...words], ['handleidingen']);
    });

    test('punctuation and case do not break a match', () => {
        assert.strictEqual(overlap(wordsOf('Nextcloud-handleidingen!'), wordsOf('nextcloud handleidingen')), 2);
    });
}

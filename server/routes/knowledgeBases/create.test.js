'use strict';

/**
 * `POST /api/kb/:id/duplicate` — and above all `?withSources=1`.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────
 * The duplicate route copies every non-upload source LITERALLY to a new
 * knowledge base of the caller — `config` and all. For a `text` source that config is not just content: `config.metadata.transcriptionId` is an ASSERTION
 * that the line comes from a certain meeting, and that assertion lands on the run bar, the Used-by tab and the delete gate of that meeting.
 * The right that this route demands (`manage_knowledge` + read access to the SOURCE knowledge base) is, for an org-published KB, simply org membership, and says nothing about the meeting to which the line points.
 *
 * The write gate in sources.js was there, but this route went around it, in the same routes/knowledgeBases.js mounted, and no test touched
 * `?withSources=1`.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/create.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    kb: null,
    sources: [],
    created: [],          // kbSources.create-payloads
    createdKbs: [],
    canAccess: true,
    visibleTranscriptions: [],
    transcriptProbes: [],
    transcriptProbeFails: false,
    users: {},
    allGroups: [],
};

function resetFx() {
    fx.kb = {
        id: 'kb-src', tenant_id: 'collega-a', name: 'Team notes',
        description: '', organization_id: 'org1', category_id: null, icon: null, usage_contexts: null,
    };
    fx.sources = [];
    fx.canAccess = true;
    fx.visibleTranscriptions = [];
    fx.transcriptProbeFails = false;
    fx.created.length = 0;
    fx.createdKbs.length = 0;
    fx.transcriptProbes.length = 0;
    fx.users = { 'gebruiker-b': { id: 'gebruiker-b', organizationId: 'org1', groups: [] } };
    fx.allGroups = [];
}

const mw = (req, res, next) => next();

const MOCKS = {
    '../stores/knowledgeBases': {
        getKB: async (id) => (fx.kb && fx.kb.id === id ? { ...fx.kb } : null),
        createKB: async (userId, name, description, orgId, opts) => {
            const row = { id: `kb-copy-${fx.createdKbs.length + 1}`, tenant_id: userId, name, description, organization_id: orgId, ...opts };
            fx.createdKbs.push(row);
            return row;
        },
    },
    '../stores/kbSources': {
        listByKb: async (kbId) => fx.sources.filter((s) => s.knowledgeBaseId === kbId),
        create: async (p) => { fx.created.push(p); return { id: `s${fx.created.length}`, ...p }; },
    },
    '../stores/transcriptionStore': {
        canReadTranscription: async (id, reader, ctx) => {
            fx.transcriptProbes.push({ id, reader, ctx });
            if (fx.transcriptProbeFails) throw new Error('transcriptions is down');
            return fx.visibleTranscriptions.includes(id);
        },
    },
    '../stores/userStore': {
        getUser: async (id) => (fx.users[id] ? { ...fx.users[id] } : null),
        getAllGroups: async () => fx.allGroups,
    },
    '../auth': {
        requireAuth: mw,
        requirePermission: () => mw,
        assertUserCanUseOrg: async (_req, orgId) => orgId || null,
        resolveUserGroups: async (id) => (fx.users[id]?.groups || []),
    },
    './shared': {
        getUserId: (req) => req.session?.user?.id || null,
        canAccessKB: async () => fx.canAccess,
        sanitizeUsageContexts: (v) => (Array.isArray(v) ? v : null),
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-create:${request}`;
    MOCK_IDS[request] = mockId;
    MOCK_IDS[request.replace(/^\.\.\//, '../../')] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // Also the shared gate and the org resolution it leans on: those run
    // outside routes/, but if they talk to the REAL database here, the test proves
    // nothing about the scope with which they probe.
    if (parent && (/routes[\\/]knowledgeBases[\\/]create\.js$/.test(parent.filename)
                   || /core[\\/]kb[\\/](transcriptOrigin|askerContext)\.js$/.test(parent.filename))
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./create');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ url, session = { user: { id: 'gebruiker-b' } }, body = {} }) {
    const [pathname, search = ''] = String(url).split('?');
    const query = {};
    for (const [k, v] of new URLSearchParams(search)) query[k] = v;
    return new Promise((resolve, reject) => {
        const req = { method: 'POST', url: pathname, originalUrl: url, query, headers: {}, body, session, get() { return undefined; } };
        const res = {
            statusCode: 200, body: undefined,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            setHeader() {}, set() { return this; },
        };
        router(req, res, (err) => reject(err || new Error(`viel door de router heen: ${url}`)));
    });
}

/** Een gefileerde transcriptregel in de kennisbank van een collega. */
function filedLine(transcriptionId) {
    return {
        id: 's-filed', knowledgeBaseId: 'kb-src', kind: 'text', name: 'Regel 12',
        config: { title: 'Regel 12', charCount: 42, metadata: { transcriptionId, segmentIndex: 12 } },
        refreshMode: 'manual',
    };
}

test.beforeEach(resetFx);

test('een gefileerde transcriptregel kopieert ZONDER de claim op andermans vergadering', async () => {
    // Colleague A files line 12 of her private meeting into the org-wide
    // KB 'Team notes'. User B may read that KB but has never been allowed to open M. Without the sieve, B got a row with `transcriptionId = M` and
    // `createdBy = B` — and A got an extra line on her run bar plus an extra 409 reason when deleting her own meeting.
    fx.sources = [filedLine('M-van-collega-a')];
    fx.visibleTranscriptions = [];   // B mag M niet zien

    const res = await dispatch({ url: '/kb-src/duplicate?withSources=1' });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.sourcesCopied, 1, 'de bron zelf is gewoon inhoud die B mag lezen');

    assert.strictEqual(fx.created.length, 1);
    const copied = fx.created[0].config;
    assert.strictEqual('metadata' in copied, false, 'de bewering over M is niet meegekopieerd');
    assert.strictEqual(copied.title, 'Regel 12', 'de rest van de config blijft heel');
    assert.strictEqual(copied.charCount, 42);
});

test('dezelfde regel in je EIGEN vergadering houdt de koppeling wél', async () => {
    // The flip side: someone who duplicates their own knowledge base keeps the link
    // to their own meeting — otherwise the sieve would be a loss of function.
    fx.sources = [filedLine('M-van-b-zelf')];
    fx.visibleTranscriptions = ['M-van-b-zelf'];

    await dispatch({ url: '/kb-src/duplicate?withSources=1' });
    assert.deepStrictEqual(fx.created[0].config.metadata, { transcriptionId: 'M-van-b-zelf', segmentIndex: 12 });
});

test('de probe draagt de scope van de KOPIEERDER, zonder isSuperAdmin', async () => {
    fx.sources = [filedLine('M-van-collega-a')];
    fx.visibleTranscriptions = ['M-van-collega-a'];
    fx.users['gebruiker-b'] = { id: 'gebruiker-b', organizationId: 'org1', groups: ['g-sales'] };
    fx.allGroups = [{ id: 'g-sales', organizationId: 'org-via-groep' }];

    await dispatch({ url: '/kb-src/duplicate?withSources=1' });
    assert.strictEqual(fx.transcriptProbes.length, 1);
    const { reader, ctx } = fx.transcriptProbes[0];
    assert.strictEqual(reader, 'gebruiker-b', 'niet de eigenaar van de bron-kennisbank');
    assert.strictEqual('isSuperAdmin' in ctx, false);
    assert.deepStrictEqual([...ctx.orgIds].sort(), ['org-via-groep', 'org1']);
});

test('een probe die omvalt laat de claim vallen — niet kunnen kijken is geen toestemming', async () => {
    fx.sources = [filedLine('M-van-collega-a')];
    fx.transcriptProbeFails = true;

    const res = await dispatch({ url: '/kb-src/duplicate?withSources=1' });
    assert.strictEqual(res.statusCode, 201, 'het duplicaat zelf blijft staan — het bestond al');
    assert.strictEqual('metadata' in fx.created[0].config, false);
});

test('een gewone tekstbron wordt niet geprobed', async () => {
    fx.sources = [{ id: 's1', knowledgeBaseId: 'kb-src', kind: 'text', name: 'Openingstijden', config: { title: 'Openingstijden', charCount: 20 } }];
    await dispatch({ url: '/kb-src/duplicate?withSources=1' });
    assert.deepStrictEqual(fx.transcriptProbes, [], 'geen vergaderingslookup voor tekst die niets beweert');
    assert.deepStrictEqual(fx.created[0].config, { title: 'Openingstijden', charCount: 20 });
});

test('zonder ?withSources=1 wordt er geen enkele bron gekopieerd', async () => {
    fx.sources = [filedLine('M-van-collega-a')];
    const res = await dispatch({ url: '/kb-src/duplicate' });
    assert.strictEqual(res.body.sourcesCopied, 0);
    assert.deepStrictEqual(fx.created, []);
    assert.deepStrictEqual(fx.transcriptProbes, []);
});

test('een upload-bron wordt overgeslagen (zijn documenten gaan niet mee)', async () => {
    fx.sources = [{ id: 's1', knowledgeBaseId: 'kb-src', kind: 'upload', name: 'Handbook.pdf', config: {} }];
    const res = await dispatch({ url: '/kb-src/duplicate?withSources=1' });
    assert.strictEqual(res.body.sourcesCopied, 0);
});

test('geen leesrecht op de bron-kennisbank → 404, en niets gekopieerd', async () => {
    fx.canAccess = false;
    fx.sources = [filedLine('M-van-collega-a')];
    const res = await dispatch({ url: '/kb-src/duplicate?withSources=1' });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(fx.created, []);
});

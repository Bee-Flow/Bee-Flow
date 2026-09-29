'use strict';

/**
 * `POST /api/kb/:id/duplicate` — en vooral `?withSources=1`.
 *
 * ── WAAROM DIT BESTAAT ──────────────────────────────────────────────
 * De duplicaat-route kopieert elke niet-upload bron LETTERLIJK naar een nieuwe
 * kennisbank van de aanroeper — `config` en al. Voor een `text`-bron is die
 * config niet alleen inhoud: `config.metadata.transcriptionId` is een BEWERING
 * dat die regel uit een bepaalde vergadering komt, en die bewering landt op de
 * uitvoerbalk, het Gebruikt-door-tabblad en de verwijderpoort van die
 * vergadering. Het recht dat deze route eist (`manage_knowledge` + leesrecht
 * op de BRON-kennisbank) is voor een org-gepubliceerde KB gewoon
 * org-lidmaatschap, en zegt niets over de vergadering waarnaar de regel wijst.
 *
 * De schrijfpoort in sources.js stond er wél; deze route ging eromheen, in
 * hetzelfde routes/knowledgeBases.js gemount, en geen enkele test raakte
 * `?withSources=1` aan.
 *
 * Draaien: cd server && node --test --test-force-exit routes/knowledgeBases/create.test.js
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
    // Ook de gedeelde poort en de org-resolutie waarop hij leunt: die draaien
    // buiten routes/, maar als ze hier met de ECHTE database praten bewijst de
    // test niets over de scope waarmee ze probben.
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
    // Collega A filet regel 12 van haar besloten vergadering in de org-brede
    // KB 'Team notes'. Gebruiker B mag die KB lezen maar heeft M nooit mogen
    // openen. Zonder de zeef kreeg B een rij met `transcriptionId = M` en
    // `createdBy = B` — en A kreeg er een regel bij op haar uitvoerbalk plus
    // een extra 409-reden bij het verwijderen van haar eigen vergadering.
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
    // De keerzijde: iemand die zijn eigen kennisbank dupliceert houdt de link
    // naar zijn eigen vergadering — anders is de zeef een functieverlies.
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

/**
 * GET /api/transcriptions/:id/usage and the DELETE guard that reads it (M2).
 *
 * The list answers "what happens to this meeting" on three surfaces, and the
 * one that can do damage is the delete. So the cases that matter here are the
 * refusals:
 *
 *   - a scan that could not run must produce a 409, not a deletion. If a
 *     derivation failure quietly became an empty list, the guard would
 *     disappear exactly when it is least able to say so, and a meeting three
 *     things depend on would be gone;
 *   - somebody else's automation may be COUNTED but not NAMED, or a shared
 *     meeting becomes a way to enumerate an organisation;
 *   - a meeting outside the caller's reach answers 404, the same as every
 *     other route on that id, so this one cannot be used to probe for ids.
 *
 * Drives the REAL composed router with a require-cache-stubbed database —
 * the same harness as transcriptions.payload.test.js. No HTTP, no DB.
 *
 * Run: cd server && node --test --test-force-exit routes/transcriptions.usage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

let storedNote = null;
let deleteCalls = [];
/** What the fake pool answers, per scan. Reset in each test. */
let plan = {};
/** Recordings for the unfile path (DELETE /:id/filed-lines). */
let removedSources = [];
let chunkDeletes = [];
let kbDocuments = [];
/** Document-ids waarop de chunk-opruiming weigert (search-service plat, rij vast). */
let failChunkDeleteOn = new Set();

function poolQuery(sql, params) {
    if (/to_regclass\(\$1\) AS t/.test(sql)) {
        const present = plan.tables || ['kb_sources', 'knowledge_bases', 'automations', 'notebook_sources', 'notebooks'];
        return Promise.resolve({ rows: [{ t: present.includes(params[0]) ? params[0] : null }] });
    }
    if (/pg_attribute/.test(sql)) {
        const cols = plan.columns || ['notebook_sources.source_ref_id'];
        return Promise.resolve({ rows: cols.includes(`${params[0]}.${params[1]}`) ? [{ ok: 1 }] : [] });
    }
    if (/FROM kb_sources/.test(sql)) {
        if (plan.failKb) return Promise.reject(new Error('kb_sources is down'));
        // A source that the clean-up path has removed no longer exists, so the
        // scan may not see it either. Without this line a route that deletes NOTHING would still look as if it had succeeded.
        return Promise.resolve({ rows: (plan.kb || []).filter(r => !removedSources.includes(r.source_id)) });
    }
    if (/FROM automations/.test(sql)) return Promise.resolve({ rows: plan.automations || [] });
    if (/source_ref_id IS NULL/.test(sql)) return Promise.resolve({ rows: plan.legacyNotebooks ? [{ ok: 1 }] : [] });
    if (/FROM notebook_sources/.test(sql)) return Promise.resolve({ rows: plan.notebooks || [] });
    return Promise.reject(new Error(`unexpected query: ${sql}`));
}

stub('../auth/permissions', { requireAuth: (req, res, next) => next() });
stub('../auth', { resolveUserOrgIds: async () => new Set(['org-1']) });
stub('../stores/userStore', { getUser: async () => ({ groups: [] }), getAllGroups: async () => [] });
stub('../stores/summaryTemplateStore', { resolveDefaultPrompt: async () => null, resolveDefaultTemplate: async () => null });
stub('../stores/configStore', { getConfig: async () => null, getSecret: async () => null });
stub('../stores/storageStore', { isAvailable: () => false, getStatus: () => ({ configured: false }) });
stub('../core/llm/llmClient', {});
stub('../core/meetingNotes/talkNotesSettings', { getOrgSettings: async () => ({}) });
stub('../stores/transcriptionStore', {
    getTranscription: async (id) => (storedNote && storedNote.id === id ? { ...storedNote } : null),
    deleteTranscription: async (id, userId) => { deleteCalls.push({ id, userId }); return true; },
    updateTranscription: async () => ({}),
    timeoutStuckTranscriptions: async () => 0,
});
stub('../db', {
    getAll: async () => [], getOne: async () => null, run: async () => ({ rowCount: 1 }), exec: async () => {},
    pool: { query: poolQuery },
});
// The clean-up path touches the knowledge-base side: documents off, chunks off,
// source away. All three are recorders — there is no knowledge base and no
// search service here.
stub('../stores/knowledgeBases', {
    // The `limit` is REALLY applied here: the cleanup loop asks for one page per round, and a double that returns everything in one go would make a route without a loop look just as good as a route with one.
    listDocuments: async (kbId, opts = {}) => {
        const rows = kbDocuments.filter(d => d.kbId === kbId && d.sourceId === (opts.filters || {}).sourceId);
        return opts.limit ? rows.slice(0, opts.limit) : rows;
    },
});
stub('../stores/kbSources', {
    remove: async (id) => { removedSources.push(id); return true; },
});
stub('../core/kb/kbIngestionHelpers', {
    // Just like the real one: the document row goes away too, so the next round no longer sees it. Without that, a broken loop would keep running instead of turning red.
    deleteDocumentChunks: async (kbId, docId, tenantId, opts) => {
        chunkDeletes.push({ kbId, docId, tenantId, opts });
        if (failChunkDeleteOn.has(docId)) throw new Error(`search-service refused ${docId}`);
        kbDocuments = kbDocuments.filter(d => d.id !== docId);
    },
});

const router = require('./transcriptions');

// Errors are answered the way index.js answers them: by the terminal handler.
const answerError = require('../core/http/terminalErrorHandler')
    .createTerminalErrorHandler({ log: { error() {}, warn() {} } });

function dispatch({ method = 'GET', url, user = 'owner-1' }) {
    return new Promise((resolve, reject) => {
        const [pathname, search] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search || '')) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, headers: {}, body: {},
            session: { isAuthenticated: true, user: { id: user } },
            get(n) { return this.headers[String(n).toLowerCase()]; },
            setTimeout() {},
        };
        const res = {
            statusCode: 200, headers: {}, body: undefined,
            set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setTimeout() {},
        };
        router(req, res, (err) => (err
            ? answerError(err, req, res, reject)
            : reject(new Error(`fell through: ${method} ${url}`))));
    });
}

const KB_ROW = { source_id: 's1', kind: 'meeting_tag', config: { tag: 'sales' }, last_at: '2026-08-01T00:00:00Z', kb_id: 'kb-1', kb_name: 'Sales', owner_id: 'owner-1' };

function note(over = {}) {
    storedNote = { id: 'm-1', title: 'Weekly sync', tags: ['sales'], ownerId: 'owner-1', organizationId: 'org-1', isOwner: true, ...over };
    return storedNote;
}

test.beforeEach(() => { plan = {}; deleteCalls = []; storedNote = null; removedSources = []; chunkDeletes = []; kbDocuments = []; failChunkDeleteOn = new Set(); });

// ── GET /:id/usage ──────────────────────────────────────────────────

test('answers { usage, unchecked } in the Used-by row shape', async () => {
    note();
    plan.kb = [KB_ROW];
    const res = await dispatch({ url: '/m-1/usage' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.unchecked, []);
    assert.deepStrictEqual(res.body.usage, [{
        kind: 'kb', id: 'kb-1', title: 'Sales', role: 'contains',
        siteLabel: 'sales', lastAt: '2026-08-01T00:00:00Z', ownerId: 'owner-1',
    }]);
});

test('a meeting the caller may not read is 404, not 403', async () => {
    note({ id: 'someone-elses' });
    const res = await dispatch({ url: '/m-1/usage' });
    assert.strictEqual(res.statusCode, 404);
});

test('a kind that could not be checked is named in `unchecked`, never dropped', async () => {
    note();
    plan.failKb = true;
    const res = await dispatch({ url: '/m-1/usage' });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body.unchecked.includes('kb'));
    assert.deepStrictEqual(res.body.usage, []);
});

test('somebody else’s row is counted but not named', async () => {
    note();
    plan.kb = [{ ...KB_ROW, kb_name: 'Board minutes', owner_id: 'someone-else' }];
    const res = await dispatch({ url: '/m-1/usage' });
    assert.strictEqual(res.body.usage.length, 1);
    assert.strictEqual(res.body.usage[0].title, null);
    assert.strictEqual(res.body.usage[0].foreign, true);
    assert.strictEqual(res.body.usage[0].kind, 'kb', 'the kind survives — that is what "what would break" needs');
});

// ── DELETE /:id ─────────────────────────────────────────────────────

test('deletes when nothing uses the meeting and nothing was unanswerable', async () => {
    note();
    const res = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(deleteCalls, [{ id: 'm-1', userId: 'owner-1' }]);
});

test('refuses with 409 in_use and the list when something uses it', async () => {
    note();
    plan.kb = [KB_ROW];
    const res = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'in_use');
    assert.strictEqual(res.body.usage.length, 1);
    assert.deepStrictEqual(res.body.unchecked, []);
    assert.deepStrictEqual(deleteCalls, [], 'nothing may be deleted behind a 409');
});

test('A SCAN THAT COULD NOT RUN STILL GUARDS THE DELETE', async () => {
    // The fail-open this whole module exists to prevent: if a broken scan came
    // back as an empty list, the 409 would vanish at exactly the moment the
    // server cannot say what depends on this meeting.
    note();
    plan.failKb = true;
    const res = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'in_use');
    assert.deepStrictEqual(res.body.usage, []);
    assert.deepStrictEqual(res.body.unchecked, ['kb']);
    assert.deepStrictEqual(deleteCalls, []);
});

test('a missing notebook link column is enough on its own to hold the delete', async () => {
    // Today's real state: source_ref_id has not landed, so no notebook answer
    // is possible and every delete goes through the confirmed path.
    note();
    plan.columns = [];
    const res = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(res.body.unchecked, ['notebook']);
});

test('?confirm=1 is the way past, and it is the ONLY way past', async () => {
    note();
    plan.kb = [KB_ROW];
    plan.failKb = false;
    for (const q of ['?confirm=1', '?confirm=true']) {
        deleteCalls = [];
        const res = await dispatch({ method: 'DELETE', url: `/m-1${q}` });
        assert.strictEqual(res.statusCode, 200, q);
        assert.strictEqual(deleteCalls.length, 1, q);
    }
    // An explicit "no" is still the 409 with the usage list; a spelling the
    // request schema does not know is a 400 that NAMES it. Both refuse, and
    // neither deletes — what must never happen is a third outcome where a
    // word nobody recognises quietly counts as a yes.
    for (const q of ['?confirm=0']) {
        deleteCalls = [];
        const res = await dispatch({ method: 'DELETE', url: `/m-1${q}` });
        assert.strictEqual(res.statusCode, 409, `${q} must not be read as a confirmation`);
        assert.deepStrictEqual(deleteCalls, [], q);
    }
    for (const q of ['?confirm=yes', '?confirmed=1', '?confirm=']) {
        deleteCalls = [];
        const res = await dispatch({ method: 'DELETE', url: `/m-1${q}` });
        assert.strictEqual(res.statusCode, 400, `${q} must not be read as a confirmation`);
        assert.deepStrictEqual(deleteCalls, [], q);
    }
});

test('the 409 payload redacts foreign names too', async () => {
    note();
    plan.kb = [{ ...KB_ROW, kb_name: 'Board minutes', owner_id: 'someone-else' }];
    const res = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.usage[0].title, null);
});

test('deleting a meeting the caller may not read is 404 before any scan runs', async () => {
    note({ id: 'other' });
    const res = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(deleteCalls, []);
});

test('the confirmed path still refuses a meeting the store will not delete', async () => {
    // ?confirm=1 skips the usage check, not the ownership check the store does.
    note();
    const store = require('../stores/transcriptionStore');
    const original = store.deleteTranscription;
    store.deleteTranscription = async () => false;
    try {
        const res = await dispatch({ method: 'DELETE', url: '/m-1?confirm=1' });
        assert.strictEqual(res.statusCode, 404);
    } finally {
        store.deleteTranscription = original;
    }
});

// ── DELETE /:id/filed-lines ─────────────────────────────────────────

/**
 * ── A WRONGLY LANDED RULE MUST BE REMOVABLE (M4) ────────────────────
 * The write gate in routes/knowledgeBases/sources.js has refused a made-up
 * `metadata.transcriptionId` since M4, but rows that already exist because of an
 * older bug stay in place: on three screens they claim that this meeting sits in
 * a knowledge base the owner may not see, and they keep the delete gate of that
 * meeting at 409. The knowledge base belongs to someone else, so DELETE
 * /api/kb/:id/sources/:sid is no way out for the victim. This route is one: whoever
 * OWNS the meeting may remove what claims to come from it.
 */
test('the owner of the meeting can remove a line that landed on it wrongly', async () => {
    note();
    // Een gefileerde regel in de kennisbank van iemand anders.
    plan.kb = [{ source_id: 'src-forged', kb_id: 'kb-attacker', owner_id: 'attacker', kind: 'text' }];
    kbDocuments = [{ kbId: 'kb-attacker', sourceId: 'src-forged', id: 'doc-1' }];

    const res = await dispatch({ method: 'DELETE', url: '/m-1/filed-lines' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.removedLines, 1);
    assert.deepStrictEqual(res.body.errors, []);
    assert.deepStrictEqual(removedSources, ['src-forged'], 'the source itself is gone');
    // De chunks eerst: een verwijderde regel die de zoekdienst blijft
    // beantwoorden is in een privacyproduct de bug.
    assert.deepStrictEqual(chunkDeletes, [
        { kbId: 'kb-attacker', docId: 'doc-1', tenantId: 'attacker', opts: { skipSnapshot: true } },
    ]);
});

test('and after that the delete guard lets the meeting go', async () => {
    note();
    plan.kb = [{ source_id: 'src-forged', kb_id: 'kb-attacker', owner_id: 'attacker', kind: 'text' }];
    const blocked = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(blocked.statusCode, 409, 'the forged row holds the delete');

    await dispatch({ method: 'DELETE', url: '/m-1/filed-lines' });
    // plan.kb is NOT emptied by hand: the fake pool drops removed sources itself, so this measures whether anything really disappeared.
    const res = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(deleteCalls, [{ id: 'm-1', userId: 'owner-1' }]);
});

test('a reader who is not the owner may not empty someone else’s knowledge base', async () => {
    // Shared reading is not ownership. Cleaning up a knowledge base of someone else is a power of exactly one person: whoever owns the meeting the rule claims to come from.
    note({ isOwner: false, ownerId: 'someone-else' });
    plan.kb = [{ source_id: 'src-forged', kb_id: 'kb-attacker', owner_id: 'attacker', kind: 'text' }];
    const res = await dispatch({ method: 'DELETE', url: '/m-1/filed-lines' });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(removedSources, []);
    assert.deepStrictEqual(chunkDeletes, []);
});

test('a meeting the caller may not read is 404, and nothing is touched', async () => {
    note({ id: 'other' });
    plan.kb = [{ source_id: 'src-forged', kb_id: 'kb-attacker', owner_id: 'attacker', kind: 'text' }];
    const res = await dispatch({ method: 'DELETE', url: '/m-1/filed-lines' });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(removedSources, []);
});

test('a line that would not come off is REPORTED, never counted as removed', async () => {
    // Fail-closed in the same way as the scan: "I could not remove this" is a different sentence from "there was nothing", and only the first must keep the owner from assuming that he is clean.
    note();
    plan.kb = [{ source_id: 'src-forged', kb_id: 'kb-attacker', owner_id: 'attacker', kind: 'text' }];
    const store = require('../stores/kbSources');
    const original = store.remove;
    store.remove = async () => { throw new Error('kb_sources is down'); };
    try {
        const res = await dispatch({ method: 'DELETE', url: '/m-1/filed-lines' });
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.body.removedLines, 0);
        assert.strictEqual(res.body.errors.length, 1);
        assert.strictEqual(res.body.errors[0].sourceId, 'src-forged');
    } finally {
        store.remove = original;
    }
});

/**
 * ── A SOURCE WITH MORE THAN 200 DOCUMENTS (M5) ──────────────────────
 *
 * A `text` source does not hold one document. `POST /api/kb/:id/ingest/text`
 * looks up the existing text source via `ensureKbSource` with
 * `config @> { title: 'Text snippet' }` and attaches a NEW document to it EVERY time
 * (routes/knowledgeBases/ingest.js). A filed rule that was created with the
 * default title therefore collects documents without limit.
 *
 * This path fetched one page of 200 and then deleted the source row
 * unconditionally. `documents.source_id` cascades, so everything beyond those 200
 * went along WITHOUT ever having passed `deleteDocumentChunks`: out of sight,
 * but with live embeddings in the search service. The user deleted and the text
 * is still findable — in a privacy product that IS the bug.
 */
test('MEER DAN 200 DOCUMENTEN: alle chunks gaan eraf, niet alleen de eerste pagina', async () => {
    note();
    plan.kb = [{ source_id: 'src-forged', kb_id: 'kb-attacker', owner_id: 'attacker', kind: 'text' }];
    kbDocuments = Array.from({ length: 201 }, (_, i) => ({
        kbId: 'kb-attacker', sourceId: 'src-forged', id: `doc-${i + 1}`,
    }));

    const res = await dispatch({ method: 'DELETE', url: '/m-1/filed-lines' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.errors, []);
    assert.strictEqual(res.body.removedLines, 1);
    assert.strictEqual(res.body.removedDocuments, 201);
    assert.strictEqual(chunkDeletes.length, 201, 'elk document is langs de chunk-opruiming geweest');
    assert.ok(chunkDeletes.some(c => c.docId === 'doc-201'),
        'juist de 201e is het document dat vroeger via de FK-cascade verdween met zijn embeddings erin');
    assert.deepStrictEqual(kbDocuments, []);
    assert.deepStrictEqual(removedSources, ['src-forged'], 'en pas dán valt de bron');
});

test('EEN OPRUIMING DIE HALVERWEGE VASTLOOPT MELDT GEEN SUCCES — en laat de bron staan', async () => {
    // Silently half-deleting is the same mistake in another guise: if the source row did fall, the FK would cascade the remaining document away, and exactly those embeddings would stay searchable forever.
    note();
    plan.kb = [{ source_id: 'src-forged', kb_id: 'kb-attacker', owner_id: 'attacker', kind: 'text' }];
    kbDocuments = Array.from({ length: 250 }, (_, i) => ({
        kbId: 'kb-attacker', sourceId: 'src-forged', id: `doc-${i + 1}`,
    }));
    failChunkDeleteOn = new Set(['doc-150']);

    const res = await dispatch({ method: 'DELETE', url: '/m-1/filed-lines' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.removedLines, 0, 'niets mag als verwijderde regel worden geteld');
    assert.strictEqual(res.body.errors.length, 1);
    assert.strictEqual(res.body.errors[0].sourceId, 'src-forged');
    assert.ok(res.body.errors[0].documents.some(d => d.documentId === 'doc-150'),
        'het document dat bleef staan wordt bij naam genoemd');
    assert.deepStrictEqual(removedSources, [], 'DE BRON BLIJFT STAAN zolang er documenten met chunks aan hangen');
    assert.deepStrictEqual(kbDocuments.map(d => d.id), ['doc-150']);
    // And the most severe possible consequence: the meeting still counts as in use, so the owner gets no clean notice but a 409.
    const still = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(still.statusCode, 409);
    assert.strictEqual(still.body.code, 'in_use');
    assert.deepStrictEqual(deleteCalls, []);
});

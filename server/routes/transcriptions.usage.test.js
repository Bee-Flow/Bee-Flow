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
 *   - somebody else's routine may be COUNTED but not NAMED, or a shared
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
        // Een bron die het opruimpad heeft weggehaald bestaat niet meer, dus de
        // scan mag hem ook niet meer zien. Zonder deze regel zou een route die
        // NIETS verwijdert er toch uitzien alsof het gelukt is.
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
// Het opruimpad raakt de kennisbank-kant aan: documenten eraf, chunks eraf,
// bron weg. Alle drie zijn recorders — er is hier geen kennisbank en geen
// zoekdienst.
stub('../stores/knowledgeBases', {
    // De `limit` wordt hier ECHT toegepast: de opruimlus vraagt per ronde een
    // pagina op, en een dubbel die alles in één keer teruggeeft zou een route
    // zonder lus er precies zo goed uit laten zien als een route mét.
    listDocuments: async (kbId, opts = {}) => {
        const rows = kbDocuments.filter(d => d.kbId === kbId && d.sourceId === (opts.filters || {}).sourceId);
        return opts.limit ? rows.slice(0, opts.limit) : rows;
    },
});
stub('../stores/kbSources', {
    remove: async (id) => { removedSources.push(id); return true; },
});
stub('../core/kb/kbIngestionHelpers', {
    // Net als de echte: de documentrij gaat mee weg, dus de volgende ronde
    // ziet hem niet meer. Zonder dat zou een kapotte lus blijven draaien in
    // plaats van rood te worden.
    deleteDocumentChunks: async (kbId, docId, tenantId, opts) => {
        chunkDeletes.push({ kbId, docId, tenantId, opts });
        if (failChunkDeleteOn.has(docId)) throw new Error(`search-service refused ${docId}`);
        kbDocuments = kbDocuments.filter(d => d.id !== docId);
    },
});

const router = require('./transcriptions');

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
        router(req, res, (err) => reject(err || new Error(`fell through: ${method} ${url}`)));
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
 * ── EEN REGEL DIE VERKEERD GELAND IS, MOET WEG KUNNEN (M4) ──────────
 * De schrijfpoort in routes/knowledgeBases/sources.js weigert sinds M4 een
 * verzonnen `metadata.transcriptionId`, maar rijen die er door een oudere bug
 * al staan blijven staan: ze beweren op drie schermen dat deze vergadering in
 * een kennisbank zit die de eigenaar niet mag zien, en ze houden de
 * verwijderpoort van die vergadering op 409. De kennisbank is van iemand
 * anders, dus DELETE /api/kb/:id/sources/:sid is voor het slachtoffer geen
 * uitweg. Deze route is dat wel: wie de vergadering BEZIT mag weghalen wat
 * beweert eruit te komen.
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
    // plan.kb wordt NIET met de hand leeggemaakt: de nep-pool laat weggehaalde
    // bronnen zelf vallen, dus dit meet of er echt iets is verdwenen.
    const res = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(deleteCalls, [{ id: 'm-1', userId: 'owner-1' }]);
});

test('a reader who is not the owner may not empty someone else’s knowledge base', async () => {
    // Gedeeld lezen is geen eigendom. Het opruimen van een kennisbank van een
    // ander is een bevoegdheid van precies één persoon: wie de vergadering
    // bezit waar de regel beweert uit te komen.
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
    // Fail-closed op dezelfde manier als de scan: "ik kon dit niet weghalen" is
    // een andere zin dan "er stond niets", en alleen op de eerste mag de
    // eigenaar niet in de veronderstelling blijven dat hij schoon is.
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
 * ── EEN BRON MET MEER DAN 200 DOCUMENTEN (M5) ───────────────────────
 *
 * Een `text`-bron houdt niet één document. `POST /api/kb/:id/ingest/text`
 * zoekt via `ensureKbSource` de bestaande text-bron op met
 * `config @> { title: 'Text snippet' }` en hangt er élke keer een NIEUW
 * document aan (routes/knowledgeBases/ingest.js). Een gefileerde regel die met
 * de standaardtitel is aangemaakt verzamelt zo onbeperkt documenten.
 *
 * Dit pad haalde één pagina van 200 op en verwijderde daarna onvoorwaardelijk
 * de bronrij. `documents.source_id` cascadeert, dus alles voorbij die 200 ging
 * mee zónder ooit langs `deleteDocumentChunks` te zijn geweest: uit beeld,
 * maar met levende embeddings in de search-service. De gebruiker heeft
 * verwijderd en de tekst is nog vindbaar — in een privacyproduct is dat DE bug.
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
    // Stil half verwijderen is dezelfde fout in een ander jasje: viel de
    // bronrij tóch, dan cascadeerde de FK het overgebleven document weg en
    // bleven juist díe embeddings voor altijd doorzoekbaar.
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
    // En het luidst mogelijke gevolg: de vergadering geldt nog steeds als in
    // gebruik, dus de eigenaar krijgt geen schone melding maar een 409.
    const still = await dispatch({ method: 'DELETE', url: '/m-1' });
    assert.strictEqual(still.statusCode, 409);
    assert.strictEqual(still.body.code, 'in_use');
    assert.deepStrictEqual(deleteCalls, []);
});

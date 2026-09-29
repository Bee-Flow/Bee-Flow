/**
 * Where the privacy screen sits inside the ingest, and what that ordering
 * buys.
 *
 * The single most important assertion in this file is that the hash is taken
 * of the REDACTED text. Hash-then-redact would fingerprint a string that is
 * never written anywhere, so the same file uploaded twice would produce two
 * rows carrying one hash and two different bodies — and dedup, which is the
 * thing the hash exists for, would be answering about a document that does
 * not exist.
 *
 * The second is that redaction is one-way. `original_content` IS the redacted
 * text; there is no copy of the original to restore from, which is the design
 * rather than a limitation, and a test is the only place that stays true.
 *
 * Run: node --test --test-force-exit core/kb/kbIngestionHelpers.privacy.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const RAW = 'Quote for Jan Jansen, jan@example.com. Valid 30 days. Payment within 30 days of invoice.';
const REDACTED = 'Quote for [person_1], [email_1]. Valid 30 days. Payment within 30 days of invoice.';

// The shield is stubbed at the module boundary: this file is about the ORDER
// of operations inside ingestDocument, and ingestPrivacy's own vocabulary is
// pinned by ingestPrivacy.test.js.
let verdict = null;
const SHIELD_ID = 'mock:kb-ingest:ingestPrivacy';
require.cache[SHIELD_ID] = {
    id: SHIELD_ID, filename: SHIELD_ID, loaded: true,
    exports: {
        applyShield: async () => verdict,
        OUTCOME: { PASS: 'pass', REDACTED: 'redacted', SKIPPED: 'skipped' },
    },
};

// What the embedder was handed — the ONLY other place the text goes, and the
// one that ends up in `original_content` and in every chunk.
const embedded = [];
const LOCAL_ID = 'mock:kb-ingest:localKBIngest';
require.cache[LOCAL_ID] = {
    id: LOCAL_ID, filename: LOCAL_ID, loaded: true,
    exports: {
        ingestLocally: async (tenantId, kbId, docId, content) => {
            embedded.push({ docId, content });
            return { chunks_created: 2 };
        },
        deleteChunksLocally: async () => {},
    },
};
// No database here, and `getAzureIngestParams` reads config on the way into
// the embedder — an unstubbed read throws and the embed never happens, which
// would make the assertions below pass vacuously.
const CONFIG_ID = 'mock:kb-ingest:configStore';
require.cache[CONFIG_ID] = {
    id: CONFIG_ID, filename: CONFIG_ID, loaded: true,
    exports: { getConfig: async () => null, getSecret: async () => null },
};
const PROVIDER_ID = 'mock:kb-ingest:resolveProvider';
require.cache[PROVIDER_ID] = {
    id: PROVIDER_ID, filename: PROVIDER_ID, loaded: true,
    exports: { resolveKbProvider: async () => 'local' },
};

const created = [];
const STORE_ID = 'mock:kb-ingest:store';
require.cache[STORE_ID] = {
    id: STORE_ID, filename: STORE_ID, loaded: true,
    exports: {
        hashContent: (text) => `hash(${text})`,
        simhash: () => 'simhash',
        createDocument: async (tenantId, kbId, title, sourceType, sourceUri, contentHash, chunks, metadata, simhash, extra) => {
            const doc = { id: `d${created.length + 1}`, title, contentHash, chunks, ...extra };
            created.push(doc);
            return doc;
        },
        findDocumentByContentHash: async () => null,
        findNearDuplicateBySimhash: async () => null,
        updateChunkCount: async () => {},
        bumpKBVersion: async () => {},
        getKB: async () => ({ id: 'kb1', tenant_id: 't1' }),
        listDocuments: async () => [],
    },
};

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /kbIngestionHelpers\.js$/.test(parent.filename)) {
        if (request === './ingestPrivacy') return SHIELD_ID;
        if (request === '../../stores/knowledgeBases') return STORE_ID;
        if (request === './localKBIngest') return LOCAL_ID;
        if (request === './resolveProvider') return PROVIDER_ID;
        if (request === '../../stores/configStore') return CONFIG_ID;
    }
    return originalResolve.call(this, request, parent, ...rest);
};
test.after(() => { Module._resolveFilename = originalResolve; });

const helpers = require('./kbIngestionHelpers');

function reset() { created.length = 0; embedded.length = 0; verdict = null; }

test('the content hash is taken of the REDACTED text, not the original', async () => {
    reset();
    verdict = { outcome: 'redacted', text: REDACTED, piiStatus: 'redacted', piiCategories: ['Person', 'Email'], reason: null };
    await helpers.ingestDocument('t1', 'kb1', RAW, 'Quote.pdf', 'upload', null, {
        privacy: { orgId: 'o1', userId: 'u1' }, skipDedup: true,
    }).catch(() => {});
    // createDocument's 6th positional argument IS the hash, so the mock
    // records it directly: `hash(<text>)` names the text it fingerprinted.
    assert.strictEqual(created.length, 1, 'a document row was written');
    assert.strictEqual(created[0].contentHash, `hash(${REDACTED})`);
});

test('what is stored is the redacted text — the original is not kept anywhere', async () => {
    reset();
    verdict = { outcome: 'redacted', text: REDACTED, piiStatus: 'redacted', piiCategories: ['Person'], reason: null };
    await helpers.ingestDocument('t1', 'kb1', RAW, 'Quote.pdf', 'upload', null, {
        privacy: { orgId: 'o1' }, skipDedup: true,
    }).catch(() => {});
    const written = JSON.stringify({ created, embedded });
    assert.ok(!written.includes('Jan Jansen'), 'no name in the row or the chunks');
    assert.ok(!written.includes('jan@example.com'), 'no address in the row or the chunks');
    assert.strictEqual(embedded[0].content, REDACTED, 'the embedder saw only the redacted text');
});

test('a redacted document is stored with the status and the categories that say so', async () => {
    reset();
    verdict = { outcome: 'redacted', text: REDACTED, piiStatus: 'redacted', piiCategories: ['Person', 'Email'], reason: null };
    await helpers.ingestDocument('t1', 'kb1', RAW, 'Quote.pdf', 'upload', null, {
        privacy: { orgId: 'o1' }, skipDedup: true,
    }).catch(() => {});
    assert.strictEqual(created[0].piiStatus, 'redacted');
    assert.deepStrictEqual(created[0].piiCategories, ['Person', 'Email']);
});

test('a blocked document leaves a ROW with a reason, never a missing file', async () => {
    // This is the failure K1 removed: a document that could not be stored used
    // to be deleted on the way out, so a folder of 38 became a KB of 37 with
    // nothing anywhere saying which one went missing or why.
    reset();
    verdict = {
        outcome: 'skipped', text: null, piiStatus: 'found', piiCategories: ['IBAN'],
        reason: 'Contains personal data (IBAN) and this organisation does not store it',
    };
    const r = await helpers.ingestDocument('t1', 'kb1', RAW, 'Quote.pdf', 'upload', null, {
        privacy: { orgId: 'o1' }, skipDedup: true,
    });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(created.length, 1, 'the row exists');
    assert.strictEqual(created[0].status, 'skipped');
    assert.match(created[0].statusReason, /IBAN/);
    assert.strictEqual(created[0].contentHash, null, 'no fingerprint of content that was not stored');
    assert.strictEqual(embedded.length, 0, 'and nothing was embedded');
});

test('an unscanned document is stored, and marked unscanned rather than clean', async () => {
    reset();
    verdict = { outcome: 'pass', text: RAW, piiStatus: 'unscanned', piiCategories: null, reason: 'Personal-data detection is not installed' };
    await helpers.ingestDocument('t1', 'kb1', RAW, 'Quote.pdf', 'upload', null, {
        privacy: { orgId: 'o1' }, skipDedup: true,
    }).catch(() => {});
    assert.strictEqual(created[0].piiStatus, 'unscanned');
    assert.strictEqual(embedded[0].content, RAW, 'nothing was removed, because nothing was checked');
});

test('without a privacy option the shield does not run at all', async () => {
    // The notebook and webpage source ingests scan with their own policy and
    // deliberately keep the real text. Redacting underneath them would change
    // what those features store without anybody asking.
    reset();
    verdict = { outcome: 'redacted', text: REDACTED, piiStatus: 'redacted', piiCategories: ['Person'], reason: null };
    await helpers.ingestDocument('t1', 'kb1', RAW, 'Quote.pdf', 'upload', null, { skipDedup: true }).catch(() => {});
    assert.strictEqual(embedded[0].content, RAW, 'the text is untouched');
    assert.notStrictEqual(created[0].piiStatus, 'redacted');
});

test('an explicit privacy:null is the same as not asking', async () => {
    reset();
    verdict = { outcome: 'redacted', text: REDACTED, piiStatus: 'redacted', piiCategories: ['Person'], reason: null };
    await helpers.ingestDocument('t1', 'kb1', RAW, 'Quote.pdf', 'upload', null, {
        privacy: null, skipDedup: true,
    }).catch(() => {});
    assert.strictEqual(embedded[0].content, RAW);
});

test('the stored size is the size of what was stored', async () => {
    // sizeBytes is computed from `content`; redaction changes its length, and
    // a row claiming the original's size would misreport every shielded file.
    reset();
    verdict = { outcome: 'redacted', text: REDACTED, piiStatus: 'redacted', piiCategories: [], reason: null };
    await helpers.ingestDocument('t1', 'kb1', RAW, 'Quote.pdf', 'upload', null, {
        privacy: { orgId: 'o1' }, skipDedup: true,
    }).catch(() => {});
    assert.strictEqual(created[0].sizeBytes, Buffer.byteLength(REDACTED, 'utf8'));
});

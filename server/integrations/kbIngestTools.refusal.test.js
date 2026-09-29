/**
 * A refused write must not destroy the article it was replacing.
 *
 * `_refreshInPlace` DELETES the existing document — with `skipSnapshot`, so
 * there is no version to restore — and ingests second. That ordering is only
 * safe while nothing in between can refuse. K10 put the privacy screen inside
 * that ingest, and the screen CAN refuse: for an org set to `block`, and for
 * any incomplete scan under the DEFAULT fail-closed mode. So a guard service
 * degraded for a minute destroyed a handbook article a routine had been
 * maintaining for months, and left an empty `skipped` row in its place.
 *
 * These are BEHAVIOURAL, not source scans. The sibling file
 * kbIngestTools.shield.test.js pins the wiring by reading the source, and a
 * source scan cannot catch a logic inversion — flipping the guard to
 * `if (false && …)` left every one of those assertions green. This file calls
 * the real `executeKbIngestTool` with the store stubbed and asserts what
 * actually happened to the document.
 *
 * Run: cd server && node --test --test-force-exit integrations/kbIngestTools.refusal.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const ID = (m) => require.resolve(m);

/** Swap a module in the require cache for the duration of `fn`. */
function withModules(mods, fn) {
    const saved = new Map();
    for (const [spec, exports] of Object.entries(mods)) {
        const id = ID(spec);
        saved.set(id, require.cache[id]);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    // The tool itself must be re-required so it picks the stubs up lazily.
    const toolId = ID('./kbIngestTools');
    const savedTool = require.cache[toolId];
    delete require.cache[toolId];
    return (async () => {
        try {
            return await fn(require('./kbIngestTools'));
        } finally {
            for (const [id, mod] of saved) { if (mod) require.cache[id] = mod; else delete require.cache[id]; }
            if (savedTool) require.cache[toolId] = savedTool; else delete require.cache[toolId];
        }
    })();
}

const KB = { id: 'kb1', name: 'Handbook', tenant_id: 'org1', organization_id: 'org1' };
const EXISTING = { id: 'doc-old', source_uri: 'ticket:42', source_id: 'src1', metadata: { article: 'the article somebody has been maintaining' } };
const CTX = { orgId: 'org1', userId: 'u1', automationId: 'a1', origin: 'routine' };
const ARGS = { knowledgeBaseId: 'kb1', title: 'How to reset', content: 'fresh text', sourceUri: 'ticket:42' };

/** Records every destructive call, so a test can assert none happened. */
function stubs({ shieldOutcome = 'pass' }) {
    const calls = { deleted: [], ingested: [] };
    return {
        calls,
        mods: {
            '../stores/knowledgeBases': {
                getKB: async () => KB,
                isSystemKB: () => false,
                canUserManageKB: () => true,
            },
            '../core/kb/kbWriteAccess': {
                canOwnerWriteToKb: async () => ({ ok: true, kb: KB }),
                messageFor: (r) => 'refused:' + r,
            },
            '../core/kb/ingestPrivacy': {
                OUTCOME: { PASS: 'pass', REDACTED: 'redacted', SKIPPED: 'skipped' },
                applyShield: async ({ text }) => (shieldOutcome === 'skipped'
                    ? { outcome: 'skipped', text: null, piiStatus: 'found', reason: 'Held: this text contains personal data.' }
                    : { outcome: 'pass', text, piiStatus: 'none', piiCategories: null }),
            },
            '../core/kb/kbIngestionHelpers': {
                findDocumentBySourceUri: async () => EXISTING,
                deleteDocumentChunks: async (kbId, docId) => { calls.deleted.push(docId); },
                ingestDocument: async (tenant, kbId, body) => {
                    calls.ingested.push(body);
                    return { document: { id: 'doc-new' }, chunks: 3, status: 'processed' };
                },
            },
        },
    };
}

test('a shield refusal destroys NOTHING — the existing article survives', async () => {
    const { calls, mods } = stubs({ shieldOutcome: 'skipped' });
    const res = await withModules(mods, (tool) => tool.executeKbIngestTool('knowledge_base_ingest', ARGS, CTX));

    assert.deepStrictEqual(calls.deleted, [], 'the existing document must not be deleted');
    assert.deepStrictEqual(calls.ingested, [], 'and nothing is stored in its place');
    assert.ok(res.error, 'the caller is told, so the step goes amber with the reason');
    assert.match(res.error, /personal data/);
    assert.ok(!res.ok, 'a refusal is never reported as a successful write');
});

test('an allowed write still refreshes in place, exactly as before', async () => {
    const { calls, mods } = stubs({ shieldOutcome: 'pass' });
    const res = await withModules(mods, (tool) => tool.executeKbIngestTool('knowledge_base_ingest', ARGS, CTX));

    assert.deepStrictEqual(calls.deleted, ['doc-old'], 'the old row is replaced by its own source');
    assert.deepStrictEqual(calls.ingested, ['fresh text'], 'with the screened text');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.refreshed, true);
    assert.strictEqual(res.documentId, 'doc-new');
});

test('an ingest that reports `skipped` is not reported as a written document', async () => {
    // ingestDocument REPORTS a refusal rather than throwing: a content-less row
    // comes back with status 'skipped'. Reading only document.id turned that
    // into a green step claiming a write against a document holding nothing.
    const { calls, mods } = stubs({ shieldOutcome: 'pass' });
    mods['../core/kb/kbIngestionHelpers'].ingestDocument = async (t, k, body) => {
        calls.ingested.push(body);
        return { document: { id: 'doc-empty' }, chunks: 0, status: 'skipped', error: 'Held by policy.' };
    };
    const res = await withModules(mods, (tool) => tool.executeKbIngestTool('knowledge_base_ingest', ARGS, CTX));
    assert.ok(res.error, 'reported as an error, not a write');
    assert.ok(!res.ok);
});

test('the screen runs once — the ingest is never asked to screen again', async () => {
    // Screening the already-tokenised text would tokenise the tokens.
    const seen = [];
    const { mods } = stubs({ shieldOutcome: 'pass' });
    mods['../core/kb/kbIngestionHelpers'].ingestDocument = async (t, k, body, title, st, uri, opts) => {
        seen.push(opts.privacy);
        return { document: { id: 'doc-new' }, chunks: 1, status: 'processed' };
    };
    mods['../core/kb/kbIngestionHelpers'].findDocumentBySourceUri = async () => null; // take the fresh-write path
    await withModules(mods, (tool) => tool.executeKbIngestTool('knowledge_base_ingest', ARGS, CTX));
    assert.deepStrictEqual(seen, [null], 'the ingest receives no privacy context of its own');
});

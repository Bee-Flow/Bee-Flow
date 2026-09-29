/**
 * Integration tests for KbSourcesStore (kb_sources) and the K1 document
 * status semantics on stores/knowledgeBases.js that only real SQL can prove:
 * the atomic claim, the stuck-reaper, per-KB counters, FK cascades,
 * dedup ignoring skipped rows, replace-in-place keeping the id, and the
 * snapshot payload excluding original_content.
 *
 * Run: node --test --test-force-exit stores/kbSources.test.js
 *
 * Requires a Postgres reachable through the server's normal database config
 * (CORE_DATABASE_URL); every test skips when it is not (same contract as
 * automationStore.claim.test.js) so CI without a DB doesn't false-fail.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

let ready = false;
let skipReason = '';
let kbStore, sourcesStore, pool;

before(async () => {
    try {
        kbStore = require('./knowledgeBases');
        await kbStore.whenReady();
        sourcesStore = require('./kbSources');
        await sourcesStore.initDB();
        pool = require('../db').pool;
        ready = true;
    } catch (e) {
        skipReason = `Postgres unavailable, skipping: ${e.message}`;
        console.warn(`[kbSources.test] ${skipReason}`);
    }
});

after(async () => {
    try { if (pool) await pool.end(); } catch (_) { /* ignore */ }
});

async function withKB(fn) {
    const tenant = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const kb = await kbStore.createKB(tenant, `k1-test-${tenant}`, 'K1 source-model test');
    try { await fn({ kb, tenant }); }
    finally { await kbStore.deleteKB(kb.id).catch(() => {}); }
}

function guarded(name, fn) {
    test(name, async (t) => {
        if (!ready) { t.skip(skipReason); return; }
        await fn(t);
    });
}

// ── kb_sources CRUD ───────────────────────────────────────────────────

guarded('create / get / listByKb / update / remove round-trip (camelCase rows)', async () => {
    await withKB(async ({ kb, tenant }) => {
        const src = await sourcesStore.create({
            knowledgeBaseId: kb.id, kind: 'webpage', name: 'Docs site',
            config: { url: 'https://example.com', crawl: { maxPages: 5 } },
            refreshMode: 'schedule', refreshCron: '0 3 * * *', refreshTz: 'Europe/Amsterdam',
            createdBy: tenant,
        });
        assert.ok(src.id);
        assert.strictEqual(src.knowledgeBaseId, kb.id);
        assert.strictEqual(src.kind, 'webpage');
        assert.strictEqual(src.status, 'idle');
        assert.strictEqual(src.refreshMode, 'schedule');
        assert.strictEqual(src.consecutiveErrors, 0);
        assert.deepStrictEqual(src.config, { url: 'https://example.com', crawl: { maxPages: 5 } });

        const got = await sourcesStore.get(src.id);
        assert.strictEqual(got.name, 'Docs site');

        const list = await sourcesStore.listByKb(kb.id);
        assert.deepStrictEqual(list.map(s => s.id), [src.id]);

        const found = await sourcesStore.findOne(kb.id, 'webpage', { configMatch: { url: 'https://example.com' } });
        assert.strictEqual(found.id, src.id);
        assert.strictEqual(await sourcesStore.findOne(kb.id, 'webpage', { configMatch: { url: 'https://other.example' } }), null);

        const upd = await sourcesStore.update(src.id, { name: 'Renamed', refreshMode: 'manual', refreshCron: null, kind: 'legacy', knowledgeBaseId: 'x' });
        assert.strictEqual(upd.name, 'Renamed');
        assert.strictEqual(upd.refreshMode, 'manual');
        assert.strictEqual(upd.refreshCron, null);
        assert.strictEqual(upd.kind, 'webpage', 'kind is not writable through update');

        assert.strictEqual(await sourcesStore.remove(src.id), true);
        assert.strictEqual(await sourcesStore.get(src.id), null);
        assert.strictEqual(await sourcesStore.remove(src.id), false);
    });
});

guarded('rejects unknown kind / refresh mode before the DB CHECK', async () => {
    await withKB(async ({ kb }) => {
        await assert.rejects(
            () => sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'dropbox' }),
            (e) => e.code === 'invalid_kind' && e.status === 400,
        );
        await assert.rejects(
            () => sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'text', refreshMode: 'hourly' }),
            (e) => e.code === 'invalid_refresh_mode',
        );
    });
});

// ── claim / finish / reaper ───────────────────────────────────────────

guarded('claimDue is atomic: two concurrent claims split the due set, a claimed row is invisible', async () => {
    await withKB(async ({ kb }) => {
        const past = new Date(Date.now() - 60_000);
        const src = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'webpage', refreshMode: 'schedule', nextRefreshAt: past });
        const notDue = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'webpage', refreshMode: 'schedule', nextRefreshAt: new Date(Date.now() + 3_600_000) });
        const manual = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'upload' });

        const [a, b] = await Promise.all([sourcesStore.claimDue(10), sourcesStore.claimDue(10)]);
        const winners = [...a, ...b].filter(r => r.id === src.id);
        assert.strictEqual(winners.length, 1, 'exactly one claimer gets the row');
        assert.strictEqual(winners[0].status, 'refreshing');
        assert.ok(winners[0].lastRefreshStartedAt, 'claim stamps last_refresh_started_at');
        assert.ok(![...a, ...b].some(r => r.id === notDue.id || r.id === manual.id), 'future/manual rows are never claimed');

        const again = await sourcesStore.claimDue(10);
        assert.ok(!again.some(r => r.id === src.id), 'a live claim is invisible to later claims');

        // finish ok → idle, streak reset, next run scheduled
        const next = new Date(Date.now() + 600_000);
        const done = await sourcesStore.finish(src.id, { ok: true, nextRefreshAt: next });
        assert.strictEqual(done.status, 'idle');
        assert.strictEqual(done.consecutiveErrors, 0);
        assert.strictEqual(done.lastRefreshError, null);
        assert.strictEqual(done.lastRefreshStartedAt, null);
        assert.ok(done.lastRefreshAt);
        assert.strictEqual(new Date(done.nextRefreshAt).getTime(), next.getTime());

        // finish error → error + streak, keeps last_refresh_at from the good run
        await sourcesStore.requestRefresh(src.id);
        const [claimed] = await sourcesStore.claimDue(10);
        assert.strictEqual(claimed.id, src.id, 'requestRefresh makes the row due now');
        const failed = await sourcesStore.finish(src.id, { ok: false, error: new Error('boom'), nextRefreshAt: next });
        assert.strictEqual(failed.status, 'error');
        assert.strictEqual(failed.consecutiveErrors, 1);
        assert.strictEqual(failed.lastRefreshError, 'boom');
        assert.strictEqual(failed.lastRefreshAt, done.lastRefreshAt);
    });
});

guarded('timeoutStuck resets a stale refreshing row and makes it claimable again', async () => {
    await withKB(async ({ kb }) => {
        const src = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'datatable', refreshMode: 'on_change', nextRefreshAt: new Date(Date.now() - 1000) });
        const [claimed] = await sourcesStore.claimDue(10);
        assert.strictEqual(claimed.id, src.id);

        assert.strictEqual(await sourcesStore.timeoutStuck(15), 0, 'a fresh claim is not stuck');
        await pool.query(`UPDATE kb_sources SET last_refresh_started_at = now() - INTERVAL '20 minutes' WHERE id = $1`, [src.id]);

        assert.strictEqual(await sourcesStore.timeoutStuck(15), 1);
        const after1 = await sourcesStore.get(src.id);
        assert.strictEqual(after1.status, 'error');
        assert.strictEqual(after1.consecutiveErrors, 1);
        assert.strictEqual(after1.lastRefreshError, 'Refresh timed out');
        assert.ok(after1.nextRefreshAt, 'next_refresh_at is left alone so the row is retried');

        const [reclaimed] = await sourcesStore.claimDue(10);
        assert.strictEqual(reclaimed.id, src.id, 'reaped row is claimable again');
    });
});

guarded('a stale claim (worker died) is reclaimable without the reaper', async () => {
    await withKB(async ({ kb }) => {
        const src = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'nextcloud_folder', refreshMode: 'schedule', nextRefreshAt: new Date(Date.now() - 1000) });
        await sourcesStore.claimDue(10);
        await pool.query(`UPDATE kb_sources SET last_refresh_started_at = now() - INTERVAL '20 minutes' WHERE id = $1`, [src.id]);
        const [re] = await sourcesStore.claimDue(10, { staleMinutes: 15 });
        assert.strictEqual(re?.id, src.id);
    });
});

// ── counters ──────────────────────────────────────────────────────────

guarded('countsByKb: sources, auto-refreshing, max(last_refresh_at)', async () => {
    await withKB(async ({ kb }) => {
        const s1 = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'upload' });
        const s2 = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'webpage', refreshMode: 'schedule' });
        await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'datatable', refreshMode: 'live' });
        await pool.query(`UPDATE kb_sources SET last_refresh_at = '2026-01-01T00:00:00Z' WHERE id = $1`, [s1.id]);
        await pool.query(`UPDATE kb_sources SET last_refresh_at = '2026-02-01T00:00:00Z' WHERE id = $1`, [s2.id]);

        const counts = await sourcesStore.countsByKb([kb.id, crypto.randomUUID()]);
        assert.deepStrictEqual(Object.keys(counts), [kb.id]);
        assert.strictEqual(counts[kb.id].sourceCount, 3);
        assert.strictEqual(counts[kb.id].autoRefreshCount, 2);
        assert.strictEqual(new Date(counts[kb.id].lastRefreshAt).toISOString(), '2026-02-01T00:00:00.000Z');
        assert.deepStrictEqual(await sourcesStore.countsByKb([]), {});
    });
});

// ── documents ↔ sources ───────────────────────────────────────────────

guarded('documents.source_id cascades: removing a source removes its documents; KB delete removes sources', async () => {
    await withKB(async ({ kb, tenant }) => {
        const src = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'upload', createdBy: tenant });
        const doc = await kbStore.createDocument(tenant, kb.id, 'a.pdf', 'upload', 'a.pdf', 'h1', 3, null, null, {
            sourceId: src.id, externalId: 'file-1', sizeBytes: 1234, pageCount: 4, mime: 'application/pdf', createdBy: tenant,
        });
        assert.strictEqual(doc.source_id, src.id);
        assert.strictEqual(doc.status, 'processed');
        assert.strictEqual(doc.pii_status, 'unscanned');
        assert.strictEqual(doc.page_count, 4);
        assert.ok(!('original_content' in doc), 'createDocument returns the projection');

        const byExt = await kbStore.findDocumentBySourceExternalId(src.id, 'file-1');
        assert.strictEqual(byExt.id, doc.id);

        await sourcesStore.remove(src.id);
        assert.strictEqual(await kbStore.getDocument(doc.id), null, 'document cascaded with its source');
    });
    // KB delete → sources gone
    const tenant = `tu_${crypto.randomBytes(4).toString('hex')}`;
    const kb = await kbStore.createKB(tenant, 'cascade', '');
    const src = await sourcesStore.create({ knowledgeBaseId: kb.id, kind: 'text' });
    await kbStore.deleteKB(kb.id);
    assert.strictEqual(await sourcesStore.get(src.id), null);
});

guarded('dedup and counters consider only processed|redacted rows', async () => {
    await withKB(async ({ kb, tenant }) => {
        const hash = 'dedup-hash-1';
        const skipped = await kbStore.createDocument(tenant, kb.id, 'bad.pdf', 'upload', 'bad.pdf', hash, 0, null, null, { status: 'skipped', statusReason: 'too short' });
        assert.strictEqual(skipped.status, 'skipped');
        assert.strictEqual(await kbStore.hasContentHash(kb.id, hash), null, 'a skipped row never blocks a retry');

        const errored = await kbStore.createDocument(tenant, kb.id, 'err.pdf', 'upload', 'err.pdf', hash, 0, null, null, { status: 'error', statusReason: 'boom' });
        assert.strictEqual(await kbStore.hasContentHash(kb.id, hash), null);

        const good = await kbStore.createDocument(tenant, kb.id, 'good.pdf', 'upload', 'good.pdf', hash, 5, null, 12345n);
        assert.strictEqual(await kbStore.hasContentHash(kb.id, hash), good.id);
        const near = await kbStore.findNearDuplicateBySimhash(kb.id, 12345n, 0);
        assert.strictEqual(near.id, good.id);
        assert.strictEqual(near.source_id, null);

        const dup = await kbStore.recordDuplicate(tenant, kb.id, 'good-again.pdf', 'upload', 'good-again.pdf', hash, good.id, null);
        assert.strictEqual(dup.status, 'duplicate');
        assert.strictEqual(dup.duplicate_of, good.id);

        const redacted = await kbStore.createDocument(tenant, kb.id, 'red.pdf', 'upload', 'red.pdf', 'h-red', 2, null, null, { status: 'redacted', piiStatus: 'redacted' });
        assert.strictEqual(redacted.status, 'redacted');

        const counts = await kbStore.countDocumentsByStatus(kb.id);
        assert.deepStrictEqual(counts, { documentCount: 2, documentCountAll: 5, totalChunks: 7 });

        const listed = (await kbStore.listKBs(tenant)).find(k => k.id === kb.id);
        assert.strictEqual(Number(listed.document_count), 2);
        assert.strictEqual(Number(listed.document_count_all), 5);
        assert.strictEqual(Number(listed.total_chunks), 7);

        const onlyBad = await kbStore.listDocuments(kb.id, { filters: { status: ['skipped', 'error'] } });
        assert.deepStrictEqual(onlyBad.map(d => d.id).sort(), [skipped.id, errored.id].sort());
        assert.strictEqual(await kbStore.countDocuments(kb.id, { pii: 'found' }), 1);
        assert.strictEqual(await kbStore.countDocuments(kb.id, { q: 'GOOD' }), 2);
        assert.ok(onlyBad.every(d => !('original_content' in d)), 'lists are projected');
    });
});

guarded('replaceDocumentContent keeps the row id; updateDocumentStatus flips a row; bumpKBVersion stamps last_content_at', async () => {
    await withKB(async ({ kb, tenant }) => {
        const doc = await kbStore.createDocument(tenant, kb.id, 'v1', 'text', null, 'h-v1', 2, null, null, { status: 'error', statusReason: 'boom' });
        const replaced = await kbStore.replaceDocumentContent(doc.id, {
            contentHash: 'h-v2', simhash: 42n, chunkCount: 9, sizeBytes: 100, pageCount: 2,
            status: 'processed', statusReason: null, sourceModifiedAt: '2026-03-01T00:00:00Z',
        });
        assert.strictEqual(replaced.id, doc.id);
        assert.strictEqual(replaced.content_hash, 'h-v2');
        assert.strictEqual(replaced.chunk_count, 9);
        assert.strictEqual(replaced.status, 'processed');
        assert.strictEqual(replaced.status_reason, null);
        assert.strictEqual(replaced.title, 'v1', 'undefined keeps the stored value');
        assert.ok(new Date(replaced.updated_at) >= new Date(doc.updated_at));

        const flipped = await kbStore.updateDocumentStatus(doc.id, { status: 'skipped', statusReason: 'blocked', chunkCount: 0 });
        assert.strictEqual(flipped.status, 'skipped');
        assert.strictEqual(flipped.chunk_count, 0);

        const before = await kbStore.getKB(kb.id);
        assert.strictEqual(before.last_content_at, null);
        await kbStore.bumpKBVersion(kb.id);
        const afterBump = await kbStore.getKB(kb.id);
        assert.ok(afterBump.last_content_at, 'bumpKBVersion sets last_content_at');
        await kbStore.updateKB(kb.id, { name: 'renamed' });
        const afterMeta = await kbStore.getKB(kb.id);
        assert.strictEqual(String(afterMeta.last_content_at), String(afterBump.last_content_at), 'metadata edits do not touch it');
    });
});

guarded('snapshotDocumentVersion payload has no original_content; pruneDocumentVersions enforces keep/age', async () => {
    await withKB(async ({ kb, tenant }) => {
        const doc = await kbStore.createDocument(tenant, kb.id, 'snap', 'text', null, 'h-snap', 1);
        await pool.query(`UPDATE documents SET original_content = $2 WHERE id = $1`, [doc.id, 'SECRET BODY']);
        assert.strictEqual(await kbStore.getDocumentOriginalContent(doc.id), 'SECRET BODY');
        assert.ok(!('original_content' in (await kbStore.getDocument(doc.id))), 'getDocument is projected');

        for (let i = 0; i < 5; i++) await kbStore.snapshotDocumentVersion(doc.id, tenant);
        const { rows } = await pool.query(`SELECT payload FROM kb_document_versions WHERE document_id = $1`, [doc.id]);
        assert.strictEqual(rows.length, 5);
        for (const r of rows) {
            assert.ok(!('original_content' in r.payload), 'payload must not carry the body');
            assert.ok(!JSON.stringify(r.payload).includes('SECRET BODY'));
            assert.strictEqual(r.payload.content_hash, 'h-snap');
        }

        // keep 3 per doc
        const pruned = await kbStore.pruneDocumentVersions(3, 30);
        assert.ok(pruned >= 2);
        const left = await pool.query(`SELECT id FROM kb_document_versions WHERE document_id = $1`, [doc.id]);
        assert.strictEqual(left.rows.length, 3);

        // age: backdate one → gone
        await pool.query(`UPDATE kb_document_versions SET deleted_at = now() - INTERVAL '40 days' WHERE id = $1`, [left.rows[0].id]);
        await kbStore.pruneDocumentVersions(3, 30);
        const left2 = await pool.query(`SELECT id FROM kb_document_versions WHERE document_id = $1`, [doc.id]);
        assert.strictEqual(left2.rows.length, 2);

        await pool.query(`DELETE FROM kb_document_versions WHERE document_id = $1`, [doc.id]);
    });
});

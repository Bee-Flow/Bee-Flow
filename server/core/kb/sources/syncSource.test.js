/**
 * The refresh engine's diff.
 *
 * Everything here is about a wrong answer costing something real: re-ingesting
 * an unchanged page burns an embedding call and destroys the citation that
 * pointed at it; treating a page the engine never LOOKED at as "gone" deletes
 * a customer's document; a pass with no ceiling holds the 60-second tick open
 * for an hour and every other source behind it.
 *
 * Run: node --test --test-force-exit core/kb/sources/syncSource.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { syncSource, labelDocuments, nextRefreshFor } = require('./index');

const KB = { id: 'kb1', tenant_id: 'tenant1' };

function doc(id, externalId, over = {}) {
    return {
        id, external_id: externalId, title: externalId,
        status: 'processed', source_modified_at: null, original_content: 'stored text',
        ...over,
    };
}

/**
 * A fake source kind, so the engine's diff is tested without a network. The
 * adapter contract is small on purpose: enumerate, isUnchanged, fetch.
 */
function harness({ stored = [], items = [], unchanged = () => false, fetchImpl, cancelAfter = null } = {}) {
    const calls = { ingest: [], reingest: [], deleted: [], bumped: 0, cancelChecks: 0 };
    let cancelled = false;

    const deps = {
        kbStore: {
            getKB: async () => KB,
            listDocuments: async (kbId, { offset = 0, filters = {} } = {}) => {
                if (offset > 0) return [];
                let rows = stored;
                if (filters.status) {
                    const list = Array.isArray(filters.status) ? filters.status : [filters.status];
                    rows = rows.filter(d => list.includes(d.status));
                }
                return rows;
            },
            getDocument: async (id) => stored.find(d => d.id === id) || null,
            bumpKBVersion: async () => { calls.bumped += 1; },
        },
        kbSourcesStore: {
            isCancelRequested: async () => {
                calls.cancelChecks += 1;
                if (cancelAfter !== null && calls.cancelChecks > cancelAfter) cancelled = true;
                return cancelled;
            },
        },
        helpers: {
            ingestDocument: async (tenantId, kbId, content, title, sourceType, sourceUri, opts) => {
                calls.ingest.push({ title, content, externalId: opts.externalId, sourceId: opts.sourceId });
                return { document: { id: `new_${opts.externalId}` }, chunks: 1, status: 'processed' };
            },
            reingestDocument: async (tenantId, kbId, docId, content, opts) => {
                calls.reingest.push({ docId, content, externalId: opts.externalId });
                return { document: { id: docId }, chunks: 1, status: 'processed' };
            },
            deleteDocumentChunks: async (kbId, docId, tenantId, opts) => {
                calls.deleted.push({ docId, skipSnapshot: opts?.skipSnapshot });
            },
        },
        adapters: null,
    };

    const adapter = {
        enumerate: async () => items,
        isUnchanged: unchanged,
        fetch: fetchImpl || (async (item) => ({ content: `fresh ${item.externalId}`, title: item.externalId })),
    };
    return { deps, calls, adapter };
}

const SOURCE = { id: 'src1', knowledgeBaseId: 'kb1', kind: 'webpage', refreshMode: 'schedule', config: {}, createdBy: 'u1' };

test('a new item is ingested', async () => {
    const { deps, calls, adapter } = harness({ stored: [], items: [{ externalId: 'a' }] });
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.added, 1);
    assert.strictEqual(calls.ingest.length, 1);
    assert.strictEqual(calls.ingest[0].externalId, 'a');
    assert.strictEqual(calls.ingest[0].sourceId, 'src1', 'the row must be attached to its source');
});

test('a changed item keeps its documents row', async () => {
    // reingestDocument, never delete-and-recreate: the row id IS the citation
    // and the version history.
    const { deps, calls, adapter } = harness({ stored: [doc('d1', 'a')], items: [{ externalId: 'a' }] });
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.updated, 1);
    assert.strictEqual(calls.reingest.length, 1);
    assert.strictEqual(calls.reingest[0].docId, 'd1');
    assert.strictEqual(calls.ingest.length, 0, 'never a second row for the same thing');
});

test('an unchanged item costs nothing at all', async () => {
    const { deps, calls, adapter } = harness({
        stored: [doc('d1', 'a')], items: [{ externalId: 'a' }], unchanged: () => true,
    });
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.unchanged, 1);
    assert.deepStrictEqual([calls.ingest.length, calls.reingest.length], [0, 0]);
    assert.strictEqual(calls.bumped, 0, 'nothing changed, so no version bump');
});

test('an adapter that discovers "unchanged" only at fetch time also costs nothing', async () => {
    // The 304 path: cheap evidence the far end holds, not the near end.
    const { deps, calls, adapter } = harness({
        stored: [doc('d1', 'a')], items: [{ externalId: 'a' }], fetchImpl: async () => null,
    });
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.unchanged, 1);
    assert.strictEqual(calls.reingest.length, 0);
});

test('an item the source no longer offers is removed, without a snapshot', async () => {
    // skipSnapshot: the external system is the source of truth, not our audit
    // table — which has no delete path of its own.
    const { deps, calls, adapter } = harness({ stored: [doc('d1', 'a'), doc('d2', 'b')], items: [{ externalId: 'a' }] });
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.removed, 1);
    assert.deepStrictEqual(calls.deleted, [{ docId: 'd2', skipSnapshot: true }]);
});

test('a document that predates the source model is never treated as gone', async () => {
    // No external_id means the engine cannot match it against anything the
    // source enumerates. Deleting what it merely fails to recognise would
    // turn one upgrade into silent data loss.
    const { deps, calls, adapter } = harness({
        stored: [doc('d_old', null), doc('d1', 'a')], items: [{ externalId: 'a' }],
    });
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.removed, 0);
    assert.strictEqual(calls.deleted.length, 0);
});

test('one failing document does not fail the pass', async () => {
    // The other 37 files in the folder still belong in the knowledge base.
    const { deps, calls, adapter } = harness({
        stored: [], items: [{ externalId: 'a' }, { externalId: 'b' }],
        fetchImpl: async (item) => {
            if (item.externalId === 'a') throw new Error('extraction failed');
            return { content: 'ok', title: 'b' };
        },
    });
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.failed, 1);
    assert.strictEqual(r.added, 1);
    assert.strictEqual(calls.ingest.length, 1);
});

test('a cancelled pass stops between documents and deletes NOTHING', async () => {
    // The half it did not look at is not "gone" — it is unexamined.
    const { deps, calls, adapter } = harness({
        stored: [doc('d1', 'a'), doc('d2', 'b'), doc('d3', 'c')],
        // Three items to walk, cancelled after the first check: the second
        // boundary is where it stops.
        items: [{ externalId: 'a' }, { externalId: 'b' }, { externalId: 'c' }],
        cancelAfter: 1,
    });
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.cancelled, true);
    assert.strictEqual(r.updated, 1, 'the document it was already inside is finished, not abandoned');
    assert.strictEqual(calls.deleted.length, 0, 'a cancelled pass must not delete');
});

test('a pass that runs out of items deletes nothing either', async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ externalId: `p${i}` }));
    const { deps, calls, adapter } = harness({ stored: [doc('d_gone', 'zzz')], items });
    const r = await syncSource(SOURCE, { deps, adapter, maxItems: 2 });
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.added, 2, 'only the window is processed');
    assert.strictEqual(calls.deleted.length, 0, 'a truncated pass must not delete');
});

test('a pass that runs out of TIME stops and says so', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ externalId: `p${i}` }));
    const { deps, adapter } = harness({
        stored: [], items,
        fetchImpl: async (item) => { await new Promise(r => setTimeout(r, 5)); return { content: 'x', title: item.externalId }; },
    });
    const r = await syncSource(SOURCE, { deps, adapter, timeBudgetMs: 15 });
    assert.strictEqual(r.truncated, true);
    assert.ok(r.added < 20, 'the budget must actually stop it');
});

test('a knowledge base that is gone is not an error', async () => {
    const { deps, adapter } = harness({});
    deps.kbStore.getKB = async () => null;
    const r = await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(r.skipped, 'kb_gone');
});

test('a kind with no adapter stands down instead of looping', async () => {
    // `nextcloud_folder` is K9, which needs a probe against a real Nextcloud
    // and is not in this programme. (This test used to name `meeting_tag`;
    // K7 landed that adapter, so it is no longer an example of one missing.)
    const { deps } = harness({});
    const r = await syncSource({ ...SOURCE, kind: 'nextcloud_folder' }, { deps });
    assert.strictEqual(r.skipped, 'kind_unsupported');
    assert.strictEqual(r.nextRefreshAt, null, 'and is not rescheduled');
});

test('the version is bumped only when something actually changed', async () => {
    const { deps, calls, adapter } = harness({ stored: [], items: [{ externalId: 'a' }] });
    await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(calls.bumped, 1);
});

test('the privacy screen is applied to a scheduled refresh, not only to uploads', async () => {
    // A folder source pulls in whatever the folder gained since last week, at
    // 06:00, with nobody looking. That is the ingest that most needs the
    // shield, not least.
    const { deps, calls, adapter } = harness({ stored: [], items: [{ externalId: 'a' }] });
    const seen = [];
    deps.helpers.ingestDocument = async (t, k, c, title, st, uri, opts) => {
        seen.push(opts.privacy);
        calls.ingest.push({ title });
        return { document: { id: 'new_a' }, chunks: 1, status: 'processed' };
    };
    await syncSource(SOURCE, { deps, adapter });
    assert.strictEqual(seen.length, 1);
    assert.ok(seen[0] && 'orgId' in seen[0], 'the shield is asked, with the KB\'s org');
});

describe_labels();
function describe_labels() {
    function labelHarness({ summarise, cancelled = false } = {}) {
        const written = [];
        return {
            written,
            ctx: { source: { id: 'src1' }, log: () => {} },
            deps: {
                kbStore: { replaceDocumentContent: async (id, patch) => { written.push({ id, ...patch }); } },
                kbSourcesStore: { isCancelRequested: async () => cancelled },
                extractSummary: { summarise: summarise || (async ({ title }) => ({ summary: `about ${title}` })) },
            },
        };
    }

    test('every touched document gets its label', async () => {
        const h = labelHarness();
        await labelDocuments([
            { docId: 'd1', text: 'x'.repeat(100), title: 'Terms' },
            { docId: 'd2', text: 'y'.repeat(100), title: 'Prices' },
        ], h.ctx, h.deps);
        assert.deepStrictEqual(h.written.map(w => w.extractSummary), ['about Terms', 'about Prices']);
    });

    test('a summariser that fails costs the label, never the document', async () => {
        // The documents are already stored and searchable. A refresh that
        // failed because a summariser was rate-limited would fail for a
        // reason nobody would accept.
        const h = labelHarness({ summarise: async () => { throw new Error('rate limited'); } });
        await labelDocuments([{ docId: 'd1', text: 'x'.repeat(100), title: 'Terms' }], h.ctx, h.deps);
        assert.strictEqual(h.written.length, 0);
    });

    test('a summariser that has nothing to say writes nothing', async () => {
        const h = labelHarness({ summarise: async () => null });
        await labelDocuments([{ docId: 'd1', text: 'x', title: 'Terms' }], h.ctx, h.deps);
        assert.strictEqual(h.written.length, 0);
    });

    test('a cancelled refresh stops summarising too', async () => {
        const h = labelHarness({ cancelled: true });
        await labelDocuments([{ docId: 'd1', text: 'x'.repeat(100), title: 'Terms' }], h.ctx, h.deps);
        assert.strictEqual(h.written.length, 0);
    });

    test('nothing to label is not a round trip', async () => {
        const h = labelHarness({ summarise: async () => { throw new Error('should not be called'); } });
        await labelDocuments([], h.ctx, h.deps);
        assert.strictEqual(h.written.length, 0);
    });
}

describe_nextRefresh();
function describe_nextRefresh() {
    test('manual and live sources are never scheduled', () => {
        assert.strictEqual(nextRefreshFor({ refreshMode: 'manual' }), null);
        // A live source is answered from the table at query time; a timestamp
        // would put it in claimDue's way forever.
        assert.strictEqual(nextRefreshFor({ refreshMode: 'live' }), null);
    });

    test('a scheduled source gets a future timestamp', () => {
        const iso = nextRefreshFor({ refreshMode: 'schedule', refreshCron: '0 6 * * 1', refreshTz: 'UTC' });
        assert.ok(Date.parse(iso) > Date.now());
    });

    test('a schedule with no cron still gets a cadence', () => {
        const iso = nextRefreshFor({ refreshMode: 'schedule' });
        assert.ok(Date.parse(iso) > Date.now());
    });
}

test('what the adapter knows ABOUT the thing reaches the documents row', async () => {
    // A meeting's own date and the rows a block covers are built by the
    // adapter, accepted by both helpers, and written to documents.metadata.
    // This loop passed every other option and not that one, so they were
    // fetched, built and dropped one hop short of the column that holds them
    // — and no citation could ever say when a meeting was held.
    const meta = { meetingDate: '2026-07-22T09:00:00.000Z', rowStart: 1, rowEnd: 50 };
    const fetchImpl = async (item) => ({ content: `fresh ${item.externalId}`, title: item.externalId, metadata: meta });
    const seen = {};

    const fresh = harness({ stored: [], items: [{ externalId: 'a' }], fetchImpl });
    fresh.deps.helpers.ingestDocument = async (t, k, c, title, st, uri, opts) => {
        seen.ingest = opts.metadata;
        return { document: { id: 'new_a' }, chunks: 1, status: 'processed' };
    };
    await syncSource(SOURCE, { deps: fresh.deps, adapter: fresh.adapter });
    assert.deepStrictEqual(seen.ingest, meta);

    // A refresh is how a document already in the base GAINS what it never had.
    const again = harness({ stored: [doc('d1', 'a')], items: [{ externalId: 'a' }], fetchImpl });
    again.deps.helpers.reingestDocument = async (t, k, docId, c, opts) => {
        seen.reingest = opts.metadata;
        return { document: { id: docId }, chunks: 1, status: 'processed' };
    };
    await syncSource(SOURCE, { deps: again.deps, adapter: again.adapter });
    assert.deepStrictEqual(seen.reingest, meta);
});

test('an adapter with nothing extra to say does not ERASE what is already there', async () => {
    // A refresh runs on every source, most of which have nothing to add. An
    // explicit null reaches replaceDocumentContent as "clear the column", so
    // passing one unconditionally would wipe a document's metadata on the next
    // scheduled pass — the same bug in the opposite direction.
    const fresh = harness({ stored: [], items: [{ externalId: 'a' }] });
    let onIngest = 'not called';
    fresh.deps.helpers.ingestDocument = async (t, k, c, title, st, uri, opts) => {
        onIngest = opts.metadata;
        return { document: { id: 'new_a' }, chunks: 1, status: 'processed' };
    };
    await syncSource(SOURCE, { deps: fresh.deps, adapter: fresh.adapter });
    assert.strictEqual(onIngest, null, 'a new row starts empty either way');

    const again = harness({ stored: [doc('d1', 'a')], items: [{ externalId: 'a' }] });
    let keys = null;
    again.deps.helpers.reingestDocument = async (t, k, docId, c, opts) => {
        keys = Object.keys(opts);
        return { document: { id: docId }, chunks: 1, status: 'processed' };
    };
    await syncSource(SOURCE, { deps: again.deps, adapter: again.adapter });
    assert.ok(!keys.includes('metadata'), 'the column is not written at all');
});

test('an adapter whose items carry their own identity opts out of the text-similarity duplicate filter', async () => {
    // A table row is its id, not its text: two invoices from one supplier
    // differ in a date and an amount, and "near-identical" is exactly what
    // distinct rows of a narrow table look like. Ten of twenty-three rows went
    // missing that way. `externalId` already keeps a row from arriving twice.
    const seen = [];
    const { deps, adapter } = harness({ stored: [], items: [{ externalId: 'row:1' }] });
    deps.helpers.ingestDocument = async (t, k, c, title, st, uri, opts) => {
        seen.push(opts.skipDedup);
        return { document: { id: 'n1' }, chunks: 1, status: 'processed' };
    };
    await syncSource(SOURCE, { deps, adapter: { ...adapter, dedupe: false } });
    await syncSource(SOURCE, { deps, adapter });
    assert.deepStrictEqual(seen, [true, false], 'only an adapter that says so; a web page still dedupes');
});

test('a row the text filter once marked duplicate is rebuilt when its adapter says rows never are', async () => {
    // It has no chunks of its own; "unchanged" would keep it empty for ever.
    const dup = { ...doc('d1', 'row:1'), status: 'duplicate' };
    const { deps, calls, adapter } = harness({ stored: [dup], items: [{ externalId: 'row:1' }], unchanged: () => true });
    await syncSource(SOURCE, { deps, adapter: { ...adapter, dedupe: false } });
    assert.strictEqual(calls.reingest.length, 1, 'rebuilt in place, keeping its row');
    assert.strictEqual(calls.reingest[0].docId, 'd1');

    // An adapter that still dedupes leaves the alias alone.
    const again = harness({ stored: [dup], items: [{ externalId: 'row:1' }], unchanged: () => true });
    await syncSource(SOURCE, { deps: again.deps, adapter: again.adapter });
    assert.strictEqual(again.calls.reingest.length, 0);
});

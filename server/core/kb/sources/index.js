// @typecheck
/**
 * The refresh engine: one `syncSource` for every kind of knowledge source.
 *
 * ── ONE ENGINE, THREE TRIGGERS ──────────────────────────────────────
 * A schedule firing, an external change arriving, and someone pressing
 * "Refresh now" all end here. `POST /:id/sources/:sid/refresh` does not do
 * any work of its own — it sets `next_refresh_at = now()` and the tick picks
 * it up — so what a person sees when they test a source by hand is exactly
 * what happens at three in the morning. Three code paths that "do the same
 * thing" is how a source works when watched and fails when not.
 *
 * ── THE DIFF IS THE POINT ───────────────────────────────────────────
 * A refresh is not a re-ingest. Re-ingesting everything each week would
 * re-embed 400 unchanged pages (money, time, and a rate-limit away from the
 * provider), and — worse — it would destroy and recreate every `documents`
 * row, so every citation ever made would dangle. So each pass compares what
 * the source HAS against what we STORED, keyed on `external_id`, and acts
 * only on the difference:
 *
 *   new        → ingestDocument
 *   changed    → reingestDocument, which KEEPS documents.id (and therefore
 *                the citations and the version history) and swaps the chunks
 *   gone       → deleteDocumentChunks({skipSnapshot:true}) — the external
 *                system is the source of truth, not our audit table; without
 *                skipSnapshot a retention sweep upstream would copy every
 *                deleted row into `kb_document_versions`, which has no delete
 *                path of its own
 *   unchanged  → nothing at all, which is the case that has to be cheap
 *
 * "Unchanged" is decided by the adapter, twice over, because only it knows
 * what evidence exists and what it costs: `isUnchanged(item, stored)` for
 * evidence enumeration already has (a row's `updated_at`), and a `fetch` that
 * returns null for evidence only the far end has (a web page's 304).
 *
 * ── A REFRESH CAN BE ASKED TO STOP ──────────────────────────────────
 * Between documents, never inside one. `kbSources.isCancelRequested` is read
 * from the row rather than from the claimed snapshot, because the decision to
 * stop is by definition made after the worker started. The notebook cancel
 * this replaces was cosmetic — it set a flag nothing read.
 *
 * ── AND IT ALWAYS STOPS EVENTUALLY ──────────────────────────────────
 * `maxItems` and `timeBudgetMs` are not tuning knobs, they are the reason a
 * crawl source with 500 pages cannot hold a 60-second tick open for an hour.
 * Whatever is left is left `next_refresh_at`-due, so the next tick continues
 * rather than starting over.
 */

const kbSourcesStore = require('../../../stores/kbSources');
const kbStore = require('../../../stores/knowledgeBases');
const { nextRunFor } = require('../../scheduling/nextRun');

const ADAPTERS = {
    webpage: require('./webpage'),
    upload: require('./upload'),
    text: require('./text'),
    meeting_tag: require('./meetingTag'),
    datatable: require('./datatable'),
};
const log = require('../../../telemetry/log');

/** Kinds this engine can refresh today. K7–K10 register theirs here. */
function supportedKinds() {
    return Object.keys(ADAPTERS);
}

function adapterFor(kind) {
    return ADAPTERS[kind] || null;
}

/** Default cadence when a scheduled source names no interval of its own. */
const DEFAULT_REFRESH_MINUTES = 24 * 60;
/** The fastest any source may poll, whatever its schedule asks for. */
const FLOOR_REFRESH_MINUTES = 15;
/** How long one source may hold a worker before it yields to the next tick. */
const DEFAULT_TIME_BUDGET_MS = 45_000;
/** Items one pass will look at, however many the source claims to have. */
const DEFAULT_MAX_ITEMS = 500;

/**
 * When is this source next due?
 *
 * `manual` and `live` return null: a manual source is due when a person says
 * so, and a live one is answered from the table at query time rather than
 * polled. Writing a timestamp for either would put them in `claimDue`'s way
 * forever.
 */
function nextRefreshFor(source, { fromTs = Date.now(), consecutiveErrors = 0, retryAfterMs = 0 } = {}) {
    const mode = source?.refreshMode || 'manual';
    if (mode === 'manual' || mode === 'live') return null;
    return nextRunFor(
        { cron: source?.refreshCron || null, tz: source?.refreshTz || null },
        fromTs,
        {
            consecutiveErrors,
            retryAfterMs,
            defaultMinutes: DEFAULT_REFRESH_MINUTES,
            floorMinutes: FLOOR_REFRESH_MINUTES,
        },
    );
}

/**
 * Everything the engine and its adapters share for one pass. Passed rather
 * than imported so a test can hand in a fake clock and fake stores without
 * reaching into module state.
 */
function makeCtx(source, kb, opts = {}) {
    const startedAt = opts.now || Date.now();
    return {
        source,
        kb,
        tenantId: kb.tenant_id,
        kbId: kb.id,
        reason: opts.reason || 'schedule',
        maxItems: Number(opts.maxItems) > 0 ? Number(opts.maxItems) : DEFAULT_MAX_ITEMS,
        deadline: startedAt + (Number(opts.timeBudgetMs) > 0 ? Number(opts.timeBudgetMs) : DEFAULT_TIME_BUDGET_MS),
        now: () => Date.now(),
        log: opts.log || ((...a) => log.info('[KBRefresh]', ...a)),
    };
}

/**
 * Index the documents we already hold for this source, by `external_id`.
 *
 * A row with no external_id cannot be matched against anything the source
 * enumerates — it predates the source model, or came in through a wrapper —
 * so it is deliberately NOT in the index and therefore never counted as
 * "gone". Deleting rows we simply cannot recognise would turn one upgrade
 * into silent data loss.
 */
async function indexStoredDocuments(kbId, sourceId, deps) {
    const store = deps.kbStore;
    const byExternalId = new Map();
    const unmatchable = [];
    const PAGE = 200;
    for (let offset = 0; offset < 20_000; offset += PAGE) {
        const page = await store.listDocuments(kbId, { limit: PAGE, offset, filters: { sourceId } });
        if (!page || page.length === 0) break;
        for (const d of page) {
            if (d.external_id) byExternalId.set(String(d.external_id), d);
            else unmatchable.push(d);
        }
        if (page.length < PAGE) break;
    }
    return { byExternalId, unmatchable };
}

/**
 * Refresh one source.
 *
 * @param {object} source  a kb_sources row, already CLAIMED by the caller
 * @param {object} [opts]  `{ reason, maxItems, timeBudgetMs, deps, log }`
 * @returns {Promise<object>} counters + `nextRefreshAt`; never throws for a
 *          per-document failure (those become `status:'error'` rows), only
 *          for a failure of the whole pass.
 */
async function syncSource(source, opts = {}) {
    const deps = {
        kbStore, kbSourcesStore,
        helpers: opts.deps?.helpers || require('../kbIngestionHelpers'),
        ...(opts.deps || {}),
    };
    const counts = { added: 0, updated: 0, removed: 0, unchanged: 0, failed: 0, cancelled: false, truncated: false };

    const kb = await deps.kbStore.getKB(source.knowledgeBaseId);
    if (!kb) {
        // The FK cascade will take the source with it; nothing to do and
        // nothing to report as an error.
        return { ...counts, skipped: 'kb_gone', nextRefreshAt: null };
    }

    // `opts.adapter` lets a caller hand in the adapter directly: the engine's
    // diff is the part worth testing on its own, and a later track's kind can
    // be driven through it before it is registered.
    const adapter = opts.adapter || adapterFor(source.kind);
    if (!adapter) {
        // A kind whose engine has not landed yet (K7–K10) must not be
        // rescheduled in a tight loop; say so once and stand down.
        return { ...counts, skipped: 'kind_unsupported', nextRefreshAt: null };
    }

    const ctx = makeCtx(source, kb, opts);
    const { byExternalId, unmatchable } = await indexStoredDocuments(kb.id, source.id, deps);
    const seen = new Set();
    /**
     * Documents to label, collected during the pass and summarised AFTER it.
     *
     * Deliberately not inline: a summary is a model call per document, and
     * running one between every ingest would turn a 40-file folder refresh
     * into 40 serial round trips inside a tick that has a time budget. The
     * document is already stored and searchable by then — the label is what
     * arrives a moment later.
     */
    const summarise = [];

    const items = await adapter.enumerate(source, ctx, deps);
    const list = Array.isArray(items) ? items : [];
    if (list.length > ctx.maxItems) counts.truncated = true;
    const window = list.slice(0, ctx.maxItems);

    for (const item of window) {
        // Between documents: the one place a stop is safe.
        if (await deps.kbSourcesStore.isCancelRequested(source.id)) { counts.cancelled = true; break; }
        if (ctx.now() > ctx.deadline) { counts.truncated = true; break; }

        const externalId = String(item.externalId);
        seen.add(externalId);
        const stored = byExternalId.get(externalId) || null;

        try {
            // A row the text filter once marked duplicate has no chunks of
            // its own. For an adapter that has since said its items are never
            // duplicates of each other, "unchanged" would keep it empty for
            // ever; it is rebuilt instead, once, and reads as itself after.
            const wronglyDuplicate = adapter.dedupe === false && stored?.status === 'duplicate';
            if (stored && !wronglyDuplicate && adapter.isUnchanged(item, stored)) {
                counts.unchanged += 1;
                continue;
            }
            const fetched = await adapter.fetch(item, stored, ctx, deps);
            if (fetched === null) { counts.unchanged += 1; continue; } // adapter found it unchanged after all

            /**
             * The privacy screen applies to a scheduled refresh exactly as it
             * does to an upload. A folder source pulls in whatever the folder
             * gained since last week, at 06:00, with nobody looking — which
             * is precisely the ingest that most needs screening, not least.
             */
            const privacy = { orgId: kb.organization_id || null, userId: source.createdBy || null };

            if (stored) {
                await deps.helpers.reingestDocument(ctx.tenantId, kb.id, stored.id, fetched.content, {
                    title: fetched.title || stored.title,
                    // What the adapter knows about the thing itself — a
                    // meeting's own date, the rows a block covers. Both
                    // helpers have always accepted it and this loop never
                    // passed it, so it was fetched, built and dropped one hop
                    // short of the column that holds it.
                    //
                    // Present only when there IS something: an explicit null
                    // here means "clear the column", and an adapter with
                    // nothing to add must not erase what an earlier pass wrote.
                    ...(fetched.metadata ? { metadata: fetched.metadata } : {}),
                    externalId,
                    sourceModifiedAt: fetched.sourceModifiedAt || null,
                    sizeBytes: fetched.sizeBytes ?? null,
                    mime: fetched.mime || null,
                    pageCount: fetched.pageCount ?? null,
                    sheetCount: fetched.sheetCount ?? null,
                    onFailure: 'record',
                    privacy,
                });
                counts.updated += 1;
                summarise.push({ docId: stored.id, text: fetched.content, title: fetched.title || stored.title });
            } else {
                const made = await deps.helpers.ingestDocument(
                    ctx.tenantId, kb.id, fetched.content, fetched.title || externalId,
                    fetched.sourceType || source.kind, fetched.sourceUri || null,
                    {
                        sourceId: source.id,
                        metadata: fetched.metadata || null,
                        externalId,
                        // An adapter whose items carry their OWN identity (a
                        // table row is its id, not its text) opts out of the
                        // text-similarity duplicate filter: two invoices from
                        // one supplier differ in a date and an amount, and
                        // "near-identical" is exactly what distinct rows of a
                        // narrow table look like. Ten of twenty-three rows
                        // went missing that way before this existed.
                        skipDedup: adapter.dedupe === false,
                        sourceModifiedAt: fetched.sourceModifiedAt || null,
                        sizeBytes: fetched.sizeBytes ?? null,
                        mime: fetched.mime || null,
                        pageCount: fetched.pageCount ?? null,
                        sheetCount: fetched.sheetCount ?? null,
                        createdBy: source.createdBy || null,
                        onFailure: 'record',
                        privacy,
                    },
                );
                counts.added += 1;
                if (made?.document?.id && made.status !== 'skipped') {
                    summarise.push({ docId: made.document.id, text: fetched.content, title: fetched.title || externalId });
                }
            }
        } catch (e) {
            // One document failing is a row with a reason on it, not a failed
            // refresh: the other 37 files in the folder still belong here.
            counts.failed += 1;
            ctx.log(`source ${source.id} item ${externalId} failed: ${e.message}`);
        }
    }

    // Gone: stored, still matchable, and the source no longer offers it.
    // Only when the pass actually COMPLETED — a cancelled or truncated pass
    // saw part of the source, and "I did not look" must never read as "it is
    // not there any more".
    const complete = !counts.cancelled && !counts.truncated;
    if (complete) {
        for (const [externalId, doc] of byExternalId) {
            if (seen.has(externalId)) continue;
            try {
                await deps.helpers.deleteDocumentChunks(kb.id, doc.id, ctx.tenantId, { skipSnapshot: true });
                counts.removed += 1;
            } catch (e) {
                counts.failed += 1;
                ctx.log(`source ${source.id} delete ${doc.id} failed: ${e.message}`);
            }
        }
    }

    if (unmatchable.length) {
        ctx.log(`source ${source.id}: ${unmatchable.length} document(s) predate the source model and were left alone`);
    }

    if (counts.added || counts.updated || counts.removed) {
        await deps.kbStore.bumpKBVersion(kb.id);
    }

    await labelDocuments(summarise, ctx, deps);

    /**
     * Record the table version this pass covered (K8).
     *
     * Only when the pass actually FINISHED. A cancelled or truncated pass saw
     * part of the table, and writing the version there would tell the backstop
     * "we are up to date" about rows nobody read — which is precisely the
     * silence "live" exists to prevent.
     *
     * Read AFTER the rows, never before: a write that landed mid-pass belongs
     * to the next version, and recording the earlier number simply means one
     * more refresh. Recording the later one would mean skipping that write for
     * ever.
     *
     * The TARGET tables of the source's relation columns ride along
     * (`ctx.relatedTables`, filled by the adapter, versions read after their
     * labels): a `live` source is armed when one of those changes too, because
     * a supplier renamed in its own table changes every order document that
     * names it, with no row of the orders table having moved at all.
     */
    if (source.kind === 'datatable' && !counts.cancelled && !counts.truncated) {
        try {
            const datatableId = source.config?.datatableId;
            const dtStore = deps.datatableStore || require('../../../stores/datatableStore');
            const version = datatableId ? await dtStore.getDataVersion(datatableId) : null;
            const related = ctx.relatedTables && typeof ctx.relatedTables === 'object' ? ctx.relatedTables : null;
            if (version !== null) await deps.kbSourcesStore.setSeenDataVersion(source.id, version, related);
        } catch (e) {
            // The backstop simply arms once more; nothing is lost.
            ctx.log(`could not record the table version for source ${source.id}: ${e.message}`);
        }
    }

    return { ...counts, nextRefreshAt: nextRefreshFor(source, { consecutiveErrors: 0 }) };
}

/** How many summaries may be in flight at once. */
const SUMMARY_CONCURRENCY = 3;

/**
 * Write the "what the AI took from it" line for the documents this pass
 * touched.
 *
 * Bounded concurrency, and every failure swallowed: a label is a nicety and
 * the documents are already stored and searchable without one. A refresh that
 * failed because a summariser was rate-limited would be a refresh that failed
 * for no reason the person would accept.
 */
async function labelDocuments(items, ctx, deps) {
    if (!items.length) return;
    const summariser = deps.extractSummary || require('../extractSummary');
    let cursor = 0;
    const workers = Array.from({ length: Math.min(SUMMARY_CONCURRENCY, items.length) }, async () => {
        for (;;) {
            const i = cursor++;
            if (i >= items.length) return;
            const item = items[i];
            // Between labels, so a cancelled refresh stops summarising too.
            if (await deps.kbSourcesStore.isCancelRequested(ctx.source.id)) return;
            try {
                const r = await summariser.summarise({ text: item.text, title: item.title });
                if (r?.summary) await deps.kbStore.replaceDocumentContent(item.docId, { extractSummary: r.summary });
            } catch (e) {
                ctx.log(`summary for ${item.docId} skipped: ${e.message}`);
            }
        }
    });
    await Promise.all(workers);
}

module.exports = {
    syncSource,
    labelDocuments,
    nextRefreshFor,
    adapterFor,
    supportedKinds,
    indexStoredDocuments,
    DEFAULT_REFRESH_MINUTES,
    FLOOR_REFRESH_MINUTES,
    DEFAULT_TIME_BUDGET_MS,
    DEFAULT_MAX_ITEMS,
};

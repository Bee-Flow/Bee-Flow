// @typecheck strict
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
const cloudFolder = require('./cloudFolder.mts');

/**
 * A mapped kb_sources row; `config` is the parsed jsonb column, whose keys depend on the kind.
 * @typedef {Omit<NonNullable<ReturnType<typeof kbSourcesStore.mapRow>>, 'config'> & { config: Record<string, any> }} KbSource
 */
/**
 * @typedef {{ kbStore: typeof kbStore, kbSourcesStore: typeof kbSourcesStore,
 *   helpers: typeof import('../kbIngestionHelpers'), datatableStore?: typeof import('../../../stores/datatableStore'),
 *   extractSummary?: typeof import('../extractSummary'),
 *   keepOriginal?: typeof import('../originals.mts').keepOriginal,
 *   deleteOriginal?: typeof import('../originals.mts').deleteOriginal,
 *   transcriptionStore?: typeof import('../../../stores/transcriptionStore') }} SyncDeps
 */
/**
 * @typedef {{ source: KbSource, kb: Record<string, any>, tenantId: string, kbId: string, reason: string,
 *   maxItems: number, deadline: number, now: () => number, log: (...a: unknown[]) => void,
 *   relatedTables?: Record<string, number>, partial?: boolean }} SyncCtx
 */
/** @typedef {{ externalId: string }} SourceItem */
/**
 * @typedef {{ content: string, title?: string, sourceType?: string, sourceUri?: string | null,
 *   metadata?: Record<string, unknown> | null, sourceModifiedAt?: string | Date | null, sizeBytes?: number | null,
 *   mime?: string | null, pageCount?: number | null, sheetCount?: number | null,
 *   original?: { buffer: Buffer, mime: string, filename: string } | null }} FetchedDoc
 */
/**
 * Method signatures: each source kind hands its own item shape from enumerate to fetch.
 * @typedef {{ enumerate(source: KbSource, ctx: SyncCtx, deps: SyncDeps): Promise<SourceItem[]>,
 *   isUnchanged(item: SourceItem, stored: Record<string, any>): boolean,
 *   fetch(item: SourceItem, stored: Record<string, any> | null, ctx: SyncCtx, deps: SyncDeps): Promise<FetchedDoc | null>,
 *   dedupe?: boolean, maxItems?: number,
 *   precheck?(source: KbSource, ctx: SyncCtx, deps: SyncDeps): Promise<{ changed: boolean, cursor?: unknown }> }} SourceAdapter
 */

/** @type {Record<string, SourceAdapter>} */
const ADAPTERS = {
    webpage: require('./webpage'),
    upload: require('./upload'),
    text: require('./text'),
    meeting_tag: require('./meetingTag'),
    datatable: require('./datatable'),
    cloud_folder: cloudFolder,
};
const log = require('../../../telemetry/log');
const { removeUnseenDocuments, labelDocuments } = require('./syncFinish');
const { runPrecheck, saveCursor } = require('./precheck');
const { syncItem, recordTableVersion } = require('./syncItem');

/** Kinds this engine can refresh today. K7–K10 register theirs here. */
function supportedKinds() {
    return Object.keys(ADAPTERS);
}

/** @param {string} kind */
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
 * forever. `on_change` polls every `KB_CLOUD_CHANGE_POLL_SECONDS` (default 300).
 * @param {Pick<KbSource, 'refreshMode' | 'refreshCron' | 'refreshTz'>} source
 * @param {{ fromTs?: number, consecutiveErrors?: number, retryAfterMs?: number }} [opts]
 */
function nextRefreshFor(source, { fromTs = Date.now(), consecutiveErrors = 0, retryAfterMs = 0 } = {}) {
    const mode = source?.refreshMode || 'manual';
    if (mode === 'manual' || mode === 'live') return null;
    // "On change" for a cloud folder is a poll that is cheap when nothing moved (the adapter's
    // precheck), every KB_CLOUD_CHANGE_POLL_SECONDS, whatever cron the row may still carry.
    if (mode === 'on_change') {
        return nextRunFor({}, fromTs, {
            consecutiveErrors, retryAfterMs, defaultMinutes: cloudFolder.changePollSeconds() / 60,
        });
    }
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
 * @param {KbSource} source
 * @param {Record<string, any>} kb
 * @param {{ now?: number, reason?: string, maxItems?: number, timeBudgetMs?: number, log?: (...a: unknown[]) => void }} [opts]
 * @returns {SyncCtx}
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
        log: opts.log || ((/** @type {unknown[]} */ ...a) => log.info('[KBRefresh]', ...a)),
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
 * @param {string} kbId
 * @param {string} sourceId
 * @param {SyncDeps} deps
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
 * The stores and helpers of a pass: the real ones, with whatever the caller hands in on top.
 * @param {Partial<SyncDeps>} [given]
 * @returns {SyncDeps}
 */
function passDeps(given) {
    return {
        kbStore, kbSourcesStore,
        helpers: given?.helpers || require('../kbIngestionHelpers'),
        ...(given || {}),
    };
}

/**
 * The items this pass looks at: at most `ctx.maxItems`, and a longer list marks the pass truncated.
 * @param {unknown} items  what the adapter enumerated
 * @param {SyncCtx} ctx
 * @param {{ truncated: boolean }} counts
 * @returns {SourceItem[]}
 */
function itemWindow(items, ctx, counts) {
    const list = Array.isArray(items) ? items : [];
    if (list.length > ctx.maxItems) counts.truncated = true;
    return list.slice(0, ctx.maxItems);
}

/**
 * Refresh one source.
 *
 * @param {any} source  a kb_sources row, already CLAIMED by the caller
 * @param {any} [opts]  `{ reason, maxItems, timeBudgetMs, deps, log }`
 * @returns {Promise<any>} counters + `nextRefreshAt`; never throws for a
 *          per-document failure (those become `status:'error'` rows), only
 *          for a failure of the whole pass.
 */
async function syncSource(source, opts = {}) {
    const deps = passDeps(opts.deps);
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

    // An adapter that enumerates more than the default on purpose (every
    // meeting under a tag) says so; a caller's explicit cap still wins.
    const ctx = makeCtx(source, kb, { ...opts, maxItems: opts.maxItems || adapter.maxItems });

    // An adapter that can tell cheaply that nothing moved (a folder's etag, a
    // delta link) ends the pass here, before it lists anything. See ./precheck.
    const check = await runPrecheck(adapter, source, ctx, deps);
    if (!check.changed) {
        return { ...counts, precheckUnchanged: true, nextRefreshAt: nextRefreshFor(source, { consecutiveErrors: 0 }) };
    }
    const { byExternalId, unmatchable } = await indexStoredDocuments(kb.id, source.id, deps);
    /** @type {Set<string>} */
    const seen = new Set();
    /**
     * Documents to label, collected during the pass and summarised AFTER it.
     *
     * Deliberately not inline: a summary is a model call per document, and
     * running one between every ingest would turn a 40-file folder refresh
     * into 40 serial round trips inside a tick that has a time budget. The
     * document is already stored and searchable by then — the label is what
     * arrives a moment later.
     * @type {import('./syncItem').SummaryList}
     */
    const summarise = [];

    const window = itemWindow(await adapter.enumerate(source, ctx, deps), ctx, counts);

    const pass = { adapter, byExternalId, seen, counts, summarise };
    for (const item of window) {
        // Between documents: the one place a stop is safe.
        if (await deps.kbSourcesStore.isCancelRequested(source.id)) { counts.cancelled = true; break; }
        if (ctx.now() > ctx.deadline) { counts.truncated = true; break; }
        await syncItem(item, ctx, pass, deps);
    }

    await removeUnseenDocuments(ctx, { byExternalId, seen, counts }, deps);

    if (unmatchable.length) {
        ctx.log(`source ${source.id}: ${unmatchable.length} document(s) predate the source model and were left alone`);
    }

    if (counts.added || counts.updated || counts.removed) {
        await deps.kbStore.bumpKBVersion(kb.id);
    }

    await labelDocuments(summarise, ctx, deps);
    await recordTableVersion(ctx, counts, deps);
    await saveCursor(source, check.cursor, counts, ctx, deps);

    return { ...counts, nextRefreshAt: nextRefreshFor(source, { consecutiveErrors: 0 }) };
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

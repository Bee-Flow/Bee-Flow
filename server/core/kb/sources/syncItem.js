// @typecheck strict
/**
 * One item of a knowledge-source pass (core/kb/sources/index.js syncSource
 * runs it between its cancel and time checks), and the table version a
 * finished pass records.
 */

const { keepFetchedOriginal } = require('./keepOriginals');

/** @typedef {import('./index').SyncCtx} SyncCtx */
/** @typedef {import('./index').SyncDeps} SyncDeps */
/** @typedef {import('./index').SourceAdapter} SourceAdapter */
/** @typedef {import('./index').SourceItem} SourceItem */
/** @typedef {import('./index').FetchedDoc} FetchedDoc */
/** @typedef {{ added: number, updated: number, removed: number, unchanged: number, failed: number, cancelled: boolean, truncated: boolean }} PassCounts */
/** @typedef {Array<{ docId: string, text: string, title: string }>} SummaryList  documents to label after the pass */
/**
 * @typedef {{ adapter: SourceAdapter, byExternalId: Map<string, Record<string, any>>, seen: Set<string>,
 *   counts: PassCounts, summarise: SummaryList }} Pass  what a pass carries from item to item
 */
/** @typedef {{ orgId: string | null, userId: string | null }} Privacy */

/**
 * What the adapter knows about the file itself, for both ingest helpers.
 * @param {FetchedDoc} fetched
 */
function fileFacts(fetched) {
    return {
        sourceModifiedAt: fetched.sourceModifiedAt || null,
        sizeBytes: fetched.sizeBytes ?? null,
        mime: fetched.mime || null,
        pageCount: fetched.pageCount ?? null,
        sheetCount: fetched.sheetCount ?? null,
    };
}

/**
 * Changed: reingest, which keeps the documents row.
 * @param {SyncCtx} ctx
 * @param {{ stored: Record<string, any>, fetched: FetchedDoc, externalId: string, privacy: Privacy }} doc
 * @param {Pass} pass
 * @param {SyncDeps} deps
 */
async function refreshStored(ctx, { stored, fetched, externalId, privacy }, { counts, summarise }, deps) {
    const { kb } = ctx;
    const reingested = await deps.helpers.reingestDocument(ctx.tenantId, kb.id, stored.id, fetched.content, {
        title: fetched.title || stored.title,
        // What the adapter knows about the thing itself — a meeting's own
        // date, the rows a block covers. Present only when there IS
        // something: an explicit null here means "clear the column", and an
        // adapter with nothing to add must not erase what an earlier pass wrote.
        ...(fetched.metadata ? { metadata: fetched.metadata } : {}),
        externalId,
        ...fileFacts(fetched),
        onFailure: 'record',
        privacy,
    });
    counts.updated += 1;
    await keepFetchedOriginal({ kb, tenantId: ctx.tenantId, docId: stored.id, status: reingested?.status, fetched, log: ctx.log, deps });
    summarise.push({ docId: stored.id, text: fetched.content, title: fetched.title || stored.title });
}

/**
 * New: ingest.
 * @param {SyncCtx} ctx
 * @param {{ fetched: FetchedDoc, externalId: string, privacy: Privacy }} doc
 * @param {Pass} pass
 * @param {SyncDeps} deps
 */
async function ingestNew(ctx, { fetched, externalId, privacy }, { adapter, counts, summarise }, deps) {
    const { source, kb } = ctx;
    const made = await deps.helpers.ingestDocument(
        ctx.tenantId, kb.id, fetched.content, fetched.title || externalId,
        fetched.sourceType || source.kind, fetched.sourceUri || null,
        {
            sourceId: source.id,
            metadata: fetched.metadata || null,
            externalId,
            // An adapter whose items carry their OWN identity (a table row is
            // its id, not its text) opts out of the text-similarity duplicate
            // filter: two invoices from one supplier differ in a date and an
            // amount, and "near-identical" is exactly what distinct rows of a
            // narrow table look like.
            skipDedup: adapter.dedupe === false,
            ...fileFacts(fetched),
            createdBy: source.createdBy || null,
            onFailure: 'record',
            privacy,
        },
    );
    counts.added += 1;
    await keepFetchedOriginal({ kb, tenantId: ctx.tenantId, docId: made?.document?.id, status: made?.status, fetched, log: ctx.log, deps });
    if (made?.document?.id && made.status !== 'skipped') {
        summarise.push({ docId: made.document.id, text: fetched.content, title: fetched.title || externalId });
    }
}

/**
 * Compare one item the source offers with what is stored, and act on the
 * difference: nothing when unchanged, reingest when changed, ingest when new.
 * One document failing is a row with a reason on it, not a failed refresh:
 * the other files in the folder still belong here.
 * @param {SourceItem} item
 * @param {SyncCtx} ctx
 * @param {Pass} pass
 * @param {SyncDeps} deps
 */
async function syncItem(item, ctx, pass, deps) {
    const { source, kb } = ctx;
    const { adapter, byExternalId, seen, counts } = pass;
    const externalId = String(item.externalId);
    seen.add(externalId);
    const stored = byExternalId.get(externalId) || null;

    try {
        // A row the text filter once marked duplicate has no chunks of its
        // own. For an adapter that has since said its items are never
        // duplicates of each other, "unchanged" would keep it empty for
        // ever; it is rebuilt instead, once, and reads as itself after.
        const wronglyDuplicate = adapter.dedupe === false && stored?.status === 'duplicate';
        if (stored && !wronglyDuplicate && adapter.isUnchanged(item, stored)) {
            counts.unchanged += 1;
            return;
        }
        const fetched = await adapter.fetch(item, stored, ctx, deps);
        if (fetched === null) { counts.unchanged += 1; return; } // adapter found it unchanged after all

        /**
         * The privacy screen applies to a scheduled refresh exactly as it
         * does to an upload. A folder source pulls in whatever the folder
         * gained since last week, at 06:00, with nobody looking — which
         * is precisely the ingest that most needs screening, not least.
         */
        const privacy = { orgId: kb.organization_id || null, userId: source.createdBy || null };
        if (stored) await refreshStored(ctx, { stored, fetched, externalId, privacy }, pass, deps);
        else await ingestNew(ctx, { fetched, externalId, privacy }, pass, deps);
    } catch (e) {
        counts.failed += 1;
        ctx.log(`source ${source.id} item ${externalId} failed: ${/** @type {Error} */ (e).message}`);
    }
}

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
 * @param {SyncCtx} ctx
 * @param {PassCounts} counts
 * @param {SyncDeps} deps
 */
async function recordTableVersion(ctx, counts, deps) {
    const { source } = ctx;
    if (source.kind !== 'datatable' || counts.cancelled || counts.truncated) return;
    try {
        const datatableId = source.config?.datatableId;
        const dtStore = deps.datatableStore || require('../../../stores/datatableStore');
        const version = datatableId ? await dtStore.getDataVersion(datatableId) : null;
        const related = ctx.relatedTables && typeof ctx.relatedTables === 'object' ? ctx.relatedTables : null;
        // The store's `related` parameter defaults to null and is typed from that default; it takes the map.
        const sources = /** @type {{ setSeenDataVersion(id: string, dataVersion: number, related: Record<string, number> | null): Promise<unknown> }} */ (deps.kbSourcesStore);
        if (version !== null) await sources.setSeenDataVersion(source.id, version, related);
    } catch (e) {
        // The backstop simply arms once more; nothing is lost.
        ctx.log(`could not record the table version for source ${source.id}: ${/** @type {Error} */ (e).message}`);
    }
}

module.exports = { syncItem, recordTableVersion };

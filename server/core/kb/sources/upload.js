// @typecheck
/**
 * Uploaded files as a knowledge source.
 *
 * ── THERE IS NOTHING TO ENUMERATE ───────────────────────────────────
 * An upload source has no upstream. Nobody can add a file to it except a
 * person, through `POST /:id/sources/:sid/files`, and that route ingests
 * immediately. So `enumerate` returns the documents WE hold — which makes
 * "refresh" mean the one useful thing it can mean here:
 *
 *   RETRY WHAT DID NOT WORK.
 *
 * A PDF that failed because the extractor was briefly unavailable, or a scan
 * that was skipped because OCR was off at the time, is a row sitting there
 * with a reason on it. Pressing "Refresh now" re-extracts exactly those from
 * the text already stored, and leaves everything that succeeded alone.
 *
 * That is also why this kind supports `manual` only: there is no upstream
 * whose changes a schedule could catch, and a nightly job that re-tried the
 * same broken scan 365 times a year would be pure noise.
 */

const supportsModes = ['manual'];
const defaultMode = 'manual';

/** Statuses a refresh should have another go at. */
const RETRYABLE = new Set(['skipped', 'error']);

/**
 * The rows worth another attempt.
 *
 * `processed` and `redacted` rows are deliberately absent: re-embedding a
 * file that worked costs money and changes nothing. A `duplicate` is absent
 * too — it is a deliberate record of an attempt, not a failure.
 */
async function enumerate(source, ctx, deps) {
    const store = deps.kbStore;
    const out = [];
    const PAGE = 200;
    for (let offset = 0; offset < 10_000; offset += PAGE) {
        const page = await store.listDocuments(ctx.kbId, {
            limit: PAGE, offset,
            filters: { sourceId: source.id, status: [...RETRYABLE] },
        });
        if (!page || page.length === 0) break;
        for (const d of page) {
            // A row with no external_id cannot be matched by the engine's
            // index, so give it one that is stable for this document: its own
            // id. Re-running never creates a second row for the same file.
            out.push({ externalId: String(d.external_id || d.id), docId: d.id, title: d.title });
        }
        if (page.length < PAGE) break;
    }
    return out;
}

/** A retryable row is by definition worth retrying. */
function isUnchanged() {
    return false;
}

/**
 * Re-extract from what is already stored.
 *
 * The original bytes are gone — the product stores extracted text, not the
 * uploaded file — so this is a re-run of the LATER half of ingest: chunk,
 * embed, and (once K4 lands) screen for personal data. A row whose stored
 * text is empty is exactly the case that failed at extraction, and there is
 * nothing here that can fix it; it is reported so the reason on the row stays
 * the true one rather than being overwritten by a vaguer second failure.
 */
async function fetch(item, stored, ctx, deps) {
    const doc = await deps.kbStore.getDocument(item.docId);
    if (!doc) throw new Error('Document no longer exists');
    const content = doc.original_content || '';
    if (!content.trim()) {
        throw new Error(stored?.status_reason || 'No text was extracted from this file');
    }
    return {
        content,
        title: doc.title,
        sourceType: doc.source_type || 'upload',
        sourceUri: doc.source_uri || null,
        sourceModifiedAt: doc.source_modified_at || null,
        sizeBytes: doc.size_bytes ?? null,
        mime: doc.mime || null,
        pageCount: doc.page_count ?? null,
        sheetCount: doc.sheet_count ?? null,
    };
}

module.exports = { enumerate, fetch, isUnchanged, supportsModes, defaultMode, RETRYABLE };

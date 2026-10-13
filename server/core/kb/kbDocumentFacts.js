// @typecheck
/**
 * What a retrieved chunk cannot say about itself, read from its `documents`
 * row (kind, meeting date, table rows, the metadata bag for relationHop).
 */

const { getClient } = require('../../db');
const log = require('../../telemetry/log');

/**
 * Source types a citation is allowed to learn from `documents`.
 *
 * An ALLOW-LIST, not "whatever the column says". These three are the kinds the
 * client draws its own glyph for and could never reach, because retrieval
 * never read the column — so filling them in makes dead branches live. Letting
 * every other value through would instead restyle chips that render correctly
 * today ('upload' and 'text' have no glyph of their own and would drop to the
 * generic one), which is a visible change nobody asked for.
 */
const CITED_SOURCE_TYPES = new Set(['meeting', 'datatable', 'webpage']);

/** `documents.id` is a uuid column; `kb_chunks.document_id` is free text. */
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What the chunk row cannot say, read from the document it belongs to.
 *
 * `kb_chunks` holds the passage; `documents` holds what the passage is OF —
 * the kind it is, the meeting's own date, the table rows a block covers. The
 * retrieval projections never joined the two, so every one of those arrived as
 * null no matter how carefully the ingest adapter had filled it in.
 *
 * A second small query rather than a join in the two hot SELECTs: this one
 * runs on the survivors — a handful of ids, after the reranker has thrown the
 * candidates away — and the SELECTs above stay the shape their own test pins.
 * It fails soft in every direction: no document row, no metadata, no query at
 * all, and the citation renders exactly as it did before.
 *
 * @param {Array<object>} rows — retrieval rows, mutated in place
 * @param {object} [deps]
 * @param {object} [deps.client] - an open connection to borrow; when absent
 *   one is acquired and released here. Search hands over none: by this point
 *   it has deliberately let its own go, so the reranker's HTTP calls do not
 *   hold a connection open.
 */
async function enrichWithDocumentFacts(rows, { client: borrowed = null } = {}) {
    // Lowercased because the two columns disagree on case, and filtered to
    // things that ARE uuids: `d.id = ANY($1::uuid[])` is an index lookup on
    // the primary key, where `LOWER(d.id::text) = …` would scan the table on
    // every search. A document_id that is not a uuid simply gets no extra
    // detail, which is the same "renders as it did before" this whole function
    // falls back to.
    const ids = [...new Set((rows || [])
        .map(r => r?.document_id)
        .filter(Boolean)
        .map(id => String(id).toLowerCase())
        .filter(id => UUID_RX.test(id)))];
    if (ids.length === 0) return rows;

    let client = borrowed;
    try {
        if (!client) client = await getClient();
        // The uuid type normalises case, so the cast does the matching that
        // the orphan purge has to do with LOWER() on both sides.
        const { rows: docs } = await client.query(
            `SELECT LOWER(d.id::text) AS doc_id, d.source_type, d.metadata
               FROM documents d
              WHERE d.id = ANY($1::uuid[])`,
            [ids]
        );
        const byId = new Map(docs.map(d => [d.doc_id, d]));

        for (const row of rows) {
            const doc = row?.document_id ? byId.get(String(row.document_id).toLowerCase()) : null;
            if (!doc) continue;
            if (CITED_SOURCE_TYPES.has(doc.source_type)) row.kind = doc.source_type;

            let meta = doc.metadata;
            if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch (_) { meta = null; } }
            if (!meta || typeof meta !== 'object') continue;

            // The whole bag and the kind, for `relationHop` — which needs the
            // table id, the row id and the relation entries of a table-row
            // hit. Non-enumerable, so a route that serialises the rows as its
            // response does not ship every document's metadata to the client.
            Object.defineProperty(row, 'doc_meta', { value: meta, enumerable: false, writable: true, configurable: true });
            Object.defineProperty(row, 'doc_kind', { value: doc.source_type || null, enumerable: false, writable: true, configurable: true });

            if (meta.rowStart != null) row.row_start = meta.rowStart;
            if (meta.rowEnd != null) row.row_end = meta.rowEnd;
            // `meetingDate` is what the meeting adapter has always called it.
            const occurred = meta.occurredAt || meta.meetingDate;
            if (occurred) row.occurred_at = occurred;
        }
    } catch (err) {
        log.warn(`[LocalKBSearch] Document facts lookup failed: ${err.message}`);
    } finally {
        if (!borrowed) client?.release();
    }
    return rows;
}

module.exports = { enrichWithDocumentFacts };

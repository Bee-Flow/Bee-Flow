// @typecheck
/**
 * relationHop — one exact hop along datatable relations, at query time.
 *
 * ── WHAT IT ADDS ────────────────────────────────────────────────────
 * A knowledge base with an Orders table and a Suppliers table holds two kinds
 * of document that point at each other by id: the order's `supplier` cell is
 * the supplier row's id. Similarity search finds each on its own — "what did
 * we order from Van Dijk" hits the Van Dijk row and never the orders, unless
 * somebody typed the name into every order. This walks the ids instead:
 *
 *   forward  — a hit on an order pulls in the supplier it points at;
 *   reverse  — a hit on a supplier pulls in the orders that point at it,
 *              the few most relevant to the question, and says how many
 *              there are in all.
 *
 * Both are joins on ids the tables already hold (`documents.metadata`:
 * `datatableId`, `rowIds`, `relations[]`, written by the datatable source).
 * Nothing is extracted from text and nothing is guessed, which is why it can
 * run on every search.
 *
 * ── WHERE IT RUNS, AND WHAT IT MAY COST ─────────────────────────────
 * After the reranker, on the survivors only (at most `LIMITS.anchors` of
 * them), with its own connection and its own time budget. The linked rows are
 * folded INTO the anchor passage rather than added as passages of their own:
 * every consumer downstream — the score floors, the near-duplicate filter,
 * the top-K cut, the per-passage token cap — ranks and trims passages, and a
 * linked row with no score of its own would be the first thing thrown away.
 * Inside the passage it survives exactly as long as the hit that earned it.
 *
 * The reverse side is bounded on the database, not in Node: the documents
 * pointing at a row are found by a containment query the GIN index answers,
 * and ORDERED there — by vector distance to the question when there is a
 * query vector, by text rank when there is not — with a LIMIT of three. A
 * supplier with fifty thousand orders costs one indexed query, and the model
 * is told "50 000 rows, the 3 most relevant", which is the honest answer.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────
 * It only ever reads documents that are already in the knowledge bases being
 * searched. A table attached to the base is a table its owner chose to expose;
 * a table merely pointed at is not, and its rows are not fetched here even
 * when the owner could read them. Attaching both tables is how a person says
 * the join is wanted, and it is the only way to get it.
 *
 * It never throws into the search. Every failure is a warning and an
 * unchanged passage.
 */

'use strict';

const telemetryLog = require('../../telemetry/log');

const LIMITS = Object.freeze({
    /** Hits that may be expanded. Beyond the top few, a hop is noise. */
    anchors: 4,
    /** Rows a hit's own relation cells pull in. */
    forwardPerAnchor: 3,
    /** Rows pointing at a hit that are shown (the count is always given). */
    reversePerAnchor: 3,
    /** Wall-clock budget for the whole hop; anchors past it are left alone. */
    budgetMs: 400,
    /** Characters the linked block may add to one passage. */
    maxLinkedChars: 1500,
    /** Characters one linked row may take. */
    rowChars: 400,
    /** Chunks read from one document when looking for a row in a block. */
    chunksPerDoc: 12,
});

/** A retrieval row this can hop from: a single table row with a known table. */
function isAnchor(row) {
    const meta = row?.doc_meta;
    return !!(row && row.doc_kind === 'datatable' && meta && typeof meta === 'object' && meta.datatableId
        && Array.isArray(meta.rowIds) && meta.rowIds.length === 1);
}

/** The distinct relation targets of a document's metadata, capped. */
function forwardTargets(meta, cap) {
    const seen = new Set();
    const out = [];
    for (const r of (Array.isArray(meta?.relations) ? meta.relations : [])) {
        if (!r || !r.table || r.rowId === undefined || r.rowId === null) continue;
        const key = `${r.table}\u0001${r.rowId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ column: r.column || null, table: String(r.table), rowId: String(r.rowId), label: r.label || null });
        if (out.length >= cap) break;
    }
    return out;
}

/** One row's text on one line: "a: 1 | b: 2", clipped. */
function compactRow(text, maxChars) {
    const one = String(text || '').split('\n').map(s => s.trim()).filter(Boolean).join(' | ');
    return one.length > maxChars ? `${one.slice(0, maxChars - 1)}…` : one;
}

/**
 * In a document that is a block of rows (rows separated by a blank line), the
 * row that names `label`; else the first. A single-row document is its own
 * only block.
 */
function pickRowBlock(content, label) {
    const blocks = String(content || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
    if (blocks.length === 0) return '';
    if (label) {
        const needle = String(label).toLowerCase();
        const hit = blocks.find(b => b.toLowerCase().includes(needle));
        if (hit) return hit;
    }
    return blocks[0];
}

/** The chunk of a document that mentions `label`, else its first. */
function pickChunk(chunks, label) {
    if (!chunks.length) return null;
    if (label) {
        const needle = String(label).toLowerCase();
        const hit = chunks.find(c => String(c.content || '').toLowerCase().includes(needle));
        if (hit) return hit;
    }
    return chunks[0];
}

// ── The two hops ────────────────────────────────────────────────────

/**
 * The rows this document's relation cells point at, as they are in the base.
 * @returns {Promise<Array<{column, table, title, tableName, chunkId, text}>>}
 */
async function forwardHop(client, kbIds, meta, limits) {
    const targets = forwardTargets(meta, limits.forwardPerAnchor);
    if (targets.length === 0) return [];
    const found = await Promise.all(targets.map(async (t) => {
        const { rows: docs } = await client.query(
            `SELECT d.id::text AS id, d.title, d.tenant_id, d.knowledge_base_id::text AS kb_id,
                    d.metadata->>'tableName' AS table_name
               FROM documents d
              WHERE d.knowledge_base_id = ANY($1::uuid[])
                AND d.status <> 'duplicate'
                AND d.metadata @> $2::jsonb
              LIMIT 1`,
            [kbIds, JSON.stringify({ datatableId: t.table, rowIds: [t.rowId] })],
        );
        const doc = docs[0];
        if (!doc) return null;
        const { rows: chunks } = await client.query(
            `SELECT id, content, chunk_id
               FROM kb_chunks
              WHERE tenant_id = $1 AND knowledge_base_id = $2 AND document_id = $3
              ORDER BY chunk_id ASC
              LIMIT $4`,
            [doc.tenant_id, doc.kb_id, doc.id, limits.chunksPerDoc],
        );
        const chunk = pickChunk(chunks, t.label);
        if (!chunk) return null;
        return {
            column: t.column,
            table: t.table,
            title: t.label || doc.title || '',
            tableName: doc.table_name || null,
            chunkId: chunk.id,
            text: pickRowBlock(chunk.content, t.label),
        };
    }));
    return found.filter(Boolean);
}

/**
 * The rows pointing at this one: how many per table, and the few most
 * relevant to the question, ranked on the database.
 * @returns {Promise<{counts: Array<{tableName, n}>, rows: Array<{chunkId, title, tableName, text}>}>}
 */
async function reverseHop(client, kbIds, { table, rowId, title }, q, limits) {
    const needle = JSON.stringify({ relations: [{ table, rowId }] });
    const entry = JSON.stringify({ table, rowId });

    // Rows, not documents: a block of fifty orders that holds three for this
    // supplier is three, and the containment above only says the block has
    // at least one.
    const countPromise = client.query(
        `SELECT d.metadata->>'tableName' AS table_name, count(*)::int AS n
           FROM documents d, jsonb_array_elements(d.metadata->'relations') r
          WHERE d.knowledge_base_id = ANY($1::uuid[])
            AND d.status <> 'duplicate'
            AND d.metadata @> $2::jsonb
            AND r @> $3::jsonb
          GROUP BY 1
          ORDER BY n DESC`,
        [kbIds, needle, entry],
    );

    const select = `SELECT c.id, c.content, c.chunk_id, d.title, d.metadata->>'tableName' AS table_name
           FROM documents d
           JOIN kb_chunks c
             ON c.document_id = d.id::text
            AND c.knowledge_base_id = d.knowledge_base_id::text
            AND c.tenant_id = d.tenant_id
          WHERE d.knowledge_base_id = ANY($1::uuid[])
            AND d.status <> 'duplicate'
            AND d.metadata @> $2::jsonb`;
    let rowsPromise;
    if (q.vectorStr) {
        rowsPromise = client.query(
            `${select}
          ORDER BY c.embedding <=> $4::vector, c.chunk_id ASC
          LIMIT $3`,
            [kbIds, needle, limits.reversePerAnchor, q.vectorStr],
        );
    } else if (q.query && q.query.trim()) {
        rowsPromise = client.query(
            `${select}
          ORDER BY ts_rank_cd(c.tsv, websearch_to_tsquery('simple', $4)) DESC,
                   d.source_modified_at DESC NULLS LAST, c.chunk_id ASC
          LIMIT $3`,
            [kbIds, needle, limits.reversePerAnchor, q.query.trim()],
        );
    } else {
        rowsPromise = client.query(
            `${select}
          ORDER BY d.source_modified_at DESC NULLS LAST, c.chunk_id ASC
          LIMIT $3`,
            [kbIds, needle, limits.reversePerAnchor],
        );
    }

    const [{ rows: counts }, { rows: chunks }] = await Promise.all([countPromise, rowsPromise]);
    return {
        counts: counts.map(c => ({ tableName: c.table_name || null, n: Number(c.n) || 0 })),
        rows: chunks.map(c => ({
            chunkId: c.id,
            title: c.title || '',
            tableName: c.table_name || null,
            // In a block, the row that names the anchor; a single-row
            // document is its own only block.
            text: pickRowBlock(c.content, title),
        })),
    };
}

// ── Folding it into the passage ─────────────────────────────────────

/**
 * Append the linked rows to the anchor's content and describe them on
 * `anchor.linked` (the citation carries that to the chip). Rows whose chunk
 * is already a passage of its own are counted but not repeated: the model
 * has them, and repeating them would make two passages read as one to the
 * near-duplicate filter downstream.
 */
function applyToAnchor(anchor, fwd, rev, present, limits, stats) {
    const parts = [];
    const linked = [];

    for (const f of fwd) {
        stats.forward += 1;
        linked.push({ kind: 'row', column: f.column, table: f.tableName, title: f.title });
        if (present.has(String(f.chunkId))) continue;
        const head = `${f.column ? `${f.column} → ` : ''}${f.tableName ? `${f.tableName}: ` : ''}${f.title}`.trim();
        parts.push(`${head}\n${compactRow(f.text, limits.rowChars)}`);
    }

    const shownByTable = new Map();
    const rowLines = [];
    for (const r of rev.rows) {
        stats.reverse += 1;
        if (present.has(String(r.chunkId))) continue;
        shownByTable.set(r.tableName, (shownByTable.get(r.tableName) || 0) + 1);
        rowLines.push(`- ${r.title ? `${r.title}: ` : ''}${compactRow(r.text, limits.rowChars)}`);
    }
    for (const c of rev.counts) {
        const shown = shownByTable.get(c.tableName) || 0;
        linked.push({ kind: 'rows', table: c.tableName, count: c.n, shown });
    }
    if (rev.counts.length) {
        const summary = rev.counts
            .map(c => `${c.tableName || 'Rows'}: ${c.n}`)
            .join(', ');
        const head = `Rows pointing at this one — ${summary}`;
        parts.push(rowLines.length
            ? `${head}. The ${rowLines.length} most relevant:\n${rowLines.join('\n')}`
            : head);
    }

    // The chip is told what was found even when nothing had to be added —
    // the linked row being a passage of its own is still how it was found.
    if (linked.length) anchor.linked = linked;
    if (parts.length === 0) return;
    let block = `[Linked rows]\n${parts.join('\n\n')}`;
    if (block.length > limits.maxLinkedChars) block = `${block.slice(0, limits.maxLinkedChars - 1)}…`;
    anchor.content = `${anchor.content || ''}\n\n${block}`;
}

/**
 * Expand the table-row hits among `results` by one hop, in place.
 *
 * @param {Array<object>} results  retrieval rows, after `enrichWithDocumentFacts`
 * @param {object} opts
 * @param {string[]} opts.kbIds
 * @param {string}   [opts.query]      the question, for text ranking
 * @param {string}   [opts.vectorStr]  its embedding as a pgvector literal, for vector ranking
 * @param {Function} [opts.getClient]  test seam
 * @param {object}   [opts.limits]     test seam
 * @param {object}   [opts.log]        test seam
 * @returns {Promise<{anchors:number, forward:number, reverse:number}>}
 */
async function expandRelations(results, opts = /** @type {any} */ ({})) {
    const limits = { ...LIMITS, ...(opts.limits || {}) };
    const log = opts.log || ((m) => telemetryLog.info(`[LocalKBSearch] ${m}`));
    const kbIds = Array.isArray(opts.kbIds) ? opts.kbIds.filter(Boolean).map(String) : [];
    const stats = { anchors: 0, forward: 0, reverse: 0 };
    if (!Array.isArray(results) || results.length === 0 || kbIds.length === 0) return stats;

    const anchors = results.filter(isAnchor).slice(0, limits.anchors);
    if (anchors.length === 0) return stats;
    stats.anchors = anchors.length;

    const started = Date.now();
    const getClient = opts.getClient || require('../../db').getClient;
    const client = await getClient();
    const present = new Set(results.map(r => String(r.id)));
    try {
        await Promise.all(anchors.map(async (anchor) => {
            if (Date.now() - started > limits.budgetMs) return;
            const meta = anchor.doc_meta;
            const table = String(meta.datatableId);
            const rowId = String(meta.rowIds[0]);
            try {
                const [fwd, rev] = await Promise.all([
                    forwardHop(client, kbIds, meta, limits),
                    reverseHop(client, kbIds, { table, rowId, title: anchor.title || null },
                        { vectorStr: opts.vectorStr || null, query: opts.query || '' }, limits),
                ]);
                applyToAnchor(anchor, fwd, rev, present, limits, stats);
            } catch (e) {
                log(`Relation hop skipped for a passage: ${e.message}`);
            }
        }));
    } finally {
        client.release();
    }
    log(`Relations: ${stats.anchors} anchor(s), ${stats.forward} linked, ${stats.reverse} pointing here [${Date.now() - started}ms]`);
    return stats;
}

module.exports = {
    expandRelations,
    isAnchor, forwardTargets, compactRow, pickRowBlock, pickChunk, applyToAnchor,
    LIMITS,
};

// @typecheck
/**
 * ONE citation shape, for every surface that shows where an answer came from.
 *
 * ── WHY THIS IS A MODULE AND NOT FOUR OBJECT LITERALS ───────────────
 * Four places emitted a `kb_sources` event and each built its own shape:
 *
 *   core/agentRuntime/knowledgeSearch.js   { title, section, content, score, type }
 *   integrations/kbSearchTools.js          { title, section, content, score, type }
 *   routes/ai/directChat/streamTurn.js     (passes the tool's through)
 *   routes/ai/notebookChat.js              { title, content, preview, score }
 *
 * They agreed on enough to look interchangeable and differed on enough to not
 * be. The notebook one sent `preview` where the overlay reads `content`, so
 * every citation popup in notebooks said "No content preview available" — the
 * text had been fetched, scored and sent under a key nothing consumed. That is
 * the failure mode of four shapes: not a crash, a blank panel nobody can
 * explain.
 *
 * And none of them carried an ID. A chip could say "Personeelshandboek" and
 * nothing more — no way to open the document, and no way to say WHICH of its
 * forty pages, because the ids had been dropped by the reranker (see
 * `applyRerank` in localKBIngest.js) long before the citation was built.
 *
 * ── THE SHAPE ───────────────────────────────────────────────────────
 *   {
 *     title,        the document, as a person would name it
 *     kind,         'kb_chunk' | 'notebook' | 'webpage' | 'meeting' | …
 *     sourceId,     the kb_sources row this came from, when known
 *     sourceName,   that source's name ("Nextcloud · /Sales")
 *     documentId,   the documents row — what a chip opens
 *     chunkId,      the passage, for fetching it back
 *     datatableId,  the table a LIVE row was read from, when it was one
 *     rowId,        that row's own id — what makes the quote checkable
 *     page,         1-based page number, when the chunker knew one
 *     rowStart,     first table row this passage covers, 1-based
 *     rowEnd,       last one — a block of rows is a page's equivalent
 *     occurredAt,   when the thing happened (a meeting's own date), ISO
 *     section,      the heading the passage sits under
 *     content,      the passage itself — what the overlay shows
 *     score,        the retriever's relevance, RELATIVE and never a percentage
 *   }
 *
 * Everything after `title` may be absent. A citation is worth showing with
 * only a title, and a client that requires more of it would show nothing for
 * every document ingested before pages existed.
 *
 * ── WHERE A PASSAGE SITS, WHEN IT HAS NO PAGE ───────────────────────
 * `page` answers "which part of this document" for a PDF and for nothing
 * else. A datatable passage is a block of rows and a meeting note is a day,
 * and both used to cite as a bare title — the same uncheckable chip a page
 * number exists to prevent. So `rowStart`/`rowEnd` and `occurredAt` are the
 * same field in a different unit, and they are optional in exactly the same
 * way: absent for everything ingested before they existed, and never faked.
 *
 * ── A LIVE TABLE ROW IS NOT A DOCUMENT ──────────────────────────────
 * `datatableId`/`rowId` cite a row that was read AT QUESTION TIME, by
 * `core/tools/datatableTools.js`, straight out of the table — there is no
 * `documents` row, no chunk and no ingest behind it, so `documentId`/`chunkId`
 * are null and these two are what a chip can be opened and re-checked with.
 *
 * That is a DIFFERENT thing from the datatable KNOWLEDGE SOURCE
 * (`core/kb/sources/datatable.js`), which copies rows into documents on a
 * schedule and cites them as `kb_chunk` with `documentId`/`rowStart`/`rowEnd`
 * like any other document. Same table, two routes, and the pair of ids is how
 * a reader tells "this is the row, now" from "this is what we ingested on
 * Tuesday". `kind: 'datatable_row'` names the live one.
 *
 * ── `preview` IS AN ALIAS, FOR ONE RELEASE ──────────────────────────
 * An older client reads `preview`. It is written alongside `content` so a page
 * left open across a deploy keeps working, and it comes out on the next pass.
 * New code reads `content`.
 */

/**
 * Every field a citation may carry, in the order they are worth reading.
 *
 * This is the contract, not a comment: `citation.test.js` compares it against
 * what `toCitation` actually returns, so a field added to one and forgotten in
 * the other fails there instead of arriving as `undefined` in a chip. (It was
 * a comment for one release, and drifted immediately — `preview` was emitted
 * and never listed.)
 */
const CITATION_FIELDS = Object.freeze([
    'title', 'kind', 'sourceId', 'sourceName', 'documentId', 'chunkId',
    'datatableId', 'rowId',
    'page', 'rowStart', 'rowEnd', 'occurredAt', 'section', 'content', 'score',
    'linked',
]);

/**
 * What a passage pulled in along its table relations, for the chip that says
 * "found via" — `relationHop` sets it on a retrieval row. Each entry is one of:
 *
 *   { kind: 'row',  column, table, title }   the row a relation cell points at
 *   { kind: 'rows', table, count, shown }    rows pointing at this one
 *
 * Null when there was nothing, which is every passage that is not a table row.
 * Only the shape above survives: a chip must not be handed a bag it did not
 * ask for.
 */
function linkedOf(row) {
    const list = Array.isArray(row?.linked) ? row.linked : null;
    if (!list || list.length === 0) return null;
    const out = [];
    for (const l of list) {
        if (!l || typeof l !== 'object') continue;
        if (l.kind === 'row') {
            out.push({ kind: 'row', column: l.column ? String(l.column) : null, table: l.table ? String(l.table) : null, title: String(l.title || '') });
        } else if (l.kind === 'rows') {
            out.push({ kind: 'rows', table: l.table ? String(l.table) : null, count: Number(l.count) || 0, shown: Number(l.shown) || 0 });
        }
    }
    return out.length ? out : null;
}

/**
 * The heading a passage sits under, plus enough of its first sentence to tell
 * two passages of the same section apart.
 *
 * The DEEPEST heading, not the first: a chunk that starts under "4. Verlof"
 * and runs into "4.2 Bijzonder verlof" is about the second one. All four
 * emitters worked this out for themselves, with three slightly different
 * regexes between them.
 */
function sectionLabelOf(content, fallbackIndex = 0) {
    const text = String(content || '');
    const headings = text.match(/^#{1,6}\s+(.+)$/gm) || [];
    const deepest = headings.length > 0
        ? headings[headings.length - 1].replace(/^#{1,6}\s+/, '').trim()
        : null;
    // Strip headings and table rows before looking for a sentence: a markdown
    // table's first row is not a sentence, and it reads as noise in a chip.
    const body = text.replace(/^#{1,6}\s+.+$/gm, '').replace(/^\|.*$/gm, '').trim();
    const snippet = body.split(/[.!?\n]/).find(s => s.trim().length > 10)?.trim() || '';

    if (deepest && snippet) return `${deepest} — ${snippet.slice(0, 60)}`;
    if (deepest) return deepest;
    if (snippet) return snippet.slice(0, 80);
    return `Chunk ${fallbackIndex + 1}`;
}

/** A whole number above zero, or null — how every ordinal here is counted. */
function positiveInt(raw) {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** A positive integer page, or null. Page 0 is not a page anybody counts from. */
function pageOf(row) {
    return positiveInt(row?.page ?? row?.page_start ?? row?.pageStart);
}

/**
 * The table rows a passage covers, 1-based and inclusive — or neither end.
 *
 * BOTH or NOTHING, on purpose. "rows 12–" is not a range anybody can check,
 * and an end before its start is arithmetic nobody meant; a chip that prints
 * half a range is worse than one that leaves it out, because it looks
 * answered. Same rule as the page: when it is not certain, it is not shown.
 */
function rowRangeOf(row) {
    const meta = row?.metadata || {};
    const start = positiveInt(row?.row_start ?? row?.rowStart ?? meta.rowStart);
    const end = positiveInt(row?.row_end ?? row?.rowEnd ?? meta.rowEnd);
    if (start === null || end === null || end < start) return { rowStart: null, rowEnd: null };
    return { rowStart: start, rowEnd: end };
}

/**
 * The LIVE table row a citation quotes — both ids, or neither.
 *
 * Same rule as the row range above, for the same reason: a chip carrying a
 * table id and no row says "somewhere in Producten", which is not a reference
 * anybody can check, and a row id with no table cannot be resolved at all.
 * So the pair is atomic.
 *
 * Read only from EXPLICIT keys. `row.id` is deliberately not consulted — it
 * already means "chunk id" one line up in `toCitation`, and every kb_chunk row
 * carries one, so borrowing it here would stamp a datatable reference onto
 * every ordinary document citation in the product.
 */
function rowRefOf(row) {
    const datatableId = row?.datatable_id ?? row?.datatableId ?? null;
    const rowId = row?.row_id ?? row?.rowId ?? null;
    if (datatableId === null || datatableId === undefined || rowId === null || rowId === undefined) {
        return { datatableId: null, rowId: null };
    }
    return { datatableId: String(datatableId), rowId: String(rowId) };
}

/**
 * When the thing the passage describes HAPPENED, as an ISO string.
 *
 * The meeting's own date, never `created_at` — that is when we ingested it,
 * and a chip reading "Salesoverleg · 3 sep" on a meeting held in July points
 * at the wrong week while looking precise.
 *
 * A Date or a parseable string, nothing else. A bare number is refused: 2026
 * is a year to every person who would type it and 1970-01-01 to `new Date()`.
 */
function occurredAtOf(row) {
    const meta = row?.metadata || {};
    const raw = row?.occurred_at ?? row?.occurredAt ?? meta.occurredAt ?? meta.meetingDate;
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString();
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Build one citation from a retrieval row.
 *
 * Accepts the shapes the retrieval layers actually produce — snake_case from
 * `kb_chunks`, camelCase from the source API, and the `metadata` bag the
 * Azure path wraps things in — because the alternative is each caller
 * normalising first, which is how the four shapes happened.
 *
 * @param {object} row
 * @param {object} [opts]
 * @param {number} [opts.index]        position, for the "Chunk N" fallback
 * @param {string} [opts.kind]         default kind when the row does not say
 * @param {object} [opts.source]       the kb_sources row, when the caller has it
 * @returns {object} a citation
 */
function toCitation(row, { index = 0, kind = 'kb_chunk', source = null } = {}) {
    const meta = row?.metadata || {};
    const title = row?.source_url
        || meta.source
        || meta.source_uri
        || row?.title
        || row?.source_uri
        || 'Unknown source';
    const { rowStart, rowEnd } = rowRangeOf(row);
    const rowRef = rowRefOf(row);

    return {
        title: String(title),
        kind: row?.kind || meta.type || kind,
        sourceId: row?.source_id ?? row?.sourceId ?? source?.id ?? null,
        sourceName: source?.name ?? row?.source_name ?? row?.sourceName ?? null,
        documentId: row?.document_id ?? row?.documentId ?? null,
        chunkId: row?.chunk_id ?? row?.chunkId ?? row?.id ?? null,
        // A live table row. NOT read from `row.id`, which the line above
        // already claims for `chunkId`: a datatable row's id is its own
        // identity and would arrive as a chunk id nothing can fetch. Both are
        // required or neither is set — half a row reference points at a table
        // without saying which row, which is exactly the uncheckable chip the
        // page number exists to prevent.
        datatableId: rowRef.datatableId,
        rowId: rowRef.rowId,
        page: pageOf(row),
        // Null for every citation that is not a block of table rows, which is
        // almost all of them — the chip then reads exactly as it did before.
        rowStart,
        rowEnd,
        occurredAt: occurredAtOf(row),
        section: row?.section || sectionLabelOf(row?.content, index),
        content: row?.content ?? '',
        score: Number(row?.score) || 0,
        linked: linkedOf(row),
        // One release only. An older client reads `preview` where this one
        // reads `content`; dropping it now blanks the overlay on any page left
        // open across the deploy.
        preview: row?.content ?? '',
    };
}

/** `toCitation` over a list, positions filled in. */
function toCitations(rows, opts = {}) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row, index) => toCitation(row, { ...opts, index }));
}

module.exports = {
    toCitation, toCitations, sectionLabelOf, pageOf, rowRangeOf, rowRefOf, occurredAtOf, CITATION_FIELDS,
};

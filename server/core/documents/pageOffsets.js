// @typecheck
/**
 * Where each page of an extracted document starts in its FLAT text.
 *
 * ── THE COORDINATE SYSTEM, AND WHY IT IS FIDDLY ─────────────────────
 * An extractor hands back both a `pages[]` array and one flat `text`. The flat
 * text is the NON-EMPTY pages joined by '\n\n' — empty pages are filtered out
 * before the join (see `pdfExtractor.js`). So anything that wants to map a
 * position in the flat text back to a page number has to walk the pages the
 * same way: skip the empty ones, and add the separator only BETWEEN successive
 * non-empty entries.
 *
 * Get that wrong by a single separator and an offset lands mid-word, or a page
 * boundary lands one page late — which for the DLP scanner means splicing a
 * redaction token into the wrong characters, and for the chunker means a
 * citation that says "p. 7" about text on page 8. Both are silent.
 *
 * ── WHY IT IS ITS OWN MODULE ────────────────────────────────────────
 * `core/dlp/attachmentScanner.js` worked this out twice for itself
 * (`_entitiesToFlatOffsets` and `_flatBoundaryForPages`, with a comment on the
 * second saying it must stay in step with the first). K6 needs the same walk a
 * third time, in the chunker, to stamp a page on each chunk. Three copies of a
 * rule whose failure mode is "off by two characters, silently" is two too
 * many.
 */

/**
 * The separator the extractors join pages with. Changing this without
 * changing the extractors moves every offset in the product.
 */
const FLAT_PAGE_SEPARATOR = '\n\n';

/**
 * A page's start offset in the flat text, for every non-empty page.
 *
 * @param {Array<{text?: string, pageNumber?: number}>} pages
 * @returns {Array<{ page: number, start: number, end: number }>}
 *          `end` is exclusive and does NOT include the separator, so
 *          `text.slice(start, end)` is exactly that page.
 */
function pageSpans(pages) {
    const spans = [];
    if (!Array.isArray(pages)) return spans;
    let cursor = 0;
    let prevWasNonEmpty = false;
    for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i]?.text || '';
        // An empty page is not in the flat text at all, so it occupies no
        // offsets — but it still HAPPENED, which is why the page number comes
        // off the page rather than off the position in this array.
        if (!pageText) continue;
        if (prevWasNonEmpty) cursor += FLAT_PAGE_SEPARATOR.length;
        const page = Number.isInteger(pages[i]?.pageNumber) ? pages[i].pageNumber : i + 1;
        spans.push({ page, start: cursor, end: cursor + pageText.length });
        cursor += pageText.length;
        prevWasNonEmpty = true;
    }
    return spans;
}

/**
 * The page a character offset falls on, or null when nothing can be said.
 *
 * An offset inside the '\n\n' BETWEEN two pages belongs to the page that just
 * ended: it is the boundary the previous page's text ran up to, and calling it
 * the next page would credit a passage to a page it does not appear on.
 *
 * @param {number} offset
 * @param {Array} spans   from `pageSpans`
 * @returns {number|null}
 */
function pageAt(offset, spans) {
    if (!Array.isArray(spans) || spans.length === 0) return null;
    if (!Number.isFinite(offset) || offset < 0) return null;
    let last = null;
    for (const span of spans) {
        if (offset < span.start) break;          // in a separator, or before the first page
        last = span.page;
        if (offset < span.end) return span.page;
    }
    // Past the end of the last page, or inside a separator: the page whose
    // text most recently covered this position.
    return last;
}

/**
 * Character offset in the flat text where the first `count` pages end.
 *
 * The DLP scanner's use: it scans a prefix of the pages and needs to know
 * exactly how much of the flat text that prefix covers, so the untouched
 * remainder can be re-attached without a token landing mid-word.
 *
 * Empty pages COUNT as scanned (the scanner walked past them) while occupying
 * no characters — which is precisely the case a naive `pages.slice(0, count)`
 * plus `.join()` gets wrong.
 */
function flatBoundaryForPages(pages, count) {
    let cursor = 0;
    let seen = 0;
    let prevWasNonEmpty = false;
    if (!Array.isArray(pages)) return 0;
    for (let i = 0; i < pages.length && seen < count; i++) {
        const pageText = pages[i]?.text || '';
        seen += 1;
        if (!pageText) continue;
        if (prevWasNonEmpty) cursor += FLAT_PAGE_SEPARATOR.length;
        cursor += pageText.length;
        prevWasNonEmpty = true;
    }
    return cursor;
}

/**
 * Re-base per-page entity offsets onto the flat text.
 *
 * Each entity arrives with an offset relative to ITS OWN page; the tokeniser
 * splices against the flat text, so they have to be moved. The entity also
 * gains the page it was found on, which is the only place that survives the
 * flattening.
 */
function entitiesToFlatOffsets(pageEntities, pages) {
    const out = [];
    if (!Array.isArray(pages)) return out;
    let cursor = 0;
    let prevWasNonEmpty = false;
    for (let i = 0; i < pages.length; i++) {
        const pageText = pages[i]?.text || '';
        if (!pageText) continue;
        if (prevWasNonEmpty) cursor += FLAT_PAGE_SEPARATOR.length;
        for (const e of (pageEntities?.[i] || [])) {
            out.push({
                ...e,
                offset: cursor + (typeof e.offset === 'number' ? e.offset : 0),
                page: pages[i].pageNumber,
            });
        }
        cursor += pageText.length;
        prevWasNonEmpty = true;
    }
    return out;
}

/**
 * Give each chunk the page its text STARTS on.
 *
 * ── WHY IT SEARCHES INSTEAD OF TRACKING OFFSETS ─────────────────────
 * The chunker does not slice the flat text. It rewrites it: HTML tables become
 * markdown, tables and code blocks are lifted out to placeholders and put
 * back, and each chunk gets a heading breadcrumb prepended that was never
 * contiguous with its body. Threading exact offsets through all of that would
 * mean every one of those transforms maintaining a mapping, and the first one
 * that forgot would produce a citation that says "p. 7" about text on page 8 —
 * silently, and more convincingly than no page at all.
 *
 * So this looks the chunk back up. Chunks come out in document order, so the
 * search only ever moves FORWARD from where the last one was found: that makes
 * it linear rather than quadratic, and it stops a repeated phrase (a running
 * header, a boilerplate footer) matching an earlier page.
 *
 * ── A CHUNK THAT CANNOT BE FOUND GETS NO PAGE ───────────────────────
 * A heavily-rewritten table may not appear in the flat text in any form this
 * can match. That chunk gets `page_start: null` and its citation renders
 * without "· p. 12" — which is the same thing every document ingested before
 * this existed will do for ever, since their bytes were never kept. A wrong
 * page is worse than no page: no page is visibly less information, a wrong one
 * is misinformation somebody may act on.
 *
 * @param {Array<{text: string, page_start?: number|null}>} chunks   from `chunkText`, in document order
 * @param {Array} pages                    from the extractor
 * @returns {Array} the same chunks, each with `page_start` (a number or null)
 */
function stampChunkPages(chunks, pages) {
    const list = Array.isArray(chunks) ? chunks : [];
    const spans = pageSpans(pages);
    if (spans.length === 0) {
        for (const c of list) c.page_start = null;
        return list;
    }
    const flat = (Array.isArray(pages) ? pages : [])
        .map(p => p?.text || '').filter(Boolean).join(FLAT_PAGE_SEPARATOR);

    let cursor = 0;
    for (const chunk of list) {
        const probe = probeOf(chunk?.text);
        chunk.page_start = null;
        if (!probe) continue;
        let at = flat.indexOf(probe, cursor);
        // Not found ahead: the chunk may be an atomic block moved out of
        // document order. Try from the top before giving up — a page from the
        // right document beats none, and the forward-only rule exists to
        // disambiguate repeats, not to hide content.
        if (at === -1) at = flat.indexOf(probe);
        if (at === -1) continue;
        chunk.page_start = pageAt(at, spans);
        // Advance by ONE, not past the whole probe. One guarantees progress —
        // without it a running header or boilerplate footer matches the same
        // position for every chunk and the whole document reads as page 1 —
        // while still letting the next chunk start inside this one, which
        // chunks routinely do (they overlap by design).
        cursor = at + 1;
    }
    return list;
}

/**
 * The part of a chunk worth searching for: its first real line of body text.
 *
 * The breadcrumb the chunker prepends is heading text lifted from further up
 * the document, so matching on it would locate the HEADING's page rather than
 * the passage's. Headings are skipped for the same reason, and the probe is
 * kept short enough to survive whitespace normalisation but long enough not to
 * match a stray phrase.
 */
const PROBE_CHARS = 60;
const PROBE_MIN = 12;

function probeOf(text) {
    const lines = String(text || '').split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (/^#{1,6}\s/.test(trimmed)) continue;      // a heading, or a breadcrumb line
        if (/^\|/.test(trimmed)) continue;             // a markdown table row
        if (trimmed.length < PROBE_MIN) continue;      // too short to be distinctive
        return trimmed.slice(0, PROBE_CHARS);
    }
    return null;
}

module.exports = {
    FLAT_PAGE_SEPARATOR, pageSpans, pageAt, flatBoundaryForPages, entitiesToFlatOffsets,
    stampChunkPages, probeOf,
};

/**
 * Mapping a position in flat text back to the page it came from.
 *
 * ── WHY THIS IS FIDDLY ENOUGH TO DESERVE ITS OWN SUITE ──────────────
 * An extractor hands back `pages[]` AND one flat `text`, and the flat text is
 * the NON-EMPTY pages joined by '\n\n'. Every consumer has to walk the pages
 * the same way — skip the empty ones, add the separator only BETWEEN
 * successive non-empty entries — and every way of getting it slightly wrong
 * fails silently:
 *
 *   forgetting the separator      → offsets drift two characters per page, so
 *                                   a redaction token splices mid-word
 *   counting empty pages as text  → every later page is off by one
 *   `pages.slice(n).join()`       → both at once
 *
 * A blank page in the middle of a scanned PDF is not exotic. It is the second
 * side of a single-sided scan.
 *
 * Run: cd server && node --test --test-force-exit core/documents/pageOffsets.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { pageSpans, pageAt, flatBoundaryForPages, entitiesToFlatOffsets, stampChunkPages, probeOf, FLAT_PAGE_SEPARATOR } = require('./pageOffsets');

/** Pages, and the flat text an extractor builds from them — the real contract. */
function doc(texts) {
    const pages = texts.map((text, i) => ({ text, pageNumber: i + 1 }));
    const flat = texts.filter(Boolean).join(FLAT_PAGE_SEPARATOR);
    return { pages, flat };
}

test('a span slices exactly its own page out of the flat text', () => {
    const { pages, flat } = doc(['first page', 'second page', 'third page']);
    for (const span of pageSpans(pages)) {
        assert.strictEqual(flat.slice(span.start, span.end), pages[span.page - 1].text);
    }
});

test('an EMPTY page occupies no offsets but does not shift the numbering', () => {
    // The second side of a single-sided scan. Counting it as text puts every
    // later page one off; dropping its NUMBER renames every page after it.
    const { pages, flat } = doc(['first page', '', 'third page']);
    const spans = pageSpans(pages);
    assert.deepStrictEqual(spans.map(s => s.page), [1, 3], 'page 3 is still page 3');
    for (const span of spans) {
        assert.strictEqual(flat.slice(span.start, span.end), pages[span.page - 1].text);
    }
});

test('several empty pages in a row do not accumulate separators', () => {
    const { pages, flat } = doc(['a', '', '', '', 'b']);
    assert.strictEqual(flat, `a${FLAT_PAGE_SEPARATOR}b`);
    const spans = pageSpans(pages);
    assert.deepStrictEqual(spans, [
        { page: 1, start: 0, end: 1 },
        { page: 5, start: 1 + FLAT_PAGE_SEPARATOR.length, end: 2 + FLAT_PAGE_SEPARATOR.length },
    ]);
});

test('a document that starts with blank pages still places the first real one at 0', () => {
    const { pages, flat } = doc(['', '', 'content']);
    const [span] = pageSpans(pages);
    assert.strictEqual(span.start, 0);
    assert.strictEqual(span.page, 3);
    assert.strictEqual(flat.slice(span.start, span.end), 'content');
});

describe_pageAt();
function describe_pageAt() {
    const { pages } = doc(['aaaa', 'bbbb', 'cccc']);
    const spans = pageSpans(pages);

    test('an offset inside a page is that page', () => {
        assert.strictEqual(pageAt(0, spans), 1);
        assert.strictEqual(pageAt(3, spans), 1);
        assert.strictEqual(pageAt(6, spans), 2);
        assert.strictEqual(pageAt(12, spans), 3);
    });

    test('an offset in the separator belongs to the page that just ENDED', () => {
        // It is the boundary the previous page's text ran up to. Calling it
        // the next page credits a passage to a page it does not appear on.
        assert.strictEqual(pageAt(4, spans), 1);
        assert.strictEqual(pageAt(5, spans), 1);
    });

    test('past the end is the last page, not null', () => {
        // A chunk that runs to the end of the document still came from
        // somewhere, and "no page" would drop the citation's page silently.
        assert.strictEqual(pageAt(999, spans), 3);
    });

    test('nothing sensible in, null out', () => {
        assert.strictEqual(pageAt(0, []), null);
        assert.strictEqual(pageAt(0, null), null);
        assert.strictEqual(pageAt(-1, spans), null);
        assert.strictEqual(pageAt(NaN, spans), null);
        assert.strictEqual(pageAt(undefined, spans), null);
    });
}

describe_boundary();
function describe_boundary() {
    test('the boundary of the first N pages slices the flat text cleanly', () => {
        const { pages, flat } = doc(['aaaa', 'bbbb', 'cccc']);
        const cut = flatBoundaryForPages(pages, 2);
        assert.strictEqual(flat.slice(0, cut), `aaaa${FLAT_PAGE_SEPARATOR}bbbb`);
    });

    test('an empty page COUNTS as scanned while occupying nothing', () => {
        // The scanner walked past it, so it is one of the N — but it
        // contributes no characters, which is what `slice(0, n).join()` gets
        // wrong in both directions at once.
        const { pages, flat } = doc(['aaaa', '', 'cccc']);
        assert.strictEqual(flatBoundaryForPages(pages, 2), 4);
        assert.strictEqual(flat.slice(0, 4), 'aaaa');
    });

    test('zero pages is offset zero, and every page is the whole text', () => {
        const { pages, flat } = doc(['aaaa', 'bbbb']);
        assert.strictEqual(flatBoundaryForPages(pages, 0), 0);
        assert.strictEqual(flatBoundaryForPages(pages, 99), flat.length);
    });

    test('nothing in, zero out', () => {
        assert.strictEqual(flatBoundaryForPages(null, 3), 0);
        assert.strictEqual(flatBoundaryForPages([], 3), 0);
    });
}

describe_entities();
function describe_entities() {
    test('a per-page offset is moved onto the flat text, keeping its page', () => {
        const { pages, flat } = doc(['Jan de Vries werkt hier', 'Bel 0612345678']);
        const found = entitiesToFlatOffsets(
            [[{ type: 'PERSON', text: 'Jan de Vries', offset: 0 }], [{ type: 'PHONE', text: '0612345678', offset: 4 }]],
            pages,
        );
        assert.strictEqual(found[0].page, 1);
        assert.strictEqual(flat.slice(found[0].offset, found[0].offset + 12), 'Jan de Vries');
        assert.strictEqual(found[1].page, 2);
        assert.strictEqual(flat.slice(found[1].offset, found[1].offset + 10), '0612345678');
    });

    test('an empty page between two findings does not drift the second', () => {
        // The failure this whole module exists to prevent: a token spliced two
        // characters off, into the middle of a word.
        const { pages, flat } = doc(['Jan de Vries', '', 'Bel 0612345678']);
        const found = entitiesToFlatOffsets(
            [[{ type: 'PERSON', offset: 0 }], [], [{ type: 'PHONE', offset: 4 }]],
            pages,
        );
        assert.strictEqual(flat.slice(found[1].offset, found[1].offset + 10), '0612345678');
        assert.strictEqual(found[1].page, 3);
    });

    test('a page with no findings contributes none', () => {
        const { pages } = doc(['a', 'b']);
        assert.deepStrictEqual(entitiesToFlatOffsets([[], []], pages), []);
        assert.deepStrictEqual(entitiesToFlatOffsets(null, pages), []);
    });

    test('an entity with no offset lands at the start of its page, not at 0', () => {
        const { pages } = doc(['aaaa', 'bbbb']);
        const [found] = entitiesToFlatOffsets([[], [{ type: 'X' }]], pages);
        assert.strictEqual(found.offset, 4 + FLAT_PAGE_SEPARATOR.length);
    });
}

describe_stamping();
function describe_stamping() {
    /**
     * The chunker does not slice the flat text — it rewrites it (tables to
     * markdown, atomic blocks lifted out and put back, a heading breadcrumb
     * prepended that was never contiguous with the body). So the page is found
     * by looking the chunk's body back UP, not by tracking an offset through
     * every transform.
     */
    test('each chunk gets the page its text starts on', () => {
        const { pages } = doc([
            'Hoofdstuk 1\n\nDit gaat over verlof en vakantiedagen.',
            'Hoofdstuk 2\n\nDit gaat over declaraties en bonnen.',
            'Hoofdstuk 3\n\nDit gaat over de bedrijfsauto en tanken.',
        ]);
        const chunks = [
            { text: 'Dit gaat over verlof en vakantiedagen.' },
            { text: 'Dit gaat over declaraties en bonnen.' },
            { text: 'Dit gaat over de bedrijfsauto en tanken.' },
        ];
        stampChunkPages(chunks, pages);
        assert.deepStrictEqual(chunks.map(c => c.page_start), [1, 2, 3]);
    });

    test('a prepended breadcrumb does not drag the page back to the heading', () => {
        // The breadcrumb is heading text lifted from further up the document.
        // Matching on it would credit the passage to the HEADING's page.
        const { pages } = doc(['# Personeelshandboek\n\nInleiding tekst hier.', 'Bij een huwelijk krijg je twee dagen vrij.']);
        const chunks = [{ text: '# Personeelshandboek\n\nBij een huwelijk krijg je twee dagen vrij.' }];
        stampChunkPages(chunks, pages);
        assert.strictEqual(chunks[0].page_start, 2);
    });

    test('a repeated running header does not pull a later chunk to page 1', () => {
        // The forward-only scan exists for exactly this: boilerplate that
        // appears on every page would otherwise match the first one.
        const header = 'Vertrouwelijk — interne documentatie';
        const { pages } = doc([
            `${header}\n\nEerste onderwerp met genoeg tekst.`,
            `${header}\n\nTweede onderwerp met genoeg tekst.`,
        ]);
        const chunks = [
            { text: `${header}\n\nEerste onderwerp met genoeg tekst.` },
            { text: `${header}\n\nTweede onderwerp met genoeg tekst.` },
        ];
        stampChunkPages(chunks, pages);
        assert.deepStrictEqual(chunks.map(c => c.page_start), [1, 2]);
    });

    test('a chunk that cannot be located gets NO page, never a guess', () => {
        // A heavily-rewritten table may not appear in the flat text in any
        // form this can match. A wrong page is misinformation somebody may act
        // on; a missing one is visibly less information.
        const { pages } = doc(['Alleen deze tekst staat in het document.']);
        const chunks = [{ text: 'Iets wat nergens in het document voorkomt, echt niet.' }];
        stampChunkPages(chunks, pages);
        assert.strictEqual(chunks[0].page_start, null);
    });

    test('no pages means no pages, for every chunk', () => {
        // A plain-text source, a web page, or anything ingested before this
        // existed. The chip renders without "p. 12" and that is the design.
        const chunks = [{ text: 'iets' }, { text: 'anders' }];
        stampChunkPages(chunks, []);
        assert.deepStrictEqual(chunks.map(c => c.page_start), [null, null]);
        stampChunkPages(chunks, null);
        assert.deepStrictEqual(chunks.map(c => c.page_start), [null, null]);
    });

    test('an empty page in the middle does not shift the numbering', () => {
        const { pages } = doc(['Eerste onderwerp met genoeg tekst.', '', 'Tweede onderwerp met genoeg tekst.']);
        const chunks = [{ text: 'Tweede onderwerp met genoeg tekst.' }];
        stampChunkPages(chunks, pages);
        assert.strictEqual(chunks[0].page_start, 3);
    });

    test('nothing sensible in, nothing thrown', () => {
        assert.deepStrictEqual(stampChunkPages(null, []), []);
        assert.deepStrictEqual(stampChunkPages([], null), []);
        const chunks = [{ text: '' }, {}];
        stampChunkPages(chunks, doc(['x']).pages);
        assert.deepStrictEqual(chunks.map(c => c.page_start), [null, null]);
    });

    test('the probe skips headings, table rows and fragments', () => {
        assert.strictEqual(probeOf('## Verlof\n\nBij een huwelijk krijg je vrij.'), 'Bij een huwelijk krijg je vrij.');
        assert.strictEqual(probeOf('| Item | Prijs |\n| --- | --- |\nEen zin die lang genoeg is.'), 'Een zin die lang genoeg is.');
        assert.strictEqual(probeOf('kort\nook\n'), null, 'nothing distinctive enough to search for');
        assert.strictEqual(probeOf(''), null);
        assert.strictEqual(probeOf(null), null);
    });
}

describe_azure();
function describe_azure() {
    const { cleanAzureDocMarkdown } = require('../text/markdownCleanup');

    /**
     * Azure Document Intelligence returns one string with `<!-- PageBreak -->`
     * markers in it. The cleanup strips them — correctly, a marker left in the
     * text would surface inside a citation's excerpt — which also destroys the
     * only record of where a page ended.
     */
    test('the flat text IS the join of the pages, exactly', () => {
        // Not "similar to". `pageSpans` walks the pages and computes offsets
        // into the flat text; if the two are built differently, every offset
        // after the first page is wrong by however much they differ.
        const raw = 'Verlofregeling voor medewerkers.\n<!-- PageBreak -->\nDeclaraties binnen dertig dagen.\n<!-- PageBreak -->\nBedrijfsauto en tanken.';
        const { text, pages } = cleanAzureDocMarkdown(raw, { withPages: true });
        assert.strictEqual(text, pages.map(p => p.text).filter(Boolean).join(FLAT_PAGE_SEPARATOR));
        for (const span of pageSpans(pages)) {
            assert.strictEqual(text.slice(span.start, span.end), pages[span.page - 1].text);
        }
    });

    test('an empty page between two breaks keeps the numbering honest', () => {
        const raw = 'Eerste pagina tekst.\n<!-- PageBreak -->\n<!-- PageBreak -->\nDerde pagina tekst.';
        const { text, pages } = cleanAzureDocMarkdown(raw, { withPages: true });
        assert.strictEqual(pages[1].text, '', 'the blank page is still page 2');
        const spans = pageSpans(pages);
        assert.deepStrictEqual(spans.map(s => s.page), [1, 3]);
        assert.strictEqual(text.slice(spans[1].start, spans[1].end), 'Derde pagina tekst.');
    });

    test('the single-argument form is unchanged, for every existing caller', () => {
        const raw = 'One.\n<!-- PageBreak -->\nTwo.';
        assert.strictEqual(typeof cleanAzureDocMarkdown(raw), 'string');
        assert.match(cleanAzureDocMarkdown(raw), /One\./);
        assert.doesNotMatch(cleanAzureDocMarkdown(raw), /PageBreak/);
    });

    test('a document with no breaks is one page, not zero', () => {
        const { pages } = cleanAzureDocMarkdown('Alles op een pagina.', { withPages: true });
        assert.strictEqual(pages.length, 1);
        assert.strictEqual(pages[0].pageNumber, 1);
    });

    test('no text at all is no pages, and does not throw', () => {
        assert.deepStrictEqual(cleanAzureDocMarkdown('', { withPages: true }), { text: '', pages: [] });
        assert.deepStrictEqual(cleanAzureDocMarkdown(null, { withPages: true }), { text: '', pages: [] });
    });
}

/**
 * One citation shape.
 *
 * Four emitters built their own, agreed on enough to look interchangeable and
 * differed on enough to not be — and the notebook one sent `preview` where the
 * overlay reads `content`, so every citation popup there said "No content
 * preview available". The text had been fetched, scored and sent under a key
 * nothing consumed. That is the failure mode this closes: not a crash, a blank
 * panel nobody can explain.
 *
 * Run: cd server && node --test --test-force-exit core/kb/citation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const {
    toCitation, toCitations, sectionLabelOf, pageOf, rowRangeOf, rowRefOf, occurredAtOf, CITATION_FIELDS,
} = require('./citation');

/** A row as `searchLocally` returns it, now that the reranker keeps it whole. */
function row(over = {}) {
    return {
        id: 'chunk-9',
        title: 'Personeelshandboek',
        content: '## 4.2 Bijzonder verlof\n\nBij een huwelijk krijg je twee dagen vrij.',
        source_uri: 'Personeelshandboek.pdf',
        document_id: 'doc-1',
        chunk_id: 3,
        page_start: 12,
        score: 0.91,
        ...over,
    };
}

test('a retrieval row becomes a citation that can be acted on', () => {
    const c = toCitation(row());
    assert.strictEqual(c.title, 'Personeelshandboek', 'what a person named it, not the filename');
    assert.strictEqual(c.documentId, 'doc-1');
    assert.strictEqual(c.chunkId, 3);
    assert.strictEqual(c.page, 12);
    assert.strictEqual(c.kind, 'kb_chunk');
    assert.match(c.content, /twee dagen vrij/);
    assert.strictEqual(c.score, 0.91);
});

test('content is present under the key the overlay actually reads', () => {
    // The notebook bug, pinned: `preview` alone left every popup blank.
    const c = toCitation(row());
    assert.strictEqual(c.content, row().content);
    assert.strictEqual(c.preview, c.content, 'the alias carries the same text, for one release');
});

test('everything after the title may be missing, and a citation still stands', () => {
    // A document ingested before pages existed has no page, and one whose
    // reranker dropped the ids has no chunkId. Refusing to cite it would blank
    // the panel for every document already in the product.
    const c = toCitation({ title: 'Notes', content: 'text' });
    assert.strictEqual(c.title, 'Notes');
    assert.strictEqual(c.page, null);
    assert.strictEqual(c.documentId, null);
    assert.strictEqual(c.sourceId, null);
});

test('the Azure metadata bag resolves to the same fields', () => {
    // One path wraps the document name in `metadata`, and a caller that
    // normalised first is how the four shapes happened.
    const c = toCitation({ metadata: { source: 'Handbook.pdf', type: 'url_import' }, content: 'x', score: 0.4 });
    assert.strictEqual(c.title, 'Handbook.pdf');
    assert.strictEqual(c.kind, 'url_import');
});

test('the title is what a person would call the document', () => {
    // The precedence the emitters already had: a real URL identifies a web
    // page better than its <title>, and a document's own name beats the
    // filename it happened to arrive as.
    assert.strictEqual(toCitation({ source_url: 'https://x/terms', title: 'Terms', source_uri: 'terms.html' }).title, 'https://x/terms');
    assert.strictEqual(toCitation({ title: 'Personeelshandboek', source_uri: 'ph.pdf' }).title, 'Personeelshandboek');
    assert.strictEqual(toCitation({ source_uri: 'ph.pdf' }).title, 'ph.pdf');
    assert.strictEqual(toCitation({}).title, 'Unknown source', 'never an empty chip');
});

test('a source row names the source the passage came from', () => {
    const c = toCitation(row(), { source: { id: 'src-1', name: 'Nextcloud · /Sales' } });
    assert.strictEqual(c.sourceId, 'src-1');
    assert.strictEqual(c.sourceName, 'Nextcloud · /Sales');
});

test('the row wins over the caller when it knows its own source', () => {
    const c = toCitation(row({ source_id: 'src-real' }), { source: { id: 'src-guess', name: 'Guess' } });
    assert.strictEqual(c.sourceId, 'src-real');
});

describe_sections();
function describe_sections() {
    test('the section is the DEEPEST heading, not the first', () => {
        // A chunk that starts under "4. Verlof" and runs into "4.2 Bijzonder
        // verlof" is about the second one.
        const label = sectionLabelOf('# 4. Verlof\n\nIets.\n\n## 4.2 Bijzonder verlof\n\nBij een huwelijk krijg je twee dagen vrij.');
        assert.match(label, /^4\.2 Bijzonder verlof/);
    });

    test('a sentence rides along, so two passages of one section differ', () => {
        const label = sectionLabelOf('## Verlof\n\nBij een huwelijk krijg je twee dagen vrij.');
        assert.match(label, /Verlof — Bij een huwelijk/);
    });

    test('a table row is not a sentence', () => {
        // A markdown table's first row reads as noise in a chip.
        const label = sectionLabelOf('## Tarieven\n\n| Item | Prijs |\n| --- | --- |\n| Abonnement | 12 |');
        assert.strictEqual(label, 'Tarieven');
    });

    test('a passage with no heading falls back to its own first sentence', () => {
        const label = sectionLabelOf('Bij een huwelijk krijg je twee dagen vrij. En meer.');
        assert.match(label, /^Bij een huwelijk/);
    });

    test('a passage with nothing to say falls back to its position', () => {
        assert.strictEqual(sectionLabelOf('', 2), 'Chunk 3');
        assert.strictEqual(sectionLabelOf(null, 0), 'Chunk 1');
        assert.strictEqual(sectionLabelOf('short', 0), 'Chunk 1', 'a fragment is not a sentence');
    });

    test('a section the row already carries is kept', () => {
        const c = toCitation(row({ section: 'Given by the caller' }));
        assert.strictEqual(c.section, 'Given by the caller');
    });
}

describe_pages();
function describe_pages() {
    test('a page is read from any of the names the layers use', () => {
        assert.strictEqual(pageOf({ page: 4 }), 4);
        assert.strictEqual(pageOf({ page_start: 4 }), 4);
        assert.strictEqual(pageOf({ pageStart: 4 }), 4);
    });

    test('a page nobody counts from is no page', () => {
        // The chip says "· p.3". "· p.0" and "· p.-1" say the chunker guessed.
        for (const v of [0, -1, null, undefined, '', 'twelve', 1.5, NaN]) {
            assert.strictEqual(pageOf({ page: v }), null, JSON.stringify(v));
        }
    });
}

test('a list keeps its order and numbers its fallbacks from its own position', () => {
    const out = toCitations([{ content: '' }, { content: '' }]);
    assert.deepStrictEqual(out.map(c => c.section), ['Chunk 1', 'Chunk 2']);
});

test('nothing in, nothing out', () => {
    assert.deepStrictEqual(toCitations(null), []);
    assert.deepStrictEqual(toCitations([]), []);
});

describe_shape();
function describe_shape() {
    test('CITATION_FIELDS is what toCitation actually emits, not a comment about it', () => {
        // It WAS a comment: ten names nothing imported, while `toCitation`
        // built the object by hand and emitted an eleventh (`preview`) that
        // was never listed. A field added to one and forgotten in the other
        // arrives in a chip as `undefined`, which no test would have caught.
        const keys = Object.keys(toCitation(row()));
        assert.deepStrictEqual(keys, [...CITATION_FIELDS, 'preview']);
    });
}

describe_row_ranges();
function describe_row_ranges() {
    test('a block of table rows cites the rows it covers', () => {
        const c = toCitation({ title: 'Producten 1–50', content: 'x', row_start: 1, row_end: 50 });
        assert.strictEqual(c.rowStart, 1);
        assert.strictEqual(c.rowEnd, 50);
    });

    test('the range is read from the document metadata the ingest stored', () => {
        // Which is where the datatable adapter puts it, and the only place it
        // survives the trip through `documents`.
        const c = toCitation({ title: 'Producten', content: 'x', metadata: { rowStart: 51, rowEnd: 100 } });
        assert.strictEqual(c.rowStart, 51);
        assert.strictEqual(c.rowEnd, 100);
    });

    test('half a range is no range', () => {
        // "rows 12–" reads as a bug, and printing one end as though it were
        // both says something false about where to look.
        assert.deepStrictEqual(rowRangeOf({ row_start: 12 }), { rowStart: null, rowEnd: null });
        assert.deepStrictEqual(rowRangeOf({ row_end: 12 }), { rowStart: null, rowEnd: null });
    });

    test('an end before its start is arithmetic nobody meant', () => {
        assert.deepStrictEqual(rowRangeOf({ row_start: 50, row_end: 1 }), { rowStart: null, rowEnd: null });
    });

    test('a row nobody counts from is no row', () => {
        for (const v of [0, -1, 1.5, 'three', null, undefined, NaN, {}]) {
            assert.deepStrictEqual(
                rowRangeOf({ row_start: v, row_end: v }), { rowStart: null, rowEnd: null }, String(v),
            );
        }
    });

    test('a numeric string counts, the same way a page does', () => {
        // A BIGINT column comes back from the driver as a string often enough
        // that refusing one would drop the range on exactly the paths that
        // have it.
        assert.deepStrictEqual(rowRangeOf({ row_start: '1', row_end: '50' }), { rowStart: 1, rowEnd: 50 });
    });

    test('a single row is a range of one, not a broken one', () => {
        assert.deepStrictEqual(rowRangeOf({ rowStart: 7, rowEnd: 7 }), { rowStart: 7, rowEnd: 7 });
    });
}

describe_live_rows();
function describe_live_rows() {
    test('a live table row cites the table AND the row', () => {
        // A1c: `datatable_query` reads a row at question time. There is no
        // document and no chunk behind it, so this pair is the only thing that
        // makes the quote checkable — a chip that says "Producten" and nothing
        // more is the uncheckable citation the page number exists to prevent.
        const c = toCitation(
            { title: 'Product XL', content: 'prijs: 12,50', datatable_id: 'tbl_p', row_id: 'r-9' },
            { kind: 'datatable_row' },
        );
        assert.strictEqual(c.kind, 'datatable_row');
        assert.strictEqual(c.datatableId, 'tbl_p');
        assert.strictEqual(c.rowId, 'r-9');
        assert.strictEqual(c.documentId, null, 'there is no document — saying there is would be a lie');
    });

    test('camelCase reads the same, because half the callers speak it', () => {
        const c = toCitation({ title: 'x', content: 'y', datatableId: 'tbl_p', rowId: 'r-1' });
        assert.strictEqual(c.datatableId, 'tbl_p');
        assert.strictEqual(c.rowId, 'r-1');
    });

    test('half a row reference is no reference', () => {
        // Same rule as the row range: "somewhere in Producten" cannot be
        // opened, and a row id with no table cannot be resolved at all.
        assert.deepStrictEqual(rowRefOf({ datatable_id: 'tbl_p' }), { datatableId: null, rowId: null });
        assert.deepStrictEqual(rowRefOf({ row_id: 'r-9' }), { datatableId: null, rowId: null });
    });

    test('an ordinary kb chunk never claims to be a table row', () => {
        // The regression this guards: `row.id` is what `chunkId` falls back to
        // and EVERY retrieval row carries one. Borrowing it here would stamp a
        // datatable reference onto every document citation in the product —
        // and a chip that offers to open a table that does not exist is worse
        // than one that offers nothing.
        const c = toCitation(row());
        assert.strictEqual(c.datatableId, null);
        assert.strictEqual(c.rowId, null);
        assert.strictEqual(c.chunkId, 3, 'the chunk id is still the chunk id');
    });
}

describe_occurred_at();
function describe_occurred_at() {
    test('a meeting cites the day it was HELD', () => {
        // `meetingDate` is what the meeting adapter has always called it, and
        // `created_at` — when we ingested it — is the wrong answer wearing the
        // right shape.
        const c = toCitation({ title: 'Salesoverleg', content: 'x', metadata: { meetingDate: '2026-07-22T09:00:00.000Z' } });
        assert.strictEqual(c.occurredAt, '2026-07-22T09:00:00.000Z');
    });

    test('a Date from the driver becomes the same ISO string', () => {
        assert.strictEqual(occurredAtOf({ occurred_at: new Date('2026-07-22T09:00:00Z') }), '2026-07-22T09:00:00.000Z');
    });

    test('a bare number is refused, because 2026 is a year to everyone but Date', () => {
        assert.strictEqual(occurredAtOf({ occurred_at: 2026 }), null);
        assert.strictEqual(occurredAtOf({ occurred_at: 1774000000000 }), null);
    });

    test('nothing unparseable ever reaches a chip', () => {
        for (const v of ['', '   ', 'sometime last spring', null, undefined, {}, new Date('nope')]) {
            assert.strictEqual(occurredAtOf({ occurred_at: v }), null, String(v));
        }
    });
}

test('REGRESSION: a citation from before these fields existed is unchanged', () => {
    // Every citation already stored in every conversation. The three new
    // fields must read as "not known" and nothing else may move — a chip that
    // rendered "Personeelshandboek · p. 12" yesterday renders it today.
    const c = toCitation(row());
    assert.strictEqual(c.rowStart, null);
    assert.strictEqual(c.rowEnd, null);
    assert.strictEqual(c.occurredAt, null);
    assert.strictEqual(c.title, 'Personeelshandboek');
    assert.strictEqual(c.page, 12);
    assert.strictEqual(c.content, row().content);
    assert.strictEqual(c.score, 0.91);
});

test('what a passage pulled in along its table relations reaches the chip, in shape', () => {
    // `relationHop` sets `linked` on a retrieval row; the chip reads it. Only
    // the two shapes it knows survive, with nothing else riding along.
    const c = toCitation({
        title: 'Van Dijk', content: 'name: Van Dijk',
        linked: [
            { kind: 'row', column: 'supplier', table: 'Suppliers', title: 'Van Dijk', junk: 1 },
            { kind: 'rows', table: 'Orders', count: '312', shown: 3 },
            { kind: 'nonsense' },
            null,
        ],
    });
    assert.deepStrictEqual(c.linked, [
        { kind: 'row', column: 'supplier', table: 'Suppliers', title: 'Van Dijk' },
        { kind: 'rows', table: 'Orders', count: 312, shown: 3 },
    ]);
    assert.strictEqual(toCitation({ title: 'Notes', content: 'x' }).linked, null, 'null for every passage that is not a table row');
    assert.strictEqual(toCitation({ title: 'Notes', content: 'x', linked: [] }).linked, null);
});

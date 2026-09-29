/**
 * Retrieval provenance: what survives a rerank.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────
 * A citation could never say more than a document's TITLE. Not because the
 * database did not return the ids — it does, on every row — but because all
 * four reranker branches rebuilt each row from four fields on their way past:
 *
 *     { content, title, source_uri, score }
 *
 * `id`, `document_id` and `chunk_id` were dropped one line after the query
 * returned them. "Personeelshandboek" is not a citation. "Personeelshandboek,
 * p. 12", with a chip you can click to see the passage, is — and every id
 * needed to build that had been thrown away.
 *
 * A reranker's job is to say WHICH rows and in what ORDER. It has no business
 * editing them, which is why the fix is one shared function rather than four
 * corrected maps: a fifth reranker cannot reintroduce this.
 *
 * Run: cd server && node --test --test-force-exit core/kb/localKBIngest.provenance.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { applyRerank } = require('./localKBIngest');

/** A row exactly as the RRF merge builds it, before any reranker sees it. */
function row(over = {}) {
    return {
        id: 'chunk-1',
        content: 'Vakantiedagen worden per kalenderjaar toegekend.',
        title: 'Personeelshandboek',
        source_uri: 'Personeelshandboek.pdf',
        score: 0.0164,
        document_id: 'doc-1',
        chunk_id: 3,
        page_start: 12,
        ...over,
    };
}

test('every field the query returned survives the rerank', () => {
    // The whole bug, in one assertion: what comes out is the row that went in.
    const rows = [row()];
    const [out] = applyRerank(rows, [{ index: 0, relevance_score: 0.91 }]);
    assert.strictEqual(out.id, 'chunk-1');
    assert.strictEqual(out.document_id, 'doc-1');
    assert.strictEqual(out.chunk_id, 3);
    assert.strictEqual(out.page_start, 12);
    assert.strictEqual(out.content, rows[0].content);
    assert.strictEqual(out.title, 'Personeelshandboek');
    assert.strictEqual(out.source_uri, 'Personeelshandboek.pdf');
});

test('a column added later rides along without this function changing', () => {
    // The reason it is a spread and not a longer projection: the next field
    // somebody adds must not need an edit here to reach a citation.
    const [out] = applyRerank([row({ section: '4.2 Verlof' })], [{ index: 0, relevance_score: 0.5 }]);
    assert.strictEqual(out.section, '4.2 Verlof');
});

test('the reranker replaces the score and nothing else', () => {
    const rows = [row({ score: 0.0164 })];
    const [out] = applyRerank(rows, [{ index: 0, relevance_score: 0.91 }]);
    assert.strictEqual(out.score, 0.91);
    assert.strictEqual(rows[0].score, 0.0164, 'and does not mutate the input row');
});

test('the order is the reranker`s, not the retriever`s', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })];
    const out = applyRerank(rows, [
        { index: 2, relevance_score: 0.9 },
        { index: 0, relevance_score: 0.4 },
    ]);
    assert.deepStrictEqual(out.map(r => r.id), ['c', 'a']);
});

test('a row the reranker dropped is dropped', () => {
    // Reranking is also a filter: `top_n` is smaller than the candidate set.
    const rows = [row({ id: 'a' }), row({ id: 'b' })];
    const out = applyRerank(rows, [{ index: 1, relevance_score: 0.9 }]);
    assert.deepStrictEqual(out.map(r => r.id), ['b']);
});

test('an index nobody has is skipped, never an undefined in the results', () => {
    // A reranker answering about a document set it was not given used to put
    // `undefined` straight into the results, where the first `.content` read
    // downstream threw — inside a search that is supposed to degrade, not fail.
    const rows = [row({ id: 'a' })];
    for (const ranked of [
        [{ index: 5, relevance_score: 0.9 }],
        [{ index: -1, relevance_score: 0.9 }],
        [{ relevance_score: 0.9 }],
        [null],
    ]) {
        const out = applyRerank(rows, ranked);
        assert.deepStrictEqual(out, [], JSON.stringify(ranked));
    }
});

test('no verdict is no results, and does not throw', () => {
    assert.deepStrictEqual(applyRerank([row()], []), []);
    assert.deepStrictEqual(applyRerank([row()], null), []);
    assert.deepStrictEqual(applyRerank([row()], undefined), []);
});

test('every reranker branch goes through this one function', () => {
    // Four branches used to hold four copies of the same projection, and the
    // fix is only durable if none of them keeps its own.
    //
    // Five since the llama.cpp branch was added. The literal count is a blunt
    // proxy for "no branch rebuilds the row by hand", so adding a reranker is
    // meant to land here and make you check that the new branch really does go
    // through applyRerank — it is not a number to bump on reflex.
    const fs = require('node:fs');
    const src = fs.readFileSync(require.resolve('./localKBIngest'), 'utf8');
    const search = src.slice(src.indexOf('async function searchLocally'));
    assert.strictEqual(
        (search.match(/applyRerank\(/g) || []).length, 5,
        'all five reranker branches must use applyRerank',
    );
    assert.doesNotMatch(
        search,
        /source_uri:\s*results\[/,
        'a branch is rebuilding the row by hand again — that is how the ids get lost',
    );
});

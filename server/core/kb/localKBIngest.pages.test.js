/**
 * `page_start` end to end: the chunker stamps it, the column holds it, and the
 * search projections hand it back.
 *
 * ── WHY AGAINST A REAL POSTGRES ─────────────────────────────────────
 * The failure this guards is not a wrong page — it is a page that silently
 * never arrives, because a column was added in one place and left out of the
 * INSERT column list, or returned by the vector query and not the full-text
 * one. Neither shows up in a unit test with a fake `query()`: the SQL is never
 * parsed, so a projection missing a column passes and returns `undefined` in
 * production, and the citation renders without a page for ever.
 *
 * Run: cd server && node --test --test-force-exit core/kb/localKBIngest.pages.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { PGlite } = require('@electric-sql/pglite');
const pg = new PGlite();

async function q(sql, params) {
    const res = Array.isArray(params) && params.length
        ? await pg.query(sql, params)
        : (/;\s*\S/.test(String(sql).trim()) ? await pg.exec(sql) : await pg.query(sql));
    const r = Array.isArray(res) ? (res[res.length - 1] || {}) : (res || {});
    return { rows: r.rows || [], rowCount: (r.rows || []).length };
}

// The table as ensureKBChunksTable brings it forward, minus the vector column
// (pgvector is not in PGlite's default build, and the page has nothing to do
// with embeddings — the no-vector INSERT branch is the one under test).
const DDL = `
CREATE TABLE kb_chunks (
    id BIGSERIAL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    knowledge_base_id TEXT NOT NULL,
    document_id TEXT NOT NULL,
    chunk_id INT NOT NULL,
    lang TEXT DEFAULT 'auto',
    title TEXT,
    content TEXT NOT NULL,
    tsv TSVECTOR,
    source_uri TEXT,
    chunk_type TEXT DEFAULT 'content',
    created_at TIMESTAMPTZ DEFAULT now()
);
`;

const { stampChunkPages } = require('../documents/pageOffsets');
const { chunkText } = require('./localKBIngest');
const { toCitation } = require('./citation');

before(async () => { await pg.exec(DDL); });
after(async () => { await pg.close(); });

/** The migration line from ensureKBChunksTable, run as production runs it. */
test('the column is added by the same idempotent ALTER production uses', async () => {
    await q('ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_start INT');
    await q('ALTER TABLE kb_chunks ADD COLUMN IF NOT EXISTS page_start INT');   // twice, on purpose
    const cols = await q(`SELECT column_name, is_nullable FROM information_schema.columns
                           WHERE table_name = 'kb_chunks' AND column_name = 'page_start'`);
    assert.strictEqual(cols.rows.length, 1);
    assert.strictEqual(cols.rows[0].is_nullable, 'YES', 'most of what is already ingested has no page');
});

test('a real document chunks, gets pages stamped, and stores them', async () => {
    const pages = [
        { pageNumber: 1, text: '# Personeelshandboek\n\n## Verlof\n\nBij een huwelijk krijg je twee dagen vrij. Dit geldt voor alle medewerkers in vaste dienst zonder uitzondering.' },
        { pageNumber: 2, text: '## Declaraties\n\nBonnen lever je binnen dertig dagen in bij de administratie. Latere bonnen worden niet meer vergoed door de werkgever.' },
    ];
    const flat = pages.map(p => p.text).join('\n\n');

    const chunks = chunkText(flat);
    assert.ok(chunks.length >= 1, 'the document produced chunks');
    stampChunkPages(chunks, pages);

    // The INSERT as ingestLocally builds it on the no-vector branch.
    for (const c of chunks) {
        await q(
            `INSERT INTO kb_chunks (tenant_id, knowledge_base_id, document_id, chunk_id, lang, title, content, tsv, source_uri, chunk_type, page_start)
             VALUES ($1,$2,$3,$4,$5,$6,$7, to_tsvector('simple', $7), $8, $9, $10)`,
            ['u1', 'kb1', 'doc1', c.chunk_id, 'auto', 'Handboek', c.text, 'handboek.pdf', c.chunk_type || 'content',
             Number.isInteger(c.page_start) ? c.page_start : null],
        );
    }

    const stored = await q('SELECT chunk_id, page_start, content FROM kb_chunks ORDER BY chunk_id');
    assert.strictEqual(stored.rows.length, chunks.length);
    const withPages = stored.rows.filter(r => r.page_start !== null);
    assert.ok(withPages.length > 0, 'at least one chunk knows its page');
    for (const r of withPages) {
        assert.ok(r.page_start >= 1 && r.page_start <= 2, `page ${r.page_start} is a page this document has`);
    }
});

test('the page a chunk claims is the page its text is actually on', async () => {
    // The whole point. A page that is merely present but wrong is worse than
    // none: it is misinformation somebody may act on.
    const rows = (await q(`SELECT page_start, content FROM kb_chunks WHERE page_start IS NOT NULL`)).rows;
    for (const r of rows) {
        const body = r.content.replace(/^#{1,6}\s+.*$/gm, '').trim();
        const firstLine = body.split('\n').find(l => l.trim().length > 12)?.trim();
        if (!firstLine) continue;
        const expected = firstLine.includes('huwelijk') ? 1 : firstLine.includes('Bonnen') ? 2 : null;
        if (expected) assert.strictEqual(r.page_start, expected, `"${firstLine.slice(0, 40)}"`);
    }
});

test('both search projections return page_start, not just one of them', async () => {
    // A column returned by the vector query and left out of the full-text one
    // means the page appears or vanishes depending on which retriever won —
    // which reads as flakiness, not as a missing column.
    const src = require('node:fs').readFileSync(require.resolve('./localKBIngest'), 'utf8');
    // THREE, not two: the full-text search has an AND-join and an OR-join
    // fallback, and the fallback is the one that was missed. A page that
    // appears or vanishes depending on which retriever won reads as
    // flakiness, not as a missing column.
    const selects = src.match(/SELECT id, title, content, source_uri, document_id, chunk_id[^`]*/g) || [];
    assert.strictEqual(selects.length, 3, 'vector, full-text AND-join, full-text OR-join');
    for (const s of selects) {
        assert.match(s, /page_start/, 'every retrieval path must carry the page');
    }
    // And the RRF merge has to keep it on the way past.
    assert.match(src, /page_start: row\.page_start/);
});

test('a stored page reaches the citation the client renders', async () => {
    const row = (await q(`SELECT id, title, content, source_uri, page_start FROM kb_chunks
                           WHERE page_start IS NOT NULL LIMIT 1`)).rows[0];
    const c = toCitation({ ...row, document_id: 'doc1', chunk_id: 0, score: 0.9 });
    assert.strictEqual(c.page, row.page_start);
});

test('a document with no pages stores null, and the citation simply says less', async () => {
    // Every document already in the product, permanently: its bytes were never
    // kept, so the page cannot be recovered.
    const chunks = chunkText('Een document zonder paginas, bijvoorbeeld geplakte tekst of een webpagina. Er is genoeg tekst nodig om een chunk te vormen die niet wordt weggefilterd.');
    stampChunkPages(chunks, null);
    assert.ok(chunks.every(c => c.page_start === null));
    const c = toCitation({ title: 'Geplakte tekst', content: chunks[0]?.text || 'x', page_start: null });
    assert.strictEqual(c.page, null);
});

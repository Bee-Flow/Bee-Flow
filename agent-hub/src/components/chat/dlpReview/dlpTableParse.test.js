// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { parseMarkdownDocument, looksLikeMarkdownTable } from './dlpTableParse';

// Exact shape server/core/documents/documentParser.js's parseSpreadsheet
// produces: `| ${headers.join(' | ')} |\n| ${divider.join(' | ')} |\n` then
// one row line per data row.
const SAMPLE = '| Naam | Bedrag |\n| --- | --- |\n| Jan Jansen | 100 |\n| Piet Puk | 250 |\n';

describe('parseMarkdownDocument', () => {
    it('every cell start/end slices the ORIGINAL text back to its own value', () => {
        const blocks = parseMarkdownDocument(SAMPLE);
        const tables = blocks.filter(b => b.type === 'table');
        expect(tables).toHaveLength(1);
        for (const row of tables[0].rows) {
            for (const cell of row) {
                expect(SAMPLE.slice(cell.start, cell.end)).toBe(cell.value);
            }
        }
    });

    it('skips the divider row entirely (not rendered as a data row)', () => {
        const blocks = parseMarkdownDocument(SAMPLE);
        const table = blocks.find(b => b.type === 'table');
        // header + 2 data rows = 3, divider row excluded
        expect(table.rows).toHaveLength(3);
        expect(table.rows[0].map(c => c.value)).toEqual(['Naam', 'Bedrag']);
        expect(table.rows[1].map(c => c.value)).toEqual(['Jan Jansen', '100']);
        expect(table.rows[2].map(c => c.value)).toEqual(['Piet Puk', '250']);
    });

    it('finds "Jan Jansen" at the exact offset a PII finding would report', () => {
        const idx = SAMPLE.indexOf('Jan Jansen');
        const blocks = parseMarkdownDocument(SAMPLE);
        const table = blocks.find(b => b.type === 'table');
        const cell = table.rows[1][0];
        expect(cell.start).toBe(idx);
        expect(cell.end).toBe(idx + 'Jan Jansen'.length);
    });

    it('a non-table preamble line ("### Sheet: X") becomes its own text block with correct offsets', () => {
        const text = `### Sheet: Q1\n${SAMPLE}`;
        const blocks = parseMarkdownDocument(text);
        expect(blocks[0]).toMatchObject({ type: 'text', value: '### Sheet: Q1', start: 0, end: 13 });
        expect(blocks.some(b => b.type === 'table')).toBe(true);
    });

    it('two sheets produce two separate table blocks, not one merged table', () => {
        const text = `### Sheet: A\n${SAMPLE}\n### Sheet: B\n${SAMPLE}`;
        const blocks = parseMarkdownDocument(text);
        const tables = blocks.filter(b => b.type === 'table');
        expect(tables).toHaveLength(2);
    });

    it('plain PDF-style prose (no pipes) becomes a single run of text blocks, no table', () => {
        const text = 'Dit is een gewone alinea zonder tabel.\nTweede regel.';
        const blocks = parseMarkdownDocument(text);
        expect(blocks.every(b => b.type === 'text')).toBe(true);
    });

    it('every cell across the whole document is strictly increasing and non-overlapping', () => {
        // The property that actually matters: two cells (anywhere, any row)
        // never claim the same character, and offsets only move forward —
        // otherwise a span's offset could resolve to the wrong cell.
        const blocks = parseMarkdownDocument(SAMPLE);
        const allCells = blocks.filter(b => b.type === 'table').flatMap(b => b.rows).flat();
        let prevEnd = -1;
        for (const cell of allCells) {
            expect(cell.start).toBeGreaterThanOrEqual(prevEnd);
            expect(cell.end).toBeGreaterThanOrEqual(cell.start);
            prevEnd = cell.end;
        }
    });
});

describe('looksLikeMarkdownTable', () => {
    it('true for spreadsheet-shaped content (>=2 real table rows)', () => {
        expect(looksLikeMarkdownTable(SAMPLE)).toBe(true);
    });
    it('false for plain prose', () => {
        expect(looksLikeMarkdownTable('Just a sentence with | one pipe | in it, not a table.')).toBe(false);
    });
    it('false for empty/undefined text', () => {
        expect(looksLikeMarkdownTable('')).toBe(false);
        expect(looksLikeMarkdownTable(undefined)).toBe(false);
    });
});

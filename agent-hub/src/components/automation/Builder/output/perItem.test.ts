import { describe, expect, it } from 'vitest';
import { cellText } from './cellSummary';
import { discoverColumns, nameColumn, suggestColumns, type OutputColumn } from './columns';
import { cellOf, columnsOf, detailParts, isPerItemRows, problemText, runNoteOf } from './perItem';
import { getByDotted } from './valueHelpers';

/**
 * A Gmail "Read" step that ran once per search result: 4 invented Fabrikam
 * mails with 16 attachments each. The item keys keep the order Postgres JSONB
 * hands them back in; every mail shares one subject on purpose.
 */
const attachments = (m: number) => Array.from({ length: 16 }, (_, i) => ({
    filename: i === 0 ? `Factuur_26509224${m}.pdf` : `Fabrikam_logo_${i}.png`,
    mimeType: i === 0 ? 'application/pdf' : 'image/png',
    size: i === 0 ? 48213 : 1500 + i,
    attachmentId: `att-${m}-${i}`,
    canOCR: i === 0,
    messageId: `msg-${m}`,
    threadId: `thr-${m}`,
}));

const summary = (m: number) => ({
    id: `msg-${m}`, to: 'finance@contoso.example', date: `2026-09-2${m}T08:00:00Z`,
    from: 'Fabrikam Tankpas <no-reply@fabrikam.example>', isBulk: false, snippet: `Factuur ${m}`,
    subject: 'Je Fabrikam factuur', precedence: null, hasListUnsubscribe: false,
});

const read = (m: number) => ({
    id: `msg-${m}`, threadId: `thr-${m}`, from: 'Fabrikam Tankpas <no-reply@fabrikam.example>',
    to: 'finance@contoso.example', subject: 'Je Fabrikam factuur', date: `2026-09-2${m}T08:00:00Z`,
    body: `Uw factuur F-2026-09${m} staat klaar.`, attachments: attachments(m),
});

const MAILS = [1, 2, 3, 4].map((m, index) => ({ index, item: summary(m), output: read(m), status: 'success' }));

const keyOf = (cols: OutputColumn[], perItem: OutputColumn['perItem']) => cols.find(c => c.perItem === perItem)?.key;

describe('a per-item step reads as the table of what it returned', () => {
    it('flattens the output into its own columns, with the item aside', () => {
        expect(isPerItemRows(MAILS)).toBe(true);
        const cols = columnsOf(MAILS, []);
        expect(cols.map(c => c.key)).toEqual([
            'output.id', 'output.threadId', 'output.from', 'output.to', 'output.subject',
            'output.date', 'output.body', 'output.attachments', 'item',
        ]);
        expect(cols.some(c => c.label.startsWith('Output ›'))).toBe(false);
        expect(cols.find(c => c.key === 'output.subject')?.label).toBe('Subject');
        expect(cols.find(c => c.key === 'output.attachments')?.kind).toBe('table');
        expect(cols.filter(c => c.technical).map(c => c.key)).toEqual(['output.id', 'output.threadId']);
        expect(cols.find(c => c.key === 'item')).toMatchObject({ perItem: 'item', role: null });
    });

    it('pins the subject and suggests what the screenshot needs', () => {
        const cols = columnsOf(MAILS, []);
        expect(nameColumn(cols)?.key).toBe('output.subject');
        expect(suggestColumns(cols, { max: 4, usedFields: ['attachments'] }))
            .toEqual(['output.subject', 'output.from', 'output.date', 'output.attachments']);
        const wide = suggestColumns(cols, { max: 7 });
        expect(wide).toEqual(['output.subject', 'output.from', 'output.to', 'output.date', 'output.body', 'output.attachments']);
        for (const k of ['index', 'status', 'item', 'output']) expect(wide).not.toContain(k);
    });

    it('ignores an old split of the output group', () => {
        expect(columnsOf(MAILS, ['output']).map(c => c.key)).toEqual(columnsOf(MAILS, []).map(c => c.key));
    });
});

/** A "Read attachment" step: the PDFs worked, the logos had no OCR. */
const ATTACHMENT_ROWS = [
    { index: 0, item: { filename: 'Factuur_265092240.pdf', mimeType: 'application/pdf' }, output: { filename: 'Factuur_265092240.pdf', mimeType: 'application/pdf', content: 'Factuur', charCount: 7, truncated: false, extractedVia: 'pdfjs', sourceHandle: 'h1' }, status: 'success' },
    { index: 1, item: { filename: 'Fabrikam_logo.png', mimeType: 'image/png' }, output: null, error: 'gmail_read_attachment failed: Could not extract text from Fabrikam_logo.png (image/png): image attachment, no OCR provider configured.', errorClass: 'IntegrationError', attempts: 1, status: 'error' },
    { index: 2, item: { name: 'Contoso header', mimeType: 'image/png' }, output: null, error: 'gmail_read_attachment failed: no OCR', errorClass: 'IntegrationError', attempts: 1, status: 'error' },
];

describe('items that failed', () => {
    it('add a Problem column, suggested right after the pinned one', () => {
        const cols = columnsOf(ATTACHMENT_ROWS, []);
        expect(keyOf(cols, 'problem')).toBe('error');
        expect(cols.some(c => ['errorClass', 'attempts', 'index', 'status'].includes(c.key))).toBe(false);
        const shown = suggestColumns(cols, { max: 4 });
        expect(shown.slice(0, 2)).toEqual(['output.filename', 'error']);
    });

    it('keep the pinned cell recognisable through the item', () => {
        const cols = columnsOf(ATTACHMENT_ROWS, []);
        const filename = cols.find(c => c.key === 'output.filename') as OutputColumn;
        expect(cellOf(ATTACHMENT_ROWS[1], filename, true)).toBe('Fabrikam_logo.png');
        expect(cellOf(ATTACHMENT_ROWS[1], filename, false)).toBeUndefined();
        expect(cellOf(ATTACHMENT_ROWS[2], filename, true)).toBe('Contoso header');
        expect(cellOf(ATTACHMENT_ROWS[0], filename, true)).toBe('Factuur_265092240.pdf');
        const mime = cols.find(c => c.key === 'output.mimeType') as OutputColumn;
        expect(cellOf(ATTACHMENT_ROWS[1], mime, false)).toBeUndefined();
    });

    it('lose the tool name in front of their message', () => {
        expect(problemText(ATTACHMENT_ROWS[1].error)).toBe('Could not extract text from Fabrikam_logo.png (image/png): image attachment, no OCR provider configured.');
        expect(problemText('Rate limited')).toBe('Rate limited');
        expect(problemText(null)).toBe('');
    });
});

describe('other output shapes', () => {
    it('reads text output as one Result column, the item pinned as its name', () => {
        const rows = [
            { index: 0, item: { subject: 'Offerte' }, output: 'Een korte samenvatting', status: 'success' },
            { index: 1, item: { subject: 'Factuur' }, output: 'Nog een samenvatting', status: 'success' },
        ];
        const cols = columnsOf(rows, []);
        expect(cols.map(c => [c.key, c.perItem])).toEqual([['output', 'result'], ['item', 'item']]);
        expect(cols.find(c => c.key === 'item')?.role).toBe('name');
        expect(nameColumn(cols)?.key).toBe('item');
        expect(suggestColumns(cols)).toEqual(['item', 'output']);
    });

    it('names a record output by its own fields, never by the whole item', () => {
        const pdfText = 'FACTUUR F-2026-0917\nFabrikam B.V.\nKlant: Contoso B.V.';
        const rows = [{
            index: 0, item: pdfText, status: 'success',
            output: { invoice: { number: 'F-2026-0917', total: 5570.8, currency: 'EUR' }, lines: [{ sku: 'DSK-180-OAK', quantity: 2 }] },
        }];
        const cols = columnsOf(rows, []);
        expect(cols.find(c => c.key === 'item')).toMatchObject({ perItem: 'item', role: null });
        const pinned = nameColumn(cols) as OutputColumn;
        expect(pinned.key).toBe('output.invoice');
        expect(suggestColumns(cols)).not.toContain('item');
        expect(cellText(cellOf(rows[0], pinned, true), pinned)).toBe('F-2026-0917');
    });

    it('never pins the Problem column, also when a record output has no text column', () => {
        const pdfText = 'FACTUUR F-2026-0918\nFabrikam B.V.';
        const rows = [
            { index: 0, item: pdfText, status: 'success', output: { invoice: { number: 'F-2026-0918', total: 12 }, lines: [{ sku: 'CHR-20', quantity: 4 }] } },
            { index: 1, item: 'unreadable scan', output: null, status: 'error', error: 'extract failed: no text', errorClass: 'IntegrationError', attempts: 1 },
        ];
        const cols = columnsOf(rows, []);
        expect(nameColumn(cols)?.key).toBe('output.invoice');
        expect(suggestColumns(cols, { max: 4 })).toEqual(['output.invoice', 'error', 'output.lines']);
    });

    it('flattens a ```json answer of an AI step', () => {
        const rows = [{ index: 0, item: { n: 1 }, output: '```json\n{"total": 42.1, "currency": "EUR"}\n```', status: 'success' }];
        const cols = columnsOf(rows, []);
        expect(cols.map(c => c.key)).toContain('output.total');
        expect(getByDotted(rows[0], 'output.total')).toBe(42.1);
    });

    it('flattens Loop container rows the same way, without a Problem column', () => {
        const rows = [{ index: 0, item: 'a', output: { title: 'A' } }, { index: 1, item: 'b', output: { title: 'B' } }];
        const cols = columnsOf(rows, []);
        expect(cols.map(c => c.key)).toEqual(['output.title', 'item']);
        expect(keyOf(cols, 'problem')).toBeUndefined();
    });

    it('brackets an output key that is not a plain name, and reads it back', () => {
        const rows = [{ index: 0, item: {}, output: { name: 'a.txt', 'content-type': 'text/plain' }, status: 'success' }];
        const cols = columnsOf(rows, []);
        const type = cols.find(c => c.label === 'Content type') as OutputColumn;
        expect(type.key).toBe('output["content-type"]');
        expect(cellOf(rows[0], type, false)).toBe('text/plain');
    });

    it('leaves rows that are not per-item to discoverColumns', () => {
        const rows = [{ id: 1, supplier: { name: 'Fabrikam', city: 'Utrecht' }, total: 10 }];
        expect(isPerItemRows(rows)).toBe(false);
        expect(columnsOf(rows, ['supplier'])).toEqual(discoverColumns(rows, ['supplier']));
        expect(columnsOf(rows, [])).toEqual(discoverColumns(rows, []));
    });
});

describe('the details of one per-item row', () => {
    it('lists the output, the item and the technical fields, never index or status', () => {
        const parts = detailParts(MAILS[0]);
        expect(parts.problem).toBeNull();
        expect(parts.main.map(([k]) => k)).toEqual(['from', 'to', 'subject', 'date', 'body', 'attachments']);
        expect(parts.base).toBe('output');
        expect(parts.result).toBeUndefined();
        expect(parts.incoming).toBe(MAILS[0].item);
        expect(parts.technical.map(([k]) => k)).toEqual(['id', 'threadId']);
        const keys = [...parts.main, ...parts.technical].map(([k]) => k);
        expect(keys).not.toContain('index');
        expect(keys).not.toContain('status');
    });

    it('leads a failed row with its problem and keeps the error details technical', () => {
        const parts = detailParts(ATTACHMENT_ROWS[1]);
        expect(parts.problem).toMatch(/^Could not extract text/);
        expect(parts.main).toEqual([]);
        expect(parts.result).toBeUndefined();
        expect(parts.technical).toEqual([['errorClass', 'IntegrationError'], ['attempts', 1]]);
    });

    it('shows a single value as the result', () => {
        expect(detailParts({ index: 0, item: 'a', output: 'Klaar', status: 'success' }).result).toBe('Klaar');
    });
});

describe('the run sentence', () => {
    const results: unknown[] = [];
    it('counts the runs and what failed', () => {
        expect(runNoteOf({ iterations: 4, succeeded: 4, failed: 0, results })).toEqual({ ran: 4, failed: 0, cappedAt: null, total: null });
        expect(runNoteOf({ iterations: 1, succeeded: 1, failed: 0, results })).toMatchObject({ ran: 1, failed: 0 });
        expect(runNoteOf({ iterations: 64, succeeded: 4, failed: 60, results })).toMatchObject({ ran: 64, failed: 60 });
        expect(runNoteOf({ iterations: 100, succeeded: 100, failed: 0, results, truncated: true, totalItems: 250 }))
            .toEqual({ ran: 100, failed: 0, cappedAt: 100, total: 250 });
    });

    it('stays away from values without those numbers', () => {
        expect(runNoteOf({ iterations: 3, results })).toBeNull();
        expect(runNoteOf([{ a: 1 }])).toBeNull();
        expect(runNoteOf({ succeeded: 1, failed: 0 })).toBeNull();
        expect(runNoteOf(null)).toBeNull();
    });
});

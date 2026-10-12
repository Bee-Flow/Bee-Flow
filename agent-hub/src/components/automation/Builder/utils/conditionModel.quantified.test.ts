// @vitest-environment node
/**
 * Rule rows over a list inside the item ("any attachment · Mime type ·
 * contains · pdf"), File type rows, the case-insensitive text "is", and what
 * happens to rows when the list moves one level in. Every row the builder can
 * produce must serialise to one exact expression and read back as the same row.
 */
import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/engine.mjs';
import { walkPath } from '../../../../utils/bindingHelpers';
import {
    deepenRows, emptyRow, labelFor, operatorsForType, parseExprToRows, rowForField, rowType, serializeRows,
} from './conditionModel';

type Binding = { kind: string; path?: string; value?: unknown };
type Row = { field: Binding; op: string; value: Binding; quantifier?: string; keepBlank?: true; threshold?: number };
const ref = (path: string): Binding => ({ kind: 'ref', path });
const lit = (value: unknown): Binding => ({ kind: 'literal', value });
const parse = (e: string) => parseExprToRows(e) as { rows: Row[]; join: string } | null;

const MAIL = {
    subject: 'Invoice 7', from: 'billing@fabrikam.example', size: 12,
    attachments: [
        { filename: 'invoice.pdf', mimeType: 'application/pdf', size: 1200 },
        { filename: 'logo.png', mimeType: 'image/png', size: 40 },
    ],
};

// R3: the row, the exact expression it writes, and that it reads back as itself.
const TABLE: Array<[string, Row, string]> = [
    ['text is', { field: ref('item.subject'), op: 'is', value: lit('Invoice 7') }, 'equals(item.subject, "Invoice 7")'],
    ['text is not', { field: ref('item.subject'), op: 'isNot', value: lit('x') }, '!equals(item.subject, "x")'],
    ['any column contains', { field: ref('item.attachments[*].mimeType'), op: 'contains', value: lit('pdf'), quantifier: 'any' },
        'anyOf(item.attachments[*].mimeType, "contains", "pdf")'],
    ['every column ends with', { field: ref('item.attachments[*].filename'), op: 'endsWith', value: lit('.pdf'), quantifier: 'every' },
        'everyOf(item.attachments[*].filename, "endsWith", ".pdf")'],
    ['no column greater than', { field: ref('item.attachments[*].size'), op: 'gt', value: lit(1000), quantifier: 'none' },
        'noneOf(item.attachments[*].size, ">", 1000)'],
    ['any column is (equals)', { field: ref('item.attachments[*].filename'), op: 'is', value: lit('logo.png'), quantifier: 'any' },
        'anyOf(item.attachments[*].filename, "equals", "logo.png")'],
    ['any column is empty', { field: ref('item.attachments[*].filename'), op: 'isEmpty', value: lit(''), quantifier: 'any' },
        'anyOf(item.attachments[*].filename, "isEmpty")'],
    ['every column is not empty', { field: ref('item.attachments[*].filename'), op: 'isNotEmpty', value: lit(''), quantifier: 'every' },
        'everyOf(item.attachments[*].filename, "!isEmpty")'],
    ['File type of the item', { field: ref('fileType(item)'), op: 'is', value: lit('pdf') }, 'equals(fileType(item), "pdf")'],
    ['File type of the item, is not', { field: ref('fileType(item)'), op: 'isNot', value: lit('image') }, '!equals(fileType(item), "image")'],
    ['File type of a field', { field: ref('fileType(item.filename)'), op: 'is', value: lit('word') }, 'equals(fileType(item.filename), "word")'],
    ['File type of an inner list', { field: ref('fileType(item.attachments[*])'), op: 'is', value: lit('pdf'), quantifier: 'any' },
        'anyOf(fileType(item.attachments[*]), "equals", "pdf")'],
    ['no File type of an inner list', { field: ref('fileType(item.attachments[*])'), op: 'isNot', value: lit('image'), quantifier: 'none' },
        'noneOf(fileType(item.attachments[*]), "!equals", "image")'],
    ['records has at least one', { field: ref('item.attachments'), op: 'isNotEmpty', value: lit('') }, '!isEmpty(item.attachments)'],
    ['records has none', { field: ref('item.attachments'), op: 'isEmpty', value: lit('') }, 'isEmpty(item.attachments)'],
];

describe('R3/R4: every row writes one exact expression and reads back as itself', () => {
    it.each(TABLE)('%s', (_name, row, expr) => {
        expect(serializeRows([row], '&&')).toBe(expr);
        expect(parse(expr)).toEqual({ rows: [row], join: '&&' });
        expect(serializeRows(parse(expr)!.rows, '&&')).toBe(expr);
    });

    it('rows joined by && and || round trip together', () => {
        const rows = TABLE.slice(0, 3).map(([, r]) => r);
        for (const join of ['&&', '||']) {
            const expr = serializeRows(rows, join);
            expect(parse(expr)).toEqual({ rows, join });
        }
    });

    it('the written expressions run in the engine', () => {
        const scope = { item: MAIL };
        expect(evaluate('anyOf(fileType(item.attachments[*]), "equals", "pdf")', scope)).toBe(true);
        expect(evaluate('everyOf(fileType(item.attachments[*]), "equals", "pdf")', scope)).toBe(false);
        expect(evaluate('equals(item.subject, " invoice 7 ")', scope)).toBe(true);
    });
});

describe('R5: the legacy column contains opens as a quantified row', () => {
    it('contains(<column>, v) is "any … contains", and is not rewritten by reading', () => {
        const expr = 'contains(item.attachments[*].mimeType, "pdf")';
        expect(parse(expr)?.rows).toEqual([
            { field: ref('item.attachments[*].mimeType'), op: 'contains', quantifier: 'any', value: lit('pdf') },
        ]);
    });

    it('!contains(<column>, v) is "no … contains"', () => {
        expect(parse('!contains(item.attachments[*].mimeType, "pdf")')?.rows[0]).toMatchObject({ quantifier: 'none', op: 'contains' });
    });

    it('a column outside a quantifier is a formula', () => {
        expect(parse('startsWith(item.attachments[*].filename, "a")')).toBeNull();
        expect(parse('item.attachments[*].size > 3')).toBeNull();
        expect(parse('!anyOf(item.attachments[*].size, ">", 3)')).toBeNull();
        expect(parse('anyOf(item.attachments[*].size, "endswith", 3)')).toBeNull();
    });
});

describe('R6: blank rows', () => {
    it('a new row is a blank "is" row and writes nothing', () => {
        expect(emptyRow()).toEqual({ field: ref(''), op: 'is', value: lit('') });
        expect(serializeRows([emptyRow()], '&&')).toBe('');
    });

    it('a binary row with no value is never saved as field == ""', () => {
        expect(serializeRows([{ field: ref('item.a'), op: 'eq', value: lit('') }], '&&')).toBe('');
        expect(serializeRows([{ field: ref('item.a[*].b'), op: 'contains', value: lit(''), quantifier: 'any' }], '&&')).toBe('');
    });

    it('a saved x == "" keeps round-tripping (keepBlank)', () => {
        for (const expr of ['item.status == ""', 'item.status != ""']) {
            const p = parse(expr)!;
            expect(p.rows[0].keepBlank).toBe(true);
            expect(serializeRows(p.rows, p.join)).toBe(expr);
        }
    });
});

describe('R6: rowForField', () => {
    it('a column sets the quantifier to any and resets an operator it cannot test', () => {
        const row = { field: ref('item.subject'), op: 'truthy', value: lit('') };
        expect(rowForField(row, ref('item.attachments[*].mimeType'), 'string'))
            .toEqual({ field: ref('item.attachments[*].mimeType'), op: 'is', value: lit(''), quantifier: 'any' });
    });

    it('File type of a list gets any and "is"', () => {
        expect(rowForField(emptyRow(), ref('fileType(item.attachments[*])'), 'fileType'))
            .toMatchObject({ quantifier: 'any', op: 'is' });
    });

    it('a plain field clears the quantifier and keeps an operator it offers', () => {
        const row = { field: ref('item.attachments[*].mimeType'), op: 'contains', value: lit('pdf'), quantifier: 'any' };
        expect(rowForField(row, ref('item.subject'), 'string')).toEqual({ field: ref('item.subject'), op: 'contains', value: lit('pdf') });
    });

    it('an operator the new field does not offer resets to the first offered', () => {
        const row = { field: ref('item.subject'), op: 'contains', value: lit('x') };
        expect(rowForField(row, ref('item.size'), 'number').op).toBe('eq');
        expect(rowForField(row, ref('item.attachments'), 'records').op).toBe('isNotEmpty');
        expect(rowForField(row, ref('fileType(item)'), 'fileType').op).toBe('is');
    });

    it('R2: File type starts at "Choose a file type", never at a value typed for another field', () => {
        const mime = { field: ref('item.attachments[*].mimeType'), op: 'contains', value: lit('pdf'), quantifier: 'any' as const };
        expect(rowForField(mime, ref('fileType(item.attachments[*])'), 'fileType').value).toEqual(lit(''));
        const fileType = { field: ref('fileType(item.attachments[*])'), op: 'is', value: lit('pdf'), quantifier: 'any' as const };
        // Leaving File type: its key is no text value either.
        expect(rowForField(fileType, ref('item.subject'), 'string').value).toEqual(lit(''));
        // Between two File type fields the chosen type stays.
        expect(rowForField(fileType, ref('fileType(item)'), 'fileType').value).toEqual(lit('pdf'));
    });

    it('drops keepBlank: a newly picked field is a new rule', () => {
        const row = { field: ref('item.status'), op: 'eq', value: lit(''), keepBlank: true as const };
        expect(rowForField(row, ref('item.subject'), 'string')).not.toHaveProperty('keepBlank');
    });
});

describe('R7: legacy == on text', () => {
    it('reads as eq, labelled "is exactly", and writes == back byte for byte', () => {
        const expr = 'item.status == "Open"';
        const p = parse(expr)!;
        expect(p.rows[0].op).toBe('eq');
        expect(serializeRows(p.rows, p.join)).toBe(expr);
        expect(labelFor('eq', 'string')).toBe('is exactly (same upper/lower case)');
    });

    it('is offered on that row only', () => {
        expect(operatorsForType('string').map((o) => o.key)).not.toContain('eq');
        expect(operatorsForType('string', 'eq').map((o) => o.key)).toContain('eq');
    });

    it('numbers keep ==', () => {
        expect(serializeRows([{ field: ref('item.size'), op: 'eq', value: lit(3) }], '&&')).toBe('item.size == 3');
        expect(labelFor('eq', 'number')).toBe('equals');
    });
});

describe('labels and operator menus', () => {
    const t = (key: string, en: string) => `${key}|${en}`;

    it('labelFor reads condition_node.op.<key> with the type variant', () => {
        expect(labelFor('is', 'string', t)).toBe('condition_node.op.is|is');
        expect(labelFor('gt', 'date', t)).toBe('condition_node.op.gt_date|is after');
        expect(labelFor('neq', 'unknown', t)).toBe('condition_node.op.neq_text|is not exactly (same upper/lower case)');
        expect(labelFor('isEmpty', 'records', t)).toBe('condition_node.op.isEmpty_records|has none');
        expect(labelFor('isNotEmpty', 'records')).toBe('has at least one');
    });

    it('a quantified menu offers only what a quantifier can test', () => {
        const keys = operatorsForType('string', null, { quantified: true }).map((o) => o.key);
        expect(keys).toEqual(['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith', 'isEmpty', 'isNotEmpty']);
        expect(operatorsForType('fileType').map((o) => o.key)).toEqual(['is', 'isNot']);
        expect(operatorsForType('records').map((o) => o.key)).toEqual(['isNotEmpty', 'isEmpty']);
    });

    it('menus are translated through t', () => {
        expect(operatorsForType('records', null, { t })[0].label).toBe('condition_node.op.isNotEmpty_records|has at least one');
    });
});

describe('rowType', () => {
    const root = { item: MAIL };
    const type = (path: string) => rowType({ field: ref(path), op: 'is', value: lit('') }, root, walkPath);

    it('reads a column by its first entry, File type as its own type', () => {
        expect(type('item.attachments[*].size')).toBe('number');
        expect(type('item.attachments[*].mimeType')).toBe('string');
        expect(type('fileType(item)')).toBe('fileType');
        expect(type('fileType(item.attachments[*])')).toBe('fileType');
        expect(type('item.attachments')).toBe('records');
        expect(type('item.subject')).toBe('string');
    });

    it('is unknown without a sample or a field', () => {
        expect(rowType({ field: ref('item.subject'), op: 'is', value: lit('') }, null, walkPath)).toBe('unknown');
        expect(rowType(emptyRow(), root, walkPath)).toBe('unknown');
    });
});

describe('R11: deepenRows (the list moves to the attachments)', () => {
    it('rows over item.attachments move onto the attachment', () => {
        const rows: Row[] = [
            { field: ref('item.attachments[*].mimeType'), op: 'contains', value: lit('pdf'), quantifier: 'any' },
            { field: ref('fileType(item.attachments[*])'), op: 'is', value: lit('pdf'), quantifier: 'any' },
        ];
        expect(deepenRows(rows, 'attachments')).toEqual({
            rows: [
                { field: ref('item.mimeType'), op: 'contains', value: lit('pdf') },
                { field: ref('fileType(item)'), op: 'is', value: lit('pdf') },
            ],
            unfit: [],
        });
    });

    it('"no attachment is" becomes "is not" on the attachment', () => {
        const rows: Row[] = [{ field: ref('fileType(item.attachments[*])'), op: 'is', value: lit('image'), quantifier: 'none' }];
        expect(deepenRows(rows, 'attachments').rows[0]).toEqual({ field: ref('fileType(item)'), op: 'isNot', value: lit('image') });
    });

    it('a field of the old item is kept and listed', () => {
        const rows: Row[] = [{ field: ref('item.from'), op: 'contains', value: lit('fabrikam') }];
        expect(deepenRows(rows, 'attachments')).toEqual({ rows, unfit: ['item.from'] });
    });

    it('a "no" row whose operator has no opposite is kept and listed, never hidden', () => {
        const rows: Row[] = [{ field: ref('item.attachments[*].filename'), op: 'endsWith', value: lit('.png'), quantifier: 'none' }];
        expect(deepenRows(rows, 'attachments')).toEqual({ rows, unfit: ['item.attachments[*].filename'] });
    });

    it('rows on another list, or outside the item, are kept; outside ones are not listed', () => {
        const rows: Row[] = [
            { field: ref('item.labels[*].name'), op: 'is', value: lit('x'), quantifier: 'any' },
            { field: ref('trigger.output.limit'), op: 'gt', value: lit(3) },
        ];
        expect(deepenRows(rows, 'attachments')).toEqual({ rows, unfit: ['item.labels[*].name'] });
    });
});

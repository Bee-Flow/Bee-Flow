import { describe, expect, it } from 'vitest';
import { MAILS } from './routeEditors.harness';
import { parseExprToRows } from '../../utils/conditionModel';
import { itemNameOf, listUnitOf, ruleFieldMenu, withNamedFirst, workThroughListPatch } from './routeEditorsModel';

const t = (_key: string, en: string, vars: Record<string, unknown> = {}) =>
    Object.entries(vars).reduce((text, [k, v]) => text.replaceAll(`{${k}}`, String(v)), en);

describe('itemNameOf', () => {
    it('names one item of the list by its singular key', () => {
        expect(itemNameOf('steps.m.output.messages')).toBe('message');
        expect(itemNameOf('steps.m.output.messages[*].attachments')).toBe('attachment');
        expect(itemNameOf('steps.m.output.items')).toBe('item');
        expect(itemNameOf('')).toBe('item');
    });
});

describe('listUnitOf (P3)', () => {
    it('calls the sample rows by the list\'s last key, humanised and lower case', () => {
        expect(listUnitOf('steps.m.output.messages')).toBe('messages');
        expect(listUnitOf('steps.m.output.messages[*].attachments')).toBe('attachments');
        expect(listUnitOf('steps.m.output.lineItems')).toBe('line items');
        expect(listUnitOf('steps.m.output')).toBe('items');
        expect(listUnitOf(null)).toBe('items');
    });
});

describe('ruleFieldMenu (R1)', () => {
    it('mail element: item fields once, then the attachments group with File type first and no column in the item group', () => {
        const menu = ruleFieldMenu(MAILS[0], 'message', t);
        const groups = [...new Set(menu.map((o) => o.group))];
        expect(groups).toEqual(['Fields of each message', 'Attachments of each message']);
        const item = menu.filter((o) => o.group === 'Fields of each message');
        expect(item.map((o) => o.label)).toEqual(['Subject', 'From', 'Attachments']);
        expect(item.find((o) => o.label === 'Attachments')?.kind).toBe('records');
        const inner = menu.filter((o) => o.group === 'Attachments of each message');
        expect(inner[0]).toMatchObject({ label: 'File type', path: 'fileType(item.attachments[*])', quantified: true, kind: 'fileType' });
        expect(inner.slice(1).every((o) => o.quantified && o.path.startsWith('item.attachments[*].'))).toBe(true);
    });

    it('attachment element: File type is the first field of the item', () => {
        const menu = ruleFieldMenu(MAILS[0].attachments[0], 'attachment', t);
        expect(menu[0]).toMatchObject({ label: 'File type', path: 'fileType(item)', group: 'Fields of each attachment' });
    });

    it('no element, no menu', () => {
        expect(ruleFieldMenu(null, 'item', t)).toEqual([]);
        expect(ruleFieldMenu('text', 'item', t)).toEqual([]);
    });
});

describe('withNamedFirst (O3)', () => {
    it('names the internal first rule, keeps an author-chosen name', () => {
        expect(withNamedFirst([{ name: 'keep', expr: 'a', value: '' }], 'Output 1')[0].name).toBe('Output 1');
        expect(withNamedFirst([{ name: 'rule1', expr: 'a', value: '' }], 'Output 1')[0].name).toBe('Output 1');
        expect(withNamedFirst([{ name: 'invoices', expr: 'a', value: '' }], 'Output 1')[0].name).toBe('invoices');
        expect(withNamedFirst([], 'Output 1')).toEqual([{ name: 'Output 1', expr: '', value: '' }]);
    });
});

describe('workThroughListPatch (BFSF-485 F3)', () => {
    it('rebases every rule from list[*] onto item, leaving other paths and quoted text alone', () => {
        const patch = workThroughListPatch(
            [{ name: 'rule1', expr: 'contains(steps.s.output.results[*].name, "steps.s.output.results[*]") && steps.t.output.ok', value: '' }],
            'steps.s.output.results',
        );
        expect(patch).toEqual({
            mode: 'items',
            source: 'steps.s.output.results',
            rules: [{ name: 'rule1', expr: 'contains(item.name, "steps.s.output.results[*]") && steps.t.output.ok', value: '' }],
        });
    });

    // A quantified pick ("any subject contains isv") must land on a row the
    // rows can show, never `anyOf(item.subject, …)`, which reads as a Custom rule.
    const L = 'steps.rm.output.messages';
    const F = 'steps.rm.output.files';
    const moved = (expr: string, list = L) => workThroughListPatch([{ name: 'keep', expr, value: '' }], list)?.rules[0].expr;
    it.each([
        [`anyOf(${L}[*].subject, "contains", "isv")`, 'contains(item.subject, "isv")'],
        [`everyOf(${L}[*].subject, "contains", "isv")`, 'contains(item.subject, "isv")'],
        [`noneOf(${L}[*].subject, "contains", "isv")`, '!contains(item.subject, "isv")'],
    ])('moves the quantified row %s onto the item', (expr, want) => {
        const out = moved(expr) as string;
        expect(out).toBe(want);
        expect(parseExprToRows(out)).not.toBeNull();
    });

    it('moves "any file type is pdf" onto File type of the item', () => {
        const out = moved(`anyOf(fileType(${F}[*]), "equals", "pdf")`, F) as string;
        expect(out).toContain('fileType(item)');
        expect(out).not.toContain('anyOf');
        expect(parseExprToRows(out)).not.toBeNull();
    });

    it('is not offered when no rule reads an item of the list (a membership test on the whole list)', () => {
        expect(workThroughListPatch([{ name: 'keep', expr: 'contains(trigger.output.labels, "urgent")', value: '' }], 'trigger.output.labels')).toBeNull();
    });
});

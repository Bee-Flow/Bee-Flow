/**
 * The Condition editor's list handling, pure: what a change of list does to
 * the rules (R11), "Remove those rules", "Check each item instead" (BFSF-485
 * F3), the notices' words (W7, F3/F4) and the notes under a rule row (R9,
 * R12, a list read as one value). Demo data: Fabrikam mails and their
 * attachments.
 */

import type { FlowNode } from '@/features/flow-editor/bindings';
import { readRoute, type ConditionRow, type FlowDefinition, type RouteRule } from '@/features/flow-editor/model';

import { formulaFieldNames } from './CustomRuleCard';
import { staleSteps, wholeRunReads } from './routeNotices';
import { fieldNameOf, itemNameOf, rulesForSource, withoutRowsReading, workThroughList } from './routeSourceEdits';
import { ruleRowHints, absentFieldName } from './ruleHints';

const T = (_key: string, en: string, vars: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const rule = (expr: string, name = 'keep'): RouteRule => ({ name, expr, value: '' });
const ref = (path: string) => ({ kind: 'ref' as const, path });
const lit = (value: unknown) => ({ kind: 'literal' as const, value });

const MAILS = 'steps.mc_read_many.output.messages';
const ATTACHMENTS = 'steps.mc_read_many.output.messages[*].attachments';
const ATTACHMENT = { filename: 'invoice-0042.pdf', mimeType: 'application/pdf', size: 48213 };

describe('naming the list and its fields', () => {
    it('names one item of the list after its last key, "item" when it has none', () => {
        expect(itemNameOf(MAILS)).toBe('message');
        expect(itemNameOf(ATTACHMENTS)).toBe('attachment');
        expect(itemNameOf('steps.f.output.items')).toBe('item');
        expect(itemNameOf('')).toBe('item');
    });

    it('names a field without its path, and a File type as such', () => {
        expect(fieldNameOf('item.from', T)).toBe('From');
        expect(fieldNameOf('fileType(item.attachments[*])', T)).toBe('File type');
    });

    it('names the fields a formula reads, never its code (R8)', () => {
        expect(formulaFieldNames('len(item.subject) > 3 || contains(lower(item.from.email), "fabrikam") || item.subject == "x"', null, T)).toEqual(['Subject', 'From ▸ Email']);
    });
});

describe('changing the list (R11)', () => {
    it('moves a rule over the inner list onto the attachment itself, and names the rule an attachment cannot read', () => {
        const rules = [rule('anyOf(fileType(item.attachments[*]), "equals", "pdf") && contains(item.from, "fabrikam")')];
        const out = rulesForSource(rules, MAILS, ATTACHMENTS, ATTACHMENT);
        expect(out.rules[0]?.expr).toBe('equals(fileType(item), "pdf") && contains(item.from, "fabrikam")');
        expect(out.unfit).toEqual(['item.from']);
    });

    it('keeps every rule on any other list change, naming the fields the new item lacks', () => {
        const rules = [rule('contains(item.subject, "invoice")'), rule('len(item.x) > 2', 'formula')];
        const out = rulesForSource(rules, MAILS, 'steps.other.output.rows', { total: 3 });
        expect(out.rules).toEqual(rules);
        expect(out.unfit).toEqual(['item.subject']);
        // Without a sample nothing is guessed.
        expect(rulesForSource(rules, MAILS, 'steps.other.output.rows', null).unfit).toEqual([]);
    });

    it('removes only the rows that read the named fields', () => {
        const rules = [rule('equals(fileType(item), "pdf") && contains(item.from, "fabrikam")'), rule('len(item.x) > 2', 'formula')];
        expect(withoutRowsReading(rules, ['item.from'])).toEqual([rule('equals(fileType(item), "pdf")'), rules[1]]);
    });
});

describe('a whole-run Condition that reads a list (BFSF-485)', () => {
    const condition = { id: 'c1', type: 'condition', label: 'Reiskosten?', expr: 'contains(steps.sheets.output.results[*].name, "Reiskosten")' };
    const loop = { id: 'each', type: 'action', label: 'Process sheet', forEach: { overRef: 'steps.sheets.output.results' } };
    const definition = {
        trigger: { id: 'trg', type: 'trigger' },
        steps: [{ id: 'sheets', type: 'action', label: 'List sheets' }, condition, loop],
        edges: [
            { from: 'sheets', to: 'c1' },
            { from: 'c1', to: 'each', label: 'then' },
        ],
    } as unknown as FlowDefinition;

    it('names the list it reads as a whole and the loop after it that still sees every item', () => {
        const reads = wholeRunReads({ step: condition as unknown as FlowNode, route: readRoute(condition as never), definition, sampleRoot: null }, T);
        expect(reads?.lists.map((l) => l.path)).toEqual(['steps.sheets.output.results']);
        expect(reads?.lists[0]?.label).toContain('Results');
        expect(reads?.loops).toEqual([{ stepId: 'each', stepLabel: 'Process sheet' }]);
    });

    it('says nothing for a list-mode route, or a whole-run rule that only checks emptiness', () => {
        const route = readRoute(condition as never);
        expect(wholeRunReads({ step: condition as unknown as FlowNode, route: { ...route, mode: 'items' }, definition, sampleRoot: null }, T)).toBeNull();
        const empty = { ...condition, expr: 'isEmpty(steps.sheets.output.results)' };
        expect(wholeRunReads({ step: empty as unknown as FlowNode, route: readRoute(empty as never), definition, sampleRoot: null }, T)).toBeNull();
    });

    it('turns it into a route that works through the list, every rule rebased onto the item (one patch)', () => {
        expect(workThroughList([rule(condition.expr)], 'steps.sheets.output.results')).toEqual({
            mode: 'items',
            source: 'steps.sheets.output.results',
            rules: [rule('contains(item.name, "Reiskosten")')],
        });
    });

    it('moves a quantified row onto the item as the plain row the rules can show, never a formula', () => {
        const any = 'anyOf(steps.sheets.output.results[*].name, "contains", "Reiskosten")';
        expect(workThroughList([rule(any)], 'steps.sheets.output.results')?.rules).toEqual([rule('contains(item.name, "Reiskosten")')]);
    });

    it('offers nothing when no rule reads an item of the list, so no rule ends up ignoring the item', () => {
        expect(workThroughList([rule('contains(trigger.output.labels, "urgent")')], 'trigger.output.labels')).toBeNull();
    });

    it('does not count a membership check on a list of plain values as a whole-list read', () => {
        const labels = { ...condition, expr: 'contains(trigger.output.labels, "urgent")' };
        const sampleRoot = { trigger: { output: { labels: ['urgent', 'x'] } } };
        expect(wholeRunReads({ step: labels as unknown as FlowNode, route: readRoute(labels as never), definition, sampleRoot }, T)).toBeNull();
    });

    it('names a list of records read whole, but marks it not convertible when no rule reads its items', () => {
        const whole = { ...condition, expr: 'steps.sheets.output.results == "Reiskosten"' };
        const sampleRoot = { steps: { sheets: { output: { results: [{ name: 'Reiskosten' }] } } } };
        const reads = wholeRunReads({ step: whole as unknown as FlowNode, route: readRoute(whole as never), definition, sampleRoot }, T);
        expect(reads?.lists).toEqual([{ path: 'steps.sheets.output.results', label: expect.stringContaining('Results'), convertible: false }]);
    });
});

describe('next steps that still read the list a Condition filters (W7)', () => {
    const definition = {
        trigger: { id: 'trg', type: 'trigger' },
        steps: [
            { id: 'mc_read_many', type: 'action', label: 'Read many' },
            { id: 'mc_condition', type: 'filter', label: 'Condition', arrayRef: MAILS, expr: 'contains(item.from, "fabrikam")' },
            { id: 'mc_read_attachment', type: 'action', label: 'Read attachment', forEach: { overRef: ATTACHMENTS } },
        ],
        edges: [
            { from: 'mc_read_many', to: 'mc_condition' },
            { from: 'mc_condition', to: 'mc_read_attachment' },
        ],
    } as unknown as FlowDefinition;

    it('names the step and the list it still reads', () => {
        const stale = staleSteps(definition, 'mc_condition', T);
        expect(stale).toEqual([{ stepId: 'mc_read_attachment', stepLabel: 'Read attachment', readsLabel: 'Read many ▸ Messages' }]);
        expect(staleSteps(definition, 'mc_read_many', T)).toEqual([]);
        expect(staleSteps(null, 'mc_condition', T)).toEqual([]);
    });

    it('names what a Condition keeps by the Condition, never by its internal keys', () => {
        const chained = {
            ...definition,
            steps: [
                ...(definition.steps || []),
                { id: 'split', type: 'filter', label: 'Split', arrayRef: 'steps.mc_condition.output.items', expr: 'item.size > 1' },
                { id: 'next', type: 'action', label: 'Next', forEach: { overRef: 'steps.mc_condition.output.items' } },
            ],
            edges: [...(definition.edges || []), { from: 'mc_condition', to: 'split' }, { from: 'split', to: 'next' }],
        } as unknown as FlowDefinition;
        const [stale] = staleSteps(chained, 'split', T);
        expect(stale?.readsLabel).toBe('Condition');
        expect(formulaFieldNames('len(steps.sw.output.matchesByCase.default) > 0', new Map([['sw', 'Sort']]), T, new Map([['sw', 'switch']]))).toEqual(['Sort ▸ Otherwise']);
    });
});

describe('the notes under a rule row', () => {
    const row = (path: string, op: string, extra: Partial<ConditionRow> = {}): ConditionRow => ({ field: ref(path), op, value: lit('pdf'), ...extra });
    const sample = { item: { from: 'billing@fabrikam.example', attachments: [ATTACHMENT] } };

    it('says a list of records never "contains" a text, naming the list (R9)', () => {
        const hints = ruleRowHints({ row: row('item.attachments', 'contains'), type: 'records', sampleRoot: sample, context: 'filter', label: 'Attachments' }, T);
        expect(hints).toEqual(['Attachments is a list, so “contains” never matches it. Pick a field under Attachments instead, for example File type.']);
        expect(ruleRowHints({ row: row('item.attachments', 'isNotEmpty'), type: 'records', sampleRoot: sample, context: 'filter' }, T)).toEqual([]);
    });

    it('says a field the sample does not have matches nothing — only when the sample can tell (R12)', () => {
        expect(ruleRowHints({ row: row('item.frm', 'contains'), type: 'unknown', sampleRoot: sample, context: 'filter' }, T)).toEqual([
            'There is no “frm” in the sample data, so this rule would match nothing.',
        ]);
        expect(absentFieldName('item.attachments[*].mimetype', sample)).toBe('mimetype');
        expect(absentFieldName('item.attachments[*].mimeType', sample)).toBeNull();
        expect(absentFieldName('item.frm', null)).toBeNull();
        expect(absentFieldName('item.frm', { item: null })).toBeNull();
    });

    it('notes a list read as one value in list mode only, and never on a quantified row', () => {
        const listed = row('item.attachments[*].mimeType', 'contains');
        const hint = 'This field holds a list. Pick it from the field menu to check any, every or no item of it.';
        expect(ruleRowHints({ row: listed, type: 'string', sampleRoot: sample, context: 'filter' }, T)).toEqual([hint]);
        expect(ruleRowHints({ row: listed, type: 'string', sampleRoot: sample, context: 'condition' }, T)).toEqual([]);
        expect(ruleRowHints({ row: { ...listed, quantifier: 'any' }, type: 'string', sampleRoot: sample, context: 'filter' }, T)).toEqual([]);
    });
});

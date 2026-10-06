import { describe, it, expect } from 'vitest';
import { allRuleMisses, bindingWarningsOf, bindingWarningLine, runStepTypeMap, stepBindingWarnings } from './bindingMisses';

// The run-step row's `bindingWarnings` as the server stores it
// (server/stores/automationStore/bindingWarnings.js).
const MISS = {
    field: 'to', kind: 'ref', path: 'steps.read.output.contact.e-mail', reason: 'missing',
    at: 'steps.read.output.contact', found: 'record', missing: 'e-mail', count: 1,
    description: 'input "to" read steps.read.output.contact.e-mail, but steps.read.output.contact has no "e-mail"',
};
const labels = new Map([['read', 'Read the purchasing inbox']]);
const t = (_key: string, fallback?: unknown, vars?: Record<string, unknown>) =>
    String(fallback ?? '').replace(/\{(\w+)\}/g, (_, v) => String(vars?.[v] ?? ''));

describe('bindingWarningsOf', () => {
    it('keeps well-formed entries and reads null, junk and an empty list as none', () => {
        expect(bindingWarningsOf(null)).toEqual([]);
        expect(bindingWarningsOf('x')).toEqual([]);
        expect(bindingWarningsOf([null, 3, { field: 'to' }])).toEqual([]);
        const [w] = bindingWarningsOf([MISS]);
        expect(w).toMatchObject({ field: 'to', kind: 'ref', path: MISS.path, reason: 'missing', count: 1, description: MISS.description });
    });

    it('reads an unknown reason as missing and a bad count as 1', () => {
        const [w] = bindingWarningsOf([{ path: 'trigger.output.x', reason: 'weird', count: -4 }]);
        expect(w.reason).toBe('missing');
        expect(w.count).toBe(1);
        expect(w.field).toBeNull();
    });

    it('reads the list off a step row of any shape', () => {
        expect(stepBindingWarnings({ stepId: 's1', bindingWarnings: [MISS] })).toHaveLength(1);
        expect(stepBindingWarnings({ stepId: 's1' })).toEqual([]);
        expect(stepBindingWarnings(null)).toEqual([]);
    });
});

describe('bindingWarningLine: which input, which field, and why, without path syntax', () => {
    it('names the input and the source field the way the chips do', () => {
        const line = bindingWarningLine(t, bindingWarningsOf([MISS])[0], labels);
        expect(line.input).toBe('To');
        // The key is humanised by the shared helper (displayHelpers.humanizeFieldKey).
        expect(line.source).toMatch(/^Read the purchasing inbox ▸ Contact ▸ E.mail$/i);
        expect(line.why).toBe('nothing there');
        // The server's sentence and the exact path stay one click away.
        expect(line.detail).toBe(MISS.description);
        expect(line.raw).toBe(MISS.path);
    });

    it('a nested input reads as its parts; no input at all as "A mapping"', () => {
        const [nested, bare] = bindingWarningsOf([
            { ...MISS, field: 'values.due_date' },
            { ...MISS, field: undefined },
        ]);
        expect(bindingWarningLine(t, nested, labels).input).toBe('Values ▸ Due date');
        expect(bindingWarningLine(t, bare, labels).input).toBe('A mapping');
    });

    it('says why in plain words for every reason', () => {
        const why = (over: Record<string, unknown>) => bindingWarningLine(t, bindingWarningsOf([{ ...MISS, ...over }])[0], labels).why;
        expect(why({ reason: 'not_run', step: 'later', path: 'steps.later.output.x' })).toBe('that step did not run');
        expect(why({ reason: 'syntax', path: 'steps.read.output.x[' })).toBe('not a valid path');
        expect(why({ reason: 'syntax', kind: 'expr', path: 'upper(x' })).toBe('not a valid formula');
        expect(why({ reason: 'error', kind: 'expr', path: 'number("a")' })).toBe('the formula failed');
    });

    it('a formula is named as one; its text stays in the detail', () => {
        const [w] = bindingWarningsOf([{ field: 'total', kind: 'expr', path: 'sum(steps.read.output.lines[*].amount', reason: 'syntax', message: 'Expected )' }]);
        const line = bindingWarningLine(t, w, labels);
        expect(line.source).toBe('A formula');
        expect(line.raw).toBe('sum(steps.read.output.lines[*].amount');
        // No server sentence (an older row): the formula's own message.
        expect(line.detail).toBe('Expected )');
    });

    it('a step id the map does not know still reads as a step, not as syntax', () => {
        const line = bindingWarningLine(t, bindingWarningsOf([{ ...MISS, path: 'steps.gone.output.name' }])[0], null);
        expect(line.source).toBe('Previous step ▸ Name');
        expect(line.source).not.toContain('steps.');
    });
});

describe('a rule that matched nothing (binding log kind "rule", V1)', () => {
    // The runner's entry for a Condition whose rule read a typo on all 4 items.
    const RULE = { kind: 'rule', path: 'item.atachments', reason: 'missing', at: 'item', found: 'record', missing: 'atachments', count: 4 };

    it('keeps the kind', () => {
        expect(bindingWarningsOf([RULE])[0].kind).toBe('rule');
    });

    it('names the rule, the item field and how often: "The rule · Each item ▸ Atachments · nothing there · 4×"', () => {
        const line = bindingWarningLine(t, bindingWarningsOf([RULE])[0], labels);
        expect(line.input).toBe('The rule');
        expect(line.source).toBe('Each item ▸ Atachments');
        expect(line.why).toBe('nothing there');
        expect(line.count).toBe(4);
    });

    it('a switch case names its output', () => {
        const line = bindingWarningLine(t, bindingWarningsOf([{ ...RULE, field: 'pdf' }])[0], labels);
        expect(line.input).toBe('Output “pdf”');
    });

    it('allRuleMisses is true only for a non-empty list of rule misses', () => {
        expect(allRuleMisses(bindingWarningsOf([RULE, { ...RULE, field: 'pdf' }]))).toBe(true);
        expect(allRuleMisses(bindingWarningsOf([RULE, MISS]))).toBe(false);
        expect(allRuleMisses([])).toBe(false);
    });
});

describe('a path into a Condition\'s outputs names the output, not the runner\'s keys', () => {
    const definition = {
        trigger: { id: 't1', type: 'trigger' },
        steps: [{ id: 'cond', type: 'filter', label: 'Only invoices' }, { id: 'split', type: 'switch', label: 'By type' }],
    };
    const condLabels = new Map([['cond', 'Only invoices'], ['split', 'By type']]);
    const miss = (path: string) => bindingWarningsOf([{ field: 'to', kind: 'ref', path, reason: 'missing' }])[0];

    it('runStepTypeMap reads every step\'s type', () => {
        const types = runStepTypeMap(definition);
        expect(types.get('cond')).toBe('filter');
        expect(types.get('split')).toBe('switch');
        expect(runStepTypeMap(null).size).toBe(0);
    });

    it('a filter\'s kept list reads as the Condition, not "Items", given the types', () => {
        const typeById = runStepTypeMap(definition);
        expect(bindingWarningLine(t, miss('steps.cond.output.items[*].subject'), condLabels, typeById).source).not.toMatch(/Items/);
        expect(bindingWarningLine(t, miss('steps.cond.output.items[*].subject'), condLabels).source).toMatch(/Items/);
    });

    it('a switch output reads as its name and Otherwise', () => {
        const typeById = runStepTypeMap(definition);
        expect(bindingWarningLine(t, miss('steps.split.output.matchesByCase.default'), condLabels, typeById).source).toBe('By type ▸ Otherwise');
    });
});

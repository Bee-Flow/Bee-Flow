import { describe, expect, it } from 'vitest';
import type { CodeParam } from '@/api/queries/automation/codeStep';
import type { TestCase } from '@/api/queries/automation/testCases';
import {
    assertionFromBody,
    assertionProblems,
    assertionToBody,
    bodyFromDraft,
    caseProblems,
    draftFrom,
    isCaseValid,
    isReadablePath,
    newAssertion,
    pathChoices,
    textFromValue,
    valueFromText,
    type AssertionDraft,
} from './testCaseForm';

const param = (name: string, extra: Partial<CodeParam> = {}): CodeParam => ({
    name, label: name, description: null, type: 'string', required: false, line: 1, ...extra,
});

const draftOf = (over: Partial<AssertionDraft>): AssertionDraft => ({ ...newAssertion('equals', 'a1'), ...over });

describe('values as text', () => {
    it('reads JSON as that value and anything else as text', () => {
        expect(valueFromText('3')).toBe(3);
        expect(valueFromText('true')).toBe(true);
        expect(valueFromText('[1, 2]')).toEqual([1, 2]);
        expect(valueFromText('{"a":1}')).toEqual({ a: 1 });
        expect(valueFromText('hello world')).toBe('hello world');
        expect(valueFromText('"3"')).toBe('3');
    });

    it('writes text that would read as JSON with quotes, so it reads back the same', () => {
        for (const v of ['3', 'true', 'null', '', ' padded', 'plain', 'a "quoted" word', 7, false, null, [1], { a: 'x' }]) {
            expect(valueFromText(textFromValue(v))).toEqual(v);
        }
        expect(textFromValue('plain')).toBe('plain');
        expect(textFromValue('3')).toBe('"3"');
    });
});

describe('paths', () => {
    it('accepts what the shared grammar reads and the whole result', () => {
        for (const p of ['', '$', 'total', 'order.total', 'items[0].name', '[0].id', '$.a.b', '$[0]']) expect(isReadablePath(p)).toBe(true);
    });

    it('refuses what it cannot read', () => {
        for (const p of ['a..b', 'a.', 'items[', '1 + 1']) expect(isReadablePath(p)).toBe(false);
    });

    it('suggests the fields of a result, two levels deep, and the first item of a list', () => {
        expect(pathChoices({ total: 3, order: { id: 'x', lines: [{ sku: 'a' }] } })).toEqual([
            'total', 'order', 'order.id', 'order.lines', 'order.lines[0]',
        ]);
        expect(pathChoices({ items: [{ name: 'a' }] })).toEqual(['items', 'items[0]', 'items[0].name']);
        expect(pathChoices(5)).toEqual([]);
        expect(pathChoices(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i])), 10)).toHaveLength(10);
    });
});

describe('assertions: form and body', () => {
    it('equals, not_equals and contains carry the JSON-or-text value', () => {
        expect(assertionToBody(draftOf({ op: 'equals', path: ' total ', text: '3' }))).toEqual({ id: 'a1', op: 'equals', path: 'total', value: 3 });
        expect(assertionToBody(draftOf({ op: 'not_equals', text: 'done' }))).toEqual({ id: 'a1', op: 'not_equals', path: '', value: 'done' });
        expect(assertionToBody(draftOf({ op: 'contains', text: '"3"' }))).toEqual({ id: 'a1', op: 'contains', path: '', value: '3' });
    });

    it('has_key sends the field name, type_is the type', () => {
        expect(assertionToBody(draftOf({ op: 'has_key', key: ' name ' }))).toMatchObject({ op: 'has_key', value: 'name' });
        expect(assertionToBody(draftOf({ op: 'type_is', type: 'array' }))).toMatchObject({ op: 'type_is', value: 'array' });
    });

    it('count_is sends {cmp, n} with n a whole number', () => {
        expect(assertionToBody(draftOf({ op: 'count_is', cmp: 'gte', n: '3' }))).toMatchObject({ op: 'count_is', value: { cmp: 'gte', n: 3 } });
    });

    it('reads every body back into the same draft values', () => {
        const bodies = [
            { id: 'a', op: 'equals' as const, path: 'x', value: 'plain' },
            { id: 'b', op: 'contains' as const, path: '', value: { k: 1 } },
            { id: 'c', op: 'has_key' as const, path: '', value: 'name' },
            { id: 'd', op: 'type_is' as const, path: 'x', value: 'number' },
            { id: 'e', op: 'count_is' as const, path: 'items', value: { cmp: 'lte', n: 2 } },
        ];
        for (const b of bodies) expect(assertionToBody(assertionFromBody(b))).toEqual(b);
    });

    it('names what is wrong with a row', () => {
        expect(assertionProblems(draftOf({ op: 'equals', text: '' }))).toEqual({ value: 'needed' });
        expect(assertionProblems(draftOf({ op: 'equals', text: '""' }))).toEqual({});
        expect(assertionProblems(draftOf({ op: 'equals', path: 'a..b', text: '1' }))).toEqual({ path: 'invalid' });
        expect(assertionProblems(draftOf({ op: 'has_key', key: '  ' }))).toEqual({ value: 'needed' });
        expect(assertionProblems(draftOf({ op: 'count_is', n: '-1' }))).toEqual({ value: 'bad_number' });
        expect(assertionProblems(draftOf({ op: 'count_is', n: '2.5' }))).toEqual({ value: 'bad_number' });
        expect(assertionProblems(draftOf({ op: 'count_is', n: '0' }))).toEqual({});
        expect(assertionProblems(draftOf({ op: 'type_is' }))).toEqual({});
    });
});

describe('the whole form', () => {
    const params = [param('amount', { type: 'number' }), param('rate', { type: 'number', default: 21 })];

    it('starts a new case from the parameter defaults', () => {
        const d = draftFrom({ params });
        expect(d).toMatchObject({ name: '', expect: 'success', inputKind: 'typed', values: { amount: '', rate: '21' }, assertions: [] });
    });

    it('starts a case from a run as a recorded input, with no checks', () => {
        const d = draftFrom({ params, run: { runId: 'run_1', attempts: 2 } });
        expect(d).toMatchObject({ inputKind: 'run', runId: 'run_1', attempts: 2, assertions: [] });
        expect(bodyFromDraft({ ...d, name: ' From a run ' })).toEqual({
            name: 'From a run', expect: 'success', assertions: [], input: { kind: 'run', runId: 'run_1', attempts: 2 },
        });
    });

    it('sends typed values without blanks, JSON-looking ones parsed', () => {
        const d = { ...draftFrom({ params }), name: 'small', values: { amount: '100', rate: '', tags: '[1,2]' } };
        expect(bodyFromDraft(d).input).toEqual({ kind: 'typed', values: { amount: '100', tags: [1, 2] } });
    });

    it('can leave the input out, so a recorded input is not captured again', () => {
        const d = { ...draftFrom({ params, run: { runId: 'run_1' } }), name: 'x' };
        expect(bodyFromDraft(d, true)).not.toHaveProperty('input');
    });

    const saved = (input: TestCase['input']): TestCase => ({
        id: 'tc_1', stepId: 's1', name: 'Saved', expect: 'error', lastStatus: null, lastRunAt: null, input,
        assertions: [{ id: 'a1', op: 'has_key', path: '', value: 'message' }],
    });

    it('opens a saved typed case with its own values', () => {
        const d = draftFrom({ params, existing: saved({ kind: 'typed', values: { amount: 5 } }) });
        expect(d).toMatchObject({ name: 'Saved', expect: 'error', inputKind: 'typed', values: { amount: '5', rate: '' } });
        expect(d.assertions[0]).toMatchObject({ op: 'has_key', key: 'message' });
    });

    it('opens a recorded case without copying anything from the run into typed values', () => {
        const d = draftFrom({ params, existing: saved({ kind: 'run', runId: 'run_9', available: true }) });
        expect(d).toMatchObject({ inputKind: 'run', runId: 'run_9', values: { amount: '', rate: '21' } });
    });

    it('forgets a run that was deleted, so another has to be picked', () => {
        const d = draftFrom({ params, existing: saved({ kind: 'run', runId: 'run_9', available: false }) });
        expect(d.runId).toBe('');
        expect(caseProblems({ ...d, name: 'x' }).input).toBe('run_needed');
        expect(caseProblems({ ...d, name: 'x' }, 0, true).input).toBeNull();
    });

    it('checks the name, the run, the number of checks and every row', () => {
        const d = { ...draftFrom({ params }), name: ' ' };
        expect(caseProblems(d).name).toBe('needed');
        expect(caseProblems({ ...d, name: 'x'.repeat(81) }).name).toBe('too_long');
        const ok = { ...d, name: 'fine', assertions: [draftOf({ id: 'a', text: '1' }), draftOf({ id: 'b', text: '' })] };
        const p = caseProblems(ok, 1);
        expect(p.tooManyAssertions).toBe(true);
        expect(p.assertions).toEqual({ b: { value: 'needed' } });
        expect(isCaseValid(p)).toBe(false);
        expect(isCaseValid(caseProblems({ ...ok, assertions: [draftOf({ id: 'a', text: '1' })] }, 5))).toBe(true);
    });
});

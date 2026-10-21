import { describe, expect, it } from 'vitest';
import { tryEvaluate } from '@shared/expr/engine.mjs';
import { buildShowIf, isComplete, isConditionable, opsFor, parseShowIf, type ShowIfModel } from './showIfModel';

const EARLIER = ['contact', 'topics', 'company', 'age', 'start', 'agree'];

describe('buildShowIf', () => {
    it.each([
        [{ field: 'contact', op: 'eq', value: 'email' }, 'select', 'form.contact == "email"'],
        [{ field: 'contact', op: 'ne', value: 'email' }, 'select', 'form.contact != "email"'],
        [{ field: 'topics', op: 'contains', value: 'billing' }, 'multiselect', 'contains(form.topics, "billing")'],
        [{ field: 'company', op: 'empty', value: '' }, 'text', 'isEmpty(form.company)'],
        [{ field: 'company', op: 'notEmpty', value: '' }, 'text', '!isEmpty(form.company)'],
        [{ field: 'age', op: 'gt', value: '3' }, 'number', 'form.age > 3'],
        [{ field: 'age', op: 'lt', value: '2.5' }, 'number', 'form.age < 2.5'],
        [{ field: 'start', op: 'gt', value: '2026-01-31' }, 'date', 'form.start > "2026-01-31"'],
        [{ field: 'agree', op: 'eq', value: 'true' }, 'checkbox', 'form.agree == true'],
        [{ field: 'agree', op: 'eq', value: 'false' }, 'checkbox', 'form.agree == false'],
    ] as [ShowIfModel, string, string][])('%j on a %s question', (model, type, expr) => {
        expect(buildShowIf(model, type)).toBe(expr);
    });

    it('escapes quotes and backslashes in a string literal', () => {
        const model: ShowIfModel = { field: 'contact', op: 'eq', value: 'say "hi" \\ now' };
        const expr = buildShowIf(model, 'text');
        expect(expr).toBe('form.contact == "say \\"hi\\" \\\\ now"');
        expect(parseShowIf(expr, EARLIER)).toEqual(model);
    });

    it('does not let a value break out of its literal', () => {
        const expr = buildShowIf({ field: 'contact', op: 'eq', value: '" || true || "' }, 'text');
        // The whole value stays one string literal, so the engine compares text with text.
        const run = tryEvaluate(expr, { form: { contact: 'x' } });
        expect(run.error).toBeNull();
        expect(run.value).toBe(false);
    });

    it('writes a number as text when it is not numeric', () => {
        expect(buildShowIf({ field: 'age', op: 'eq', value: 'abc' }, 'number')).toBe('form.age == "abc"');
    });

    it('writes nothing until the condition is complete', () => {
        expect(buildShowIf({ field: 'contact', op: 'eq', value: '' }, 'select')).toBe('');
        expect(buildShowIf({ field: '', op: 'empty', value: '' }, 'text')).toBe('');
        expect(buildShowIf(null)).toBe('');
        expect(isComplete({ field: 'contact', op: 'eq', value: ' ' })).toBe(false);
    });

    it('quotes a key that is not a plain identifier', () => {
        expect(buildShowIf({ field: 'full name', op: 'empty', value: '' }, 'text')).toBe('isEmpty(form["full name"])');
    });
});

describe('parseShowIf', () => {
    it.each([
        'form.contact == "email"',
        'form.contact != "email"',
        'contains(form.topics, "billing")',
        'isEmpty(form.company)',
        '!isEmpty(form.company)',
        'form.age > 3',
        'form.age < 2.5',
        'form.start > "2026-01-31"',
        'form.agree == true',
    ])('round-trips %s', (expr) => {
        const model = parseShowIf(expr, EARLIER);
        expect(model).not.toBeNull();
        const field = (model as ShowIfModel).field;
        const type = ({ contact: 'select', topics: 'multiselect', company: 'text', age: 'number', start: 'date', agree: 'checkbox' } as Record<string, string>)[field];
        expect(buildShowIf(model, type)).toBe(expr);
    });

    it('is tolerant of spacing', () => {
        expect(parseShowIf('  form.contact=="email" ', EARLIER)).toEqual({ field: 'contact', op: 'eq', value: 'email' });
        expect(parseShowIf('! isEmpty( form.company )', EARLIER)).toBeNull();
        expect(parseShowIf('contains( form.topics ,"x" )', EARLIER)).toEqual({ field: 'topics', op: 'contains', value: 'x' });
    });

    it.each([
        'form.contact == "a" && form.company == "b"',
        'form.age >= 3',
        'len(form.company) > 2',
        'trigger.output.x == 1',
        'form.contact == form.company',
        '',
    ])('leaves %j for the advanced text box', (expr) => {
        expect(parseShowIf(expr, EARLIER)).toBeNull();
    });

    it('does not offer a question that is not earlier on the page', () => {
        expect(parseShowIf('form.later == "x"', EARLIER)).toBeNull();
    });

    it('reads a bracketed key', () => {
        expect(parseShowIf('isEmpty(form["full name"])', ['full name'])).toEqual({ field: 'full name', op: 'empty', value: '' });
    });
});

describe('what the generated text does in the engine', () => {
    it('evaluates against the form scope', () => {
        const scope = { form: { contact: 'email', topics: ['billing', 'other'], company: '', age: 5 } };
        const run = (m: ShowIfModel, t: string) => tryEvaluate(buildShowIf(m, t), scope).value;
        expect(run({ field: 'contact', op: 'eq', value: 'email' }, 'select')).toBe(true);
        expect(run({ field: 'topics', op: 'contains', value: 'billing' }, 'multiselect')).toBe(true);
        expect(run({ field: 'company', op: 'empty', value: '' }, 'text')).toBe(true);
        expect(run({ field: 'company', op: 'notEmpty', value: '' }, 'text')).toBe(false);
        expect(run({ field: 'age', op: 'gt', value: '3' }, 'number')).toBe(true);
    });
});

describe('opsFor', () => {
    it('offers contains for lists and text, comparisons for numbers and dates only', () => {
        expect(opsFor('multiselect')).toContain('contains');
        expect(opsFor('text')).toContain('contains');
        expect(opsFor('select')).not.toContain('contains');
        expect(opsFor('number')).toEqual(expect.arrayContaining(['gt', 'lt']));
        expect(opsFor('text')).not.toContain('gt');
        expect(opsFor('file')).toEqual([]);
    });

    it('skips display fields, uploads and per-item templates', () => {
        expect(isConditionable({ type: 'info' })).toBe(false);
        expect(isConditionable({ type: 'file' })).toBe(false);
        expect(isConditionable({ type: 'text', fieldsFrom: { ref: 'steps.a.output.rows' } })).toBe(false);
        expect(isConditionable({ type: 'radio' })).toBe(true);
    });
});

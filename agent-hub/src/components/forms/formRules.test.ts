// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { fieldError, groupBlocks, initialValues, isBlank, isDisplayField, ruleError, submissionValues, typicalDurationText, visibleNames } from './formRules';
import type { FormFieldDef } from './PublicFormRenderer.types';

// The same fallback-then-interpolate behaviour the real translator has.
const t = (key: string, fallbackOrParams?: string | Record<string, unknown>, params?: Record<string, unknown>): string => {
    const fallback = typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
    const p = typeof fallbackOrParams === 'string' ? params : fallbackOrParams;
    return Object.entries(p || {}).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), fallback);
};

const f = (over: Partial<FormFieldDef> & { name: string }): FormFieldDef => ({ type: 'text', label: over.name, ...over });

describe('initialValues / isBlank / isDisplayField', () => {
    it('gives multiselect an empty list and display fields no entry', () => {
        const values = initialValues([
            f({ name: 'topics', type: 'multiselect' }),
            f({ name: 'note', type: 'info', content: 'Hi' }),
            f({ name: 'report', type: 'download' }),
            f({ name: 'agree', type: 'checkbox' }),
            f({ name: 'size', type: 'radio' }),
        ]);
        expect(values).toEqual({ topics: [], agree: false, size: '' });
    });

    it('counts info among the display-only types', () => {
        expect(['info', 'download', 'notebook'].every(type => isDisplayField(f({ name: 'x', type })))).toBe(true);
        expect(isDisplayField(f({ name: 'x', type: 'radio' }))).toBe(false);
    });

    it('treats an empty multiselect as blank', () => {
        const field = f({ name: 'topics', type: 'multiselect' });
        expect(isBlank(field, [])).toBe(true);
        expect(isBlank(field, ['a'])).toBe(false);
    });
});

describe('visibleNames', () => {
    const fields = [
        f({ name: 'contact', type: 'radio' }),
        f({ name: 'email', type: 'email', showIf: 'form.contact == "email"' }),
        f({ name: 'email_note', type: 'text', showIf: '!isEmpty(form.email)' }),
        f({ name: 'topics', type: 'multiselect' }),
        f({ name: 'billing', type: 'text', showIf: 'contains(form.topics, "billing")' }),
    ];

    it('shows a field with no condition, hides one whose condition is false', () => {
        const visible = visibleNames(fields, { contact: '', email: '', email_note: '', topics: [], billing: '' });
        expect([...visible]).toEqual(['contact', 'topics']);
    });

    it('reveals a field when an earlier answer satisfies its condition', () => {
        const visible = visibleNames(fields, { contact: 'email', email: '', email_note: '', topics: ['billing'], billing: '' });
        expect(visible.has('email')).toBe(true);
        expect(visible.has('billing')).toBe(true);
        expect(visible.has('email_note')).toBe(false);
    });

    it('unwinds a chain: a hidden question counts as empty for the one below it', () => {
        // email holds a stale answer, but it is hidden (contact is not "email"),
        // so email_note, which depends on it, stays hidden too.
        const visible = visibleNames(fields, { contact: 'phone', email: 'a@b.nl', email_note: '', topics: [], billing: '' });
        expect(visible.has('email')).toBe(false);
        expect(visible.has('email_note')).toBe(false);
        const open = visibleNames(fields, { contact: 'email', email: 'a@b.nl', email_note: '', topics: [], billing: '' });
        expect(open.has('email_note')).toBe(true);
    });

    it('fails open: a condition that cannot be read leaves the question visible', () => {
        const broken = [f({ name: 'a' }), f({ name: 'b', showIf: 'form.a ==' }), f({ name: 'c', showIf: 'nope(' })];
        expect([...visibleNames(broken, { a: '', b: '', c: '' })]).toEqual(['a', 'b', 'c']);
    });

    it('reads a number as a number', () => {
        const fs = [f({ name: 'n', type: 'number' }), f({ name: 'big', showIf: 'form.n > 10' })];
        expect(visibleNames(fs, { n: '5', big: '' }).has('big')).toBe(false);
        expect(visibleNames(fs, { n: '50', big: '' }).has('big')).toBe(true);
    });

    it('lets a later question read a group as one list', () => {
        const fs = [
            f({ name: 'rate__0', type: 'info', group: 'rate', groupHeader: true }),
            f({ name: 'rate__1', type: 'radio', group: 'rate', groupKey: 'a' }),
            f({ name: 'follow', showIf: 'len(form.rate) > 0' }),
        ];
        expect(visibleNames(fs, { rate__1: '', follow: '' }).has('follow')).toBe(true);
    });
});

describe('ruleError', () => {
    it('checks number bounds', () => {
        const field = f({ name: 'age', type: 'number', label: 'Age', min: 18, max: 65 });
        expect(ruleError(field, '17', t)).toBe('Age must be at least 18.');
        expect(ruleError(field, '66', t)).toBe('Age must be at most 65.');
        expect(ruleError(field, '30', t)).toBeNull();
    });

    it('checks date bounds as text', () => {
        const field = f({ name: 'when', type: 'date', label: 'Date', min: '2026-01-10', max: '2026-01-20' });
        expect(ruleError(field, '2026-01-09', t)).toBe('Date must be on or after 2026-01-10.');
        expect(ruleError(field, '2026-01-21', t)).toBe('Date must be on or before 2026-01-20.');
        expect(ruleError(field, '2026-01-15', t)).toBeNull();
    });

    it('checks length in characters, not code units', () => {
        const field = f({ name: 'code', label: 'Code', minLength: 2, maxLength: 3 });
        expect(ruleError(field, 'a', t)).toBe('Code must be at least 2 characters.');
        expect(ruleError(field, 'abcd', t)).toBe('Code must be at most 3 characters.');
        expect(ruleError(field, '😀😀😀', t)).toBeNull();
    });

    it('matches a pattern against the whole value and prefers the authored message', () => {
        const field = f({ name: 'ref', label: 'Reference', pattern: '[A-Z]{2}-[0-9]{3}', patternMessage: 'Use a code like AB-123.' });
        expect(ruleError(field, 'AB-123', t)).toBeNull();
        expect(ruleError(field, 'xAB-123', t)).toBe('Use a code like AB-123.');
        expect(ruleError(field, 'AB-1234', t)).toBe('Use a code like AB-123.');
        expect(ruleError({ ...field, patternMessage: undefined }, 'nope', t)).toBe('Reference is not in the expected format.');
    });

    it('does not let an unbalanced pattern escape its anchors', () => {
        const field = f({ name: 'x', pattern: 'a)|(b' });
        expect(ruleError(field, 'zzz', t)).toBeNull();
    });

    it('skips a pattern it cannot compile and one that could freeze the tab', () => {
        expect(ruleError(f({ name: 'x', pattern: '[' }), 'anything', t)).toBeNull();
        expect(ruleError(f({ name: 'x', pattern: '(a+)+$' }), 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!', t)).toBeNull();
    });

    it('checks how many choices a multiselect holds', () => {
        const field = f({ name: 'topics', type: 'multiselect', label: 'Topics', minSelected: 2, maxSelected: 3 });
        expect(ruleError(field, ['a'], t)).toBe('Topics must have at least 2 choices.');
        expect(ruleError(field, ['a', 'b', 'c', 'd'], t)).toBe('Topics must have at most 3 choices.');
        expect(ruleError(field, ['a', 'b'], t)).toBeNull();
        expect(ruleError({ ...field, minSelected: 1, maxSelected: 1 }, ['a', 'b'], t)).toBe('Topics must have at most 1 choice.');
    });

    it('never judges a blank answer', () => {
        expect(ruleError(f({ name: 'x', minLength: 5 }), '', t)).toBeNull();
        expect(ruleError(f({ name: 'x', type: 'multiselect', minSelected: 2 }), [], t)).toBeNull();
    });
});

describe('fieldError', () => {
    it('reports a blank required question, but not when its list came back empty', () => {
        expect(fieldError(f({ name: 'x', label: 'Name', required: true }), '', t)).toBe('Name is required.');
        expect(fieldError(f({ name: 'x', type: 'select', required: true, noOptions: true }), '', t)).toBeNull();
    });

    it('leaves "required" out when asked to (the blur check)', () => {
        expect(fieldError(f({ name: 'x', required: true }), '', t, { checkRequired: false })).toBeNull();
        expect(fieldError(f({ name: 'x', minLength: 3, label: 'X' }), 'ab', t, { checkRequired: false })).toBe('X must be at least 3 characters.');
    });
});

describe('submissionValues', () => {
    it('drops hidden fields and display-only fields', () => {
        const fields = [
            f({ name: 'contact', type: 'radio' }),
            f({ name: 'intro', type: 'info', content: 'x' }),
            f({ name: 'email', type: 'email', showIf: 'form.contact == "email"' }),
            f({ name: 'topics', type: 'multiselect' }),
        ];
        const values = { contact: 'phone', email: 'stale@example.test', topics: ['a'] };
        const visible = visibleNames(fields, values);
        expect(submissionValues(fields, values, visible)).toEqual({ contact: 'phone', topics: ['a'] });
    });
});

describe('groupBlocks', () => {
    const fields = [
        f({ name: 'intro', type: 'info' }),
        f({ name: 'rate__0', type: 'info', group: 'rate', groupHeader: true }),
        f({ name: 'rate__1', type: 'radio', group: 'rate', groupKey: 'a' }),
        f({ name: 'rate__2', type: 'radio', group: 'rate', groupKey: 'b' }),
        f({ name: 'empty__0', type: 'info', group: 'empty', groupHeader: true }),
        f({ name: 'last' }),
    ];

    it('puts a header and its items in one block and leaves other fields alone', () => {
        const blocks = groupBlocks(fields, new Set(fields.map(x => x.name)));
        expect(blocks.map(b => (b.kind === 'field' ? b.field.name : `${b.group}:${b.items.length}`))).toEqual(['intro', 'rate:2', 'last']);
    });

    it('drops a group that has no visible item', () => {
        const names = new Set(['rate__0', 'rate__1', 'rate__2', 'last'].filter(n => n !== 'rate__1' && n !== 'rate__2'));
        expect(groupBlocks(fields, names).map(b => b.kind)).toEqual(['field']);
    });
});

describe('typicalDurationText', () => {
    it('buckets seconds into a sentence', () => {
        expect(typicalDurationText(30, t)).toBe('Usually takes less than a minute');
        expect(typicalDurationText(59, t)).toBe('Usually takes less than a minute');
        expect(typicalDurationText(60, t)).toBe('Usually takes about 1 minute');
        expect(typicalDurationText(150, t)).toBe('Usually takes about 3 minutes');
        expect(typicalDurationText(60 * 89, t)).toBe('Usually takes about 89 minutes');
        expect(typicalDurationText(60 * 90, t)).toBe('Usually takes about 2 hours');
        expect(typicalDurationText(3600 * 5, t)).toBe('Usually takes about 5 hours');
    });

    it('says nothing when the length is unknown', () => {
        expect(typicalDurationText(null, t)).toBe('');
        expect(typicalDurationText(undefined, t)).toBe('');
        expect(typicalDurationText(0, t)).toBe('');
        expect(typicalDurationText(Number.NaN, t)).toBe('');
    });
});

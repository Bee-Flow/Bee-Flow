/** Form values ↔ records ↔ bodies: what a create sends, what an edit sends, how a value reads. */

import {
    bodyValue,
    choiceOf,
    createBody,
    fieldValue,
    formatValue,
    initialValues,
    labelText,
    matchesSearch,
    patchBody,
    statusOf,
    summaryOf,
    usesMembers,
    validateFields,
} from './fields';
import { RISKS } from './recordsIso';
import type { FieldSpec, Formatter } from './types';

const t = (_key: string, fallback: string, params?: Record<string, unknown>) =>
    fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(params?.[k] ?? ''));
const fmt: Formatter = {
    t,
    now: Date.UTC(2026, 9, 5, 12),
    date: (v) => (typeof v === 'string' ? v.slice(0, 10) : null),
    dayTime: (v) => (typeof v === 'string' ? `at ${v.slice(11, 16)}` : null),
    stamp: (v) => (typeof v === 'string' ? v : null),
    user: (id) => (id === 'u1' ? 'Ann' : id === 'u2' ? 'Bob' : typeof id === 'string' && id ? '—' : null),
};

const L = { i18nKey: 'x.y', en: 'Label' };
const TEXT: FieldSpec = { key: 'title', label: L, kind: 'text', required: true };
const DATE: FieldSpec = { key: 'due_at', label: L, kind: 'date' };
const NUM: FieldSpec = { key: 'months', label: L, kind: 'number' };
const BOOL: FieldSpec = { key: 'on', label: L, kind: 'bool' };
const LINES: FieldSpec = { key: 'list', label: L, kind: 'lines' };
const SCALE: FieldSpec = { key: 'impact', label: L, kind: 'choice', numeric: true, options: [{ value: '3', label: '3' }], initial: '3' };
const BODY: FieldSpec = { key: 'draft_body', body: 'body', label: L, kind: 'multiline' };

describe('fieldValue / initialValues', () => {
    it('reads a record into strings and booleans', () => {
        expect(initialValues([TEXT, DATE, NUM, BOOL, LINES, SCALE], { title: 'A', due_at: '2026-10-01T00:00:00Z', months: 12, on: true, list: ['a', 'b'], impact: 4 })).toEqual({
            title: 'A',
            due_at: '2026-10-01',
            months: '12',
            on: true,
            list: 'a\nb',
            impact: '4',
        });
    });

    it('starts a create form at the declared defaults', () => {
        expect(initialValues([TEXT, BOOL, SCALE])).toEqual({ title: '', on: false, impact: '3' });
        expect(fieldValue({ ...BOOL, initial: true }, undefined)).toBe(true);
        expect(fieldValue(DATE, 'x')).toBe('');
    });
});

describe('bodies', () => {
    it('types each value as it travels', () => {
        expect(bodyValue(TEXT, '  hi ')).toBe('hi');
        expect(bodyValue(TEXT, '   ')).toBeNull();
        expect(bodyValue(NUM, '12')).toBe(12);
        expect(bodyValue(SCALE, '4')).toBe(4);
        expect(bodyValue(BOOL, true)).toBe(true);
        expect(bodyValue(LINES, 'a\n\n b ')).toEqual(['a', 'b']);
    });

    it('leaves empty fields out of a create body and renames to the body key', () => {
        expect(createBody([TEXT, DATE, BOOL, LINES, BODY], { title: 'Risk', due_at: '', on: false, list: '', draft_body: '# Doc' })).toEqual({
            title: 'Risk',
            on: false,
            body: '# Doc',
        });
    });

    it('sends only what changed on an edit, an emptied field as null', () => {
        const rec = { title: 'Old', due_at: '2026-10-01T00:00:00Z', months: 12 };
        expect(patchBody([TEXT, DATE, NUM], rec, { title: 'Old', due_at: '', months: '24' })).toEqual({ due_at: null, months: 24 });
        expect(patchBody([TEXT, DATE, NUM], rec, initialValues([TEXT, DATE, NUM], rec))).toEqual({});
    });
});

describe('validateFields', () => {
    it('asks for a required field, a real date and a number', () => {
        expect(validateFields([TEXT, DATE, NUM], { title: '', due_at: '1 Oct', months: 'x' }, t)).toEqual({
            title: 'Label is required.',
            due_at: 'Write the date as YYYY-MM-DD.',
            months: 'Enter a number.',
        });
        expect(validateFields([TEXT, DATE], { title: 'ok', due_at: '2026-10-01' }, t)).toEqual({});
    });
});

describe('reading records', () => {
    const risk = { id: '7', title: 'Leak', score: 12, category: 'confidentiality', review_due_at: '2026-11-01T00:00:00Z', status: 'treating', owner_user_id: 'u1', description: 'Prompt leak' };

    it('formats a value by its kind', () => {
        expect(formatValue(BOOL, true, fmt)).toBe('Yes');
        expect(formatValue(BOOL, false, fmt)).toBe('No');
        expect(formatValue({ key: 'o', label: L, kind: 'user' }, 'u1', fmt)).toBe('Ann');
        expect(formatValue(LINES, ['a', 'b'], fmt)).toBe('a, b');
        expect(formatValue(LINES, [], fmt)).toBeNull();
        expect(formatValue(TEXT, '', fmt)).toBeNull();
        expect(formatValue(TEXT, { a: 1 }, fmt)).toBeNull();
    });

    it('summarises a row and finds its status chip', () => {
        expect(summaryOf(RISKS, risk, fmt)).toBe('12 · Confidentiality · 2026-11-01');
        expect(statusOf(RISKS, risk)?.value).toBe('treating');
        expect(labelText(statusOf(RISKS, risk)?.label ?? '', t)).toBe('Treating');
        expect(choiceOf(undefined, 'x')).toBeNull();
    });

    it('matches a search on the title or the searchable keys', () => {
        expect(matchesSearch(RISKS, risk, 'leak', fmt)).toBe(true);
        expect(matchesSearch(RISKS, risk, 'prompt', fmt)).toBe(true);
        expect(matchesSearch(RISKS, risk, 'nothing', fmt)).toBe(false);
    });

    it('knows which registers show owners', () => {
        expect(usesMembers(RISKS)).toBe(true);
    });
});

describe('the new field kinds', () => {
    const MOMENT: FieldSpec = { key: 'detected_at', label: L, kind: 'moment' };
    const USERS: FieldSpec = { key: 'recipients', label: L, kind: 'users' };
    const JSON_F: FieldSpec = { key: 'config', label: L, kind: 'json' };
    const NOW = Date.UTC(2026, 9, 5, 12);

    it('reads and sends a moment as an ISO instant, shown with its time', () => {
        expect(fieldValue(MOMENT, '2026-10-05T10:00:00.000Z')).toBe('2026-10-05T10:00:00.000Z');
        expect(bodyValue(MOMENT, '2026-10-05T10:00:00.000Z')).toBe('2026-10-05T10:00:00.000Z');
        expect(formatValue(MOMENT, '2026-10-05T10:00:00.000Z', fmt)).toBe('at 10:00');
        expect(validateFields([MOMENT], { detected_at: new Date(NOW + 3_600_000).toISOString() }, t, { now: NOW }).detected_at).toMatch(/future/);
        expect(validateFields([MOMENT], { detected_at: new Date(NOW + 60_000).toISOString() }, t, { now: NOW })).toEqual({});
    });

    it('keeps members as string arrays and names them', () => {
        expect(fieldValue(USERS, ['u1', 'u2'])).toEqual(['u1', 'u2']);
        expect(fieldValue(USERS, null)).toEqual([]);
        expect(bodyValue(USERS, ['u1', ''])).toEqual(['u1']);
        expect(formatValue(USERS, ['u1', 'gone'], fmt)).toBe('Ann, —');
        expect(createBody([USERS], { recipients: [] })).toEqual({});
        expect(patchBody([USERS], { recipients: ['u1'] }, { recipients: ['u1'] })).toEqual({});
        expect(patchBody([USERS], { recipients: ['u1'] }, { recipients: ['u1', 'u2'] })).toEqual({ recipients: ['u1', 'u2'] });
        expect(validateFields([{ ...USERS, required: true }], { recipients: [] }, t).recipients).toMatch(/required/);
        expect(usesMembers({ ...RISKS, facts: [USERS] })).toBe(true);
    });

    it('parses JSON, sends {} for empty and refuses what is not an object', () => {
        expect(fieldValue(JSON_F, { a: 1 })).toBe('{\n  "a": 1\n}');
        expect(bodyValue(JSON_F, '{"a":1}')).toEqual({ a: 1 });
        expect(createBody([JSON_F], { config: '' })).toEqual({ config: {} });
        expect(validateFields([JSON_F], { config: '{oops' }, t).config).toBe('Not valid JSON — nothing was saved.');
        expect(validateFields([JSON_F], { config: '[1]' }, t).config).toBeDefined();
        expect(formatValue(JSON_F, { a: 1 }, fmt)).toBe('{"a":1}');
    });

    it('calls a function initial when the form opens', () => {
        const spec: FieldSpec = { key: 'detected_at', label: L, kind: 'moment', initial: () => 'NOW' };
        expect(initialValues([spec]).detected_at).toBe('NOW');
    });
});

describe('field rules', () => {
    const A: FieldSpec = { key: 'a', label: L, kind: 'text', validate: (v) => (v === 'bad' ? 'No.' : null) };
    const B: FieldSpec = { key: 'b', label: L, kind: 'text', required: true, visible: (_rec, values) => values.a === 'show' };

    it('runs the spec validate after the built-ins', () => {
        expect(validateFields([A], { a: 'bad' }, t)).toEqual({ a: 'No.' });
        expect(validateFields([{ ...A, required: true }], { a: '' }, t).a).toMatch(/required/);
    });

    it('skips hidden fields when validating and sending', () => {
        expect(validateFields([A, B], { a: 'x', b: '' }, t)).toEqual({});
        expect(validateFields([A, B], { a: 'show', b: '' }, t).b).toMatch(/required/);
        expect(createBody([A, B], { a: 'x', b: 'kept out' })).toEqual({ a: 'x' });
    });

    it('passes the record and the clock to validate', () => {
        const spy = jest.fn().mockReturnValue(null);
        validateFields([{ key: 'c', label: L, kind: 'text', validate: spy }], { c: 'v' }, t, { rec: { id: 'r' }, now: 5 });
        expect(spy).toHaveBeenCalledWith('v', { c: 'v' }, { t, rec: { id: 'r' }, now: 5 });
    });
});

describe('search', () => {
    it('matches searchText and string-array values', () => {
        const type = { ...RISKS, search: ['tags'], searchText: (rec: Record<string, unknown>) => String(rec.extra ?? '') };
        const rec = { id: '1', title: 'Phishing', tags: ['Mail', 'Spoof'], extra: 'owner Ann' };
        expect(matchesSearch(type, rec, 'spoof', fmt)).toBe(true);
        expect(matchesSearch(type, rec, 'ann', fmt)).toBe(true);
        expect(matchesSearch(type, rec, 'zzz', fmt)).toBe(false);
    });
});

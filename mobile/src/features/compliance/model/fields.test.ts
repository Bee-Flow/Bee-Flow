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
const fmt: Formatter = { t, date: (v) => (typeof v === 'string' ? v.slice(0, 10) : null), user: (id) => (id === 'u1' ? 'Ann' : typeof id === 'string' ? id : null) };

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

// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    buildPayload, checkAnswers, emptyAnswers, fieldErrorsFromResponse, pageLocale, usableFields,
} from './formBlockModel';

const MESSAGES = { required: 'required', email: 'email' };

describe('usableFields', () => {
    it('keeps well-formed fields of a known type and drops the rest', () => {
        const fields = usableFields([
            { id: 'name', type: 'text', label: 'Name', required: true },
            { id: 'name', type: 'text' },
            { id: '1bad', type: 'text' },
            { id: 'file', type: 'file' },
            { id: 'topic', type: 'select', options: [{ value: 'a', label: 'A' }, { value: '' }, { label: 'no value' }] },
            'nope',
        ]);
        expect(fields.map(f => f.id)).toEqual(['name', 'topic']);
        expect(fields[0].required).toBe(true);
        expect(fields[1].options).toEqual([{ value: 'a', label: 'A' }]);
    });

    it('reads anything that is not a list as no fields', () => {
        expect(usableFields(undefined)).toEqual([]);
        expect(usableFields({})).toEqual([]);
    });
});

describe('checkAnswers', () => {
    const fields = usableFields([
        { id: 'email', type: 'email', required: true },
        { id: 'note', type: 'textarea' },
        { id: 'agree', type: 'checkbox', required: true },
    ]);

    it('flags a missing required answer and a malformed email', () => {
        expect(checkAnswers(fields, emptyAnswers(fields), MESSAGES)).toEqual({ email: 'required', agree: 'required' });
        expect(checkAnswers(fields, { email: 'x', note: '', agree: true }, MESSAGES)).toEqual({ email: 'email' });
    });

    it('passes a complete form', () => {
        expect(checkAnswers(fields, { email: 'a@example.test', note: '', agree: true }, MESSAGES)).toEqual({});
    });
});

describe('buildPayload', () => {
    it('sends only the declared fields, trimmed, with the envelope', () => {
        const fields = usableFields([{ id: 'name', type: 'text' }, { id: 'agree', type: 'checkbox' }]);
        const payload = buildPayload(
            fields,
            { name: '  Ada  ', agree: true, extra: 'not declared' } as never,
            { token: 'tok', issuedAt: 5 },
            { nonce: 'n', honeypot: '', consent: true },
        );
        expect(payload).toEqual({
            token: 'tok', issuedAt: 5, nonce: 'n', ref_code_2: '', consent: true,
            answers: { name: 'Ada', agree: true },
        });
    });

    it('leaves consent out when the form does not ask for it', () => {
        const payload = buildPayload([], {}, { token: 'c', issuedAt: 1 }, { nonce: 'n', honeypot: '', consent: undefined });
        expect('consent' in payload).toBe(false);
    });
});

describe('fieldErrorsFromResponse', () => {
    it('reads the per-field messages of a 400', () => {
        expect(fieldErrorsFromResponse({ details: { fields: [{ field: 'email', message: 'bad' }, { nope: 1 }] } })).toEqual({ email: 'bad' });
        expect(fieldErrorsFromResponse(null)).toEqual({});
    });
});

describe('pageLocale', () => {
    const known = new Set(['nl', 'de']);
    it('takes the locale prefix of the path, else the document language', () => {
        expect(pageLocale('/nl/pricing', 'en', known)).toBe('nl');
        expect(pageLocale('/pricing', 'nl-NL', known)).toBe('nl');
        expect(pageLocale('/it', 'en', known)).toBe('en');
        expect(pageLocale('/', '', known)).toBeUndefined();
    });
});

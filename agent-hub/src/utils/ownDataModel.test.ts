// @vitest-environment node
import { describe, it, expect } from 'vitest';

import type { CustomDataType } from './ownDataModel';
import {
    CUSTOM_TYPE_ID_RE, RESERVED_TOKEN_KEYS, builtInOnly, configFingerprint, customOnly, emptyType,
    isCustomTypeId, newTypeId, resolveType, statusFor, suggestTokenKey, switchesFor, toDraft,
    toggleId, tokenKeyFromName, tokenKeyProblem, verdictFor,
} from './ownDataModel';

/**
 * The rules behind "Your own data". The server is the authority on each of
 * them; what is pinned here is that the client mirror agrees with the pinned
 * contract, so an admin hears about a problem while typing rather than after
 * Save.
 */

const type = (over: Partial<CustomDataType> = {}): CustomDataType => ({
    ...emptyType('words'), name: 'Codes', tokenKey: 'code', ...over,
});

describe('ids', () => {
    it('makes contract-shaped ids from the browser CSPRNG, and never the same one twice', () => {
        const ids = new Set(Array.from({ length: 50 }, () => newTypeId()));
        expect(ids.size).toBe(50);
        for (const id of ids) expect(id).toMatch(CUSTOM_TYPE_ID_RE);
    });

    it('tells an own-type id from a built-in category id', () => {
        expect(isCustomTypeId('cdt_0123456789')).toBe(true);
        expect(isCustomTypeId('Email')).toBe(false);
        expect(isCustomTypeId('cdt_012345678')).toBe(false);
        expect(isCustomTypeId('cdt_0123456789A')).toBe(false);
        expect(builtInOnly(['Email', 'cdt_0123456789'])).toEqual(['Email']);
        expect(customOnly(['Email', 'cdt_0123456789'])).toEqual(['cdt_0123456789']);
    });
});

describe('placeholder keys', () => {
    it('reads like one value, not a list', () => {
        expect(tokenKeyFromName('Project code names')).toBe('project_code');
        expect(tokenKeyFromName('Customer numbers')).toBe('customer_number');
        expect(tokenKeyFromName('Polisnummer')).toBe('polisnummer');
        expect(tokenKeyFromName('Projectnamen')).toBe('projectnamen');
        expect(tokenKeyFromName('Crème brûlée recipes')).toBe('creme_brulee_recipe');
        expect(tokenKeyFromName('123 !!')).toBe('');
    });

    it('refuses every reserved key, with or without separators', () => {
        for (const key of ['email', 'person', 'phone_number', 'phonenumber', 'data', 'pii', 'custom', 'customterm', 'iban', 'name']) {
            expect(tokenKeyProblem(key, [])).toBe('reserved');
        }
        expect(RESERVED_TOKEN_KEYS.has('nationalidentificationnumber')).toBe(true);
    });

    it('refuses a malformed key', () => {
        for (const key of ['', '1code', 'code_', 'Code', 'code-x', 'a'.repeat(33)]) {
            expect(tokenKeyProblem(key, [])).toBe('format');
        }
        expect(tokenKeyProblem('a', [])).toBeNull();
    });

    it('refuses a key another type has, compared without separators', () => {
        const other = type({ id: 'cdt_1111111111', tokenKey: 'project_code' });
        expect(tokenKeyProblem('projectcode', [other])).toBe('taken');
        expect(tokenKeyProblem('project_code', [other], other)).toBeNull();
    });

    it('lets a migrated legacy type keep customterm, and only that type', () => {
        const legacy = type({ id: 'cdt_2222222222', tokenKey: 'customterm', legacy: true, origin: 'migrated' });
        expect(tokenKeyProblem('customterm', [legacy], legacy)).toBeNull();
        expect(tokenKeyProblem('customterm', [legacy], type())).toBe('reserved');
    });

    it('suggests a free key, never a reserved or taken one', () => {
        expect(suggestTokenKey('Email', [])).not.toBe('email');
        expect(tokenKeyProblem(suggestTokenKey('Email', []), [])).toBeNull();
        const taken = [type({ id: 'cdt_3333333333', tokenKey: 'project_code' })];
        const key = suggestTokenKey('Project code names', taken);
        expect(key).not.toBe('project_code');
        expect(tokenKeyProblem(key, taken)).toBeNull();
        expect(suggestTokenKey('', [])).toBe('own_data');
    });
});

describe('drafts and what is sent', () => {
    it('keeps exactly one method block, and never echoes a server verdict back', () => {
        const draft = toDraft({ ...type({ method: 'pattern' }), pattern: { source: 'KL-\\d{5}', caseSensitive: false, error: 'old' }, status: 'invalid' });
        const out = resolveType(draft);
        expect(out.pattern).toEqual({ source: 'KL-\\d{5}', caseSensitive: false });
        expect(out.words).toBeUndefined();
        expect(out.ai).toBeUndefined();
        expect(out.status).toBeUndefined();
    });

    it('trims, and fills the AI label from the name until tuning picks one', () => {
        const out = resolveType(type({ method: 'ai', name: '  Project code names ', ai: { prompt: '', floor: 0.4 } }));
        expect(out.name).toBe('Project code names');
        expect(out.ai).toEqual({ prompt: 'project code names', floor: 0.4 });
    });

    it('drops empty words', () => {
        const out = resolveType(type({ words: { values: [' A ', '', '  '], caseSensitive: true, wholeWord: false } }));
        expect(out.words).toEqual({ values: ['A'], caseSensitive: true, wholeWord: false });
    });

    it('treats a rename as no reason to retest', () => {
        const a = type();
        expect(configFingerprint({ ...a, name: 'Renamed', description: 'new' })).toBe(configFingerprint(a));
        expect(configFingerprint({ ...a, words: { ...a.words!, wholeWord: false } })).not.toBe(configFingerprint(a));
    });
});

describe('statusFor', () => {
    it('puts a broken pattern first, with the reason', () => {
        const s = statusFor(type({ method: 'pattern', pattern: { source: '(', caseSensitive: false, error: 'unterminated group' }, quality: { found: 1, total: 1, falseAlarms: 0, sentences: 1 } }), { licensed: true });
        expect(s).toEqual({ kind: 'invalid', reason: 'unterminated group' });
    });

    it('pauses every non-legacy type on a plan without the feature', () => {
        expect(statusFor(type(), { licensed: false }).kind).toBe('paused');
        expect(statusFor(type({ legacy: true, origin: 'migrated' }), { licensed: false }).kind).toBe('untested');
    });

    it('tells untested, stale and tested apart', () => {
        expect(statusFor(type(), { licensed: true }).kind).toBe('untested');
        const q = { found: 19, total: 20, falseAlarms: 1, sentences: 24 };
        expect(statusFor(type({ quality: { ...q, stale: true } }), { licensed: true }).kind).toBe('stale');
        expect(statusFor(type({ quality: q }), { licensed: true })).toEqual({ kind: 'tested', found: 19, total: 20, falseAlarms: 1 });
    });
});

describe('verdictFor', () => {
    const v = (found: number, total: number, falseAlarms: number, sentences = 20) => verdictFor({ found, total, falseAlarms, sentences });
    it('has nothing to say without gold', () => expect(v(0, 0, 3)).toBe('no_gold'));
    it('is perfect only when all is found and nothing else', () => {
        expect(v(20, 20, 0)).toBe('perfect');
        expect(v(20, 20, 1)).toBe('good');
    });
    it('is good at 90% found with at most one false alarm, or 5% of a big set', () => {
        expect(v(18, 20, 1)).toBe('good');
        expect(v(18, 20, 2)).toBe('too_much');
        expect(v(36, 40, 2, 40)).toBe('good');
    });
    it('misses below 90%', () => expect(v(17, 20, 0)).toBe('misses'));
});

describe('switches', () => {
    const lists = {
        piiCategories: ['Email', 'cdt_0123456789'],
        toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['cdt_0123456789'] } },
    };
    it('reads a type\'s three switches from the shield lists', () => {
        expect(switchesFor(lists, 'cdt_0123456789')).toEqual({ detect: true, external: false, internal: true });
    });
    it('adds and removes an id without disturbing the rest', () => {
        expect(toggleId(['Email'], 'cdt_0123456789', true)).toEqual(['Email', 'cdt_0123456789']);
        expect(toggleId(['Email', 'cdt_0123456789'], 'cdt_0123456789', true)).toEqual(['Email', 'cdt_0123456789']);
        expect(toggleId(['Email', 'cdt_0123456789'], 'cdt_0123456789', false)).toEqual(['Email']);
    });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatScreenHash, parseScreenHash, previewRoleFor } from './screenRoute';

describe('screen route fragment', () => {
    it('round-trips a screen and its text params', () => {
        const hash = formatScreenHash('scr_detail1', { recordId: 'rec 42/a&b', page: 2, open: true });
        expect(hash).toBe('#/s/scr_detail1?p.recordId=rec+42%2Fa%26b&p.page=2&p.open=true');
        expect(parseScreenHash(hash)).toEqual({ screenId: 'scr_detail1', params: { recordId: 'rec 42/a&b', page: '2', open: 'true' } });
    });

    it('leaves out params a URL cannot carry as text', () => {
        expect(formatScreenHash('scr_a', { rec: { id: 1 }, list: [1], none: null, nan: Number.NaN, gone: undefined }))
            .toBe('#/s/scr_a');
    });

    it('is not ours unless it starts with #/s/', () => {
        expect(parseScreenHash('')).toBeNull();
        expect(parseScreenHash('#top')).toBeNull();
        expect(parseScreenHash('#/s/')).toBeNull();
        expect(parseScreenHash('#/x/scr_a')).toBeNull();
    });

    it('ignores keys without the p. prefix and keys that would reach the prototype', () => {
        const route = parseScreenHash('#/s/scr_a?x=1&p.=2&p.__proto__=3&p.constructor=4&p.ok=5');
        expect(route).toEqual({ screenId: 'scr_a', params: { ok: '5' } });
        expect(Object.getPrototypeOf(route?.params)).toBe(Object.prototype);
    });

    it('refuses a screen id that is not valid percent-encoding', () => {
        expect(parseScreenHash('#/s/%E0%A4%A')).toBeNull();
    });
});

describe('previewRoleFor', () => {
    it('owner passes every gate, a member is their role, no role fails closed', () => {
        expect(previewRoleFor({ isOwner: true, roleKey: 'member' })).toBe('owner');
        expect(previewRoleFor({ isOwner: false, roleKey: 'member' })).toBe('member');
        expect(previewRoleFor({ isOwner: false, roleKey: null })).toBe('__no_role__');
        expect(previewRoleFor(null)).toBe('__no_role__');
    });
});

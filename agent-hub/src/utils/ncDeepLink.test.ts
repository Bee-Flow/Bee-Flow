import { describe, expect, it, vi } from 'vitest';
import { applyNcDeepLink, parseNcPath } from './ncDeepLink';

describe('parseNcPath', () => {
    it('accepts a relative in-app path', () => {
        expect(parseNcPath('?ncPath=%2Fapp%2Fprojects%2Fp_1')).toBe('/app/projects/p_1');
        expect(parseNcPath('?ncPath=%2Fapp%2Fprojects%2Fp1%3Fview%3Dx%26a%3D1')).toBe('/app/projects/p1?view=x&a=1');
    });
    it.each([
        '?ncPath=https%3A%2F%2Fevil.example%2Fapp%2Fx',
        '?ncPath=%2F%2Fevil.example',
        '?ncPath=%2Fapp%2F..%2Fadmin',
        '?ncPath=%2Fapp%2F%2Fevil',
        '?ncPath=%2Fother',
        '?ncPath=javascript%3Aalert(1)',
        '',
    ])('refuses %s', (q) => {
        expect(parseNcPath(q)).toBeNull();
    });
});

describe('applyNcDeepLink', () => {
    it('replaces the URL once with the validated path', () => {
        const replaceState = vi.fn();
        const win = { location: { search: '?ncPath=%2Fapp%2Fprojects%2Fp1' }, history: { replaceState } } as unknown as Window;
        expect(applyNcDeepLink(win)).toBe('/app/projects/p1');
        expect(replaceState).toHaveBeenCalledWith({}, '', '/app/projects/p1');
    });
    it('leaves the URL alone without a valid param', () => {
        const replaceState = vi.fn();
        const win = { location: { search: '?ncPath=%2F%2Fx' }, history: { replaceState } } as unknown as Window;
        expect(applyNcDeepLink(win)).toBeNull();
        expect(replaceState).not.toHaveBeenCalled();
    });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearViewPrefs, readViewPrefs, resolveView, writeViewPrefs } from './gridViewPrefs';

/**
 * These are READING preferences, so the bar is different from app state: a
 * broken or hostile stored value must never be able to change what the table
 * shows, and storage being unavailable must never be able to break it at all.
 */
describe('gridViewPrefs', () => {
    beforeEach(() => { localStorage.clear(); });

    it('round-trips a viewer override for one grid', () => {
        writeViewPrefs('cmp_a', { density: 'compact', clamp: '2' });
        expect(readViewPrefs('cmp_a')).toEqual({ density: 'compact', clamp: '2' });
    });

    it('scopes overrides per grid — two tables on one screen are two jobs', () => {
        writeViewPrefs('cmp_a', { density: 'compact' });
        expect(readViewPrefs('cmp_b')).toEqual({});
    });

    it('drops values that are not on the menu', () => {
        // Hand-edited storage, or a preference written by a newer build.
        localStorage.setItem('bf.gridview.cmp_a', JSON.stringify({ density: 'enormous', look: 'striped' }));
        expect(readViewPrefs('cmp_a')).toEqual({ look: 'striped' });
    });

    it('survives storage that is corrupt, empty or missing', () => {
        localStorage.setItem('bf.gridview.cmp_a', 'not json');
        expect(readViewPrefs('cmp_a')).toEqual({});
        localStorage.setItem('bf.gridview.cmp_b', 'null');
        expect(readViewPrefs('cmp_b')).toEqual({});
        expect(readViewPrefs('cmp_never_written')).toEqual({});
        expect(readViewPrefs(undefined)).toEqual({});
    });

    it('survives storage that throws — private mode must not break a table', () => {
        const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
        expect(() => readViewPrefs('cmp_a')).not.toThrow();
        expect(readViewPrefs('cmp_a')).toEqual({});
        spy.mockRestore();

        const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
        expect(() => writeViewPrefs('cmp_a', { density: 'compact' })).not.toThrow();
        setSpy.mockRestore();
    });

    it('clearing falls back to the author defaults', () => {
        writeViewPrefs('cmp_a', { density: 'spacious' });
        clearViewPrefs('cmp_a');
        expect(readViewPrefs('cmp_a')).toEqual({});
        expect(localStorage.getItem('bf.gridview.cmp_a')).toBeNull();
    });

    describe('resolveView', () => {
        it('uses the author props when the viewer has said nothing', () => {
            expect(resolveView({ density: 'compact', look: 'striped', clamp: '2' }, {}))
                .toEqual({ density: 'compact', look: 'striped', clamp: '2' });
        });

        it('lets the viewer override one knob without disturbing the others', () => {
            expect(resolveView({ density: 'compact', look: 'striped', clamp: '2' }, { clamp: 'off' }))
                .toEqual({ density: 'compact', look: 'striped', clamp: 'off' });
        });

        it('falls back for an author value this build does not know', () => {
            expect(resolveView({ density: 'huge', look: 'neon', clamp: '9' }, {}))
                .toEqual({ density: 'comfortable', look: 'default', clamp: 'off' });
        });

        it('defaults clamp to off — hiding text is opt-in, never a surprise', () => {
            expect(resolveView({}, {}).clamp).toBe('off');
        });
    });
});

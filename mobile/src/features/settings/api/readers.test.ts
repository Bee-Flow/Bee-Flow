import { readCatalogue, readLocales, readReleaseNotes } from './readers';

describe('readLocales', () => {
    it('reads the workspace locales and their org default', () => {
        expect(readLocales([{ code: 'nl', name: 'Nederlands', isOrgDefault: true }])).toEqual([
            { code: 'nl', name: 'Nederlands', isOrgDefault: true, enabled: undefined },
        ]);
        expect(readLocales(null)).toEqual([]);
    });
});

describe('readCatalogue', () => {
    it('keeps string values only', () => {
        expect(readCatalogue({ 'common.save': 'Opslaan', broken: 3 })).toEqual({ 'common.save': 'Opslaan' });
    });

    it('is null, not empty, when there is no catalogue — so the cache is not overwritten', () => {
        expect(readCatalogue(null)).toBeNull();
        expect(readCatalogue(['x'])).toBeNull();
    });
});

describe('readReleaseNotes', () => {
    it('reads the entries out of their envelope', () => {
        const [note] = readReleaseNotes({
            entries: [{ id: 'r1', title: 'Faster', items: ['a', 1], publishedAt: '2026-03-01' }],
        });
        expect(note).toEqual({
            id: 'r1',
            version: null,
            title: 'Faster',
            lead: '',
            items: ['a'],
            publishedAt: '2026-03-01',
        });
        expect(readReleaseNotes({})).toEqual([]);
    });
});

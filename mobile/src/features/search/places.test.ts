/**
 * The magnifier finds screens.
 *
 * This app has 37 destinations and, before this group existed, the only way to
 * reach most of them was to open More and scroll — roughly 1400dp of it. The
 * search field sitting in ~45 headers would happily find the text inside a
 * document but could not answer "where is Integrations". These tests pin the
 * behaviour that closes that, including the two ways it could quietly go wrong:
 * showing someone a screen they are not allowed to open, and hiding the rows
 * the sitemap deliberately marks `hidden`.
 */

import { buildResults, EMPTY_CORPUS, EMPTY_MATCHES, type SearchAccess } from './api';
import { setCatalogue, _reset } from '../../i18n';
import { DESTINATIONS } from '../settings/sitemap';

const ADMIN: SearchAccess = { permissions: null, isAdmin: true };
const NOBODY: SearchAccess = { permissions: [], isAdmin: false };

function places(term: string, access: SearchAccess = ADMIN) {
    const group = buildResults(term, EMPTY_CORPUS, EMPTY_MATCHES, access).groups.find(
        (g) => g.key === 'places',
    );
    return group?.hits ?? [];
}

describe('the places search group', () => {
    it('finds a screen by its label', () => {
        const hits = places('integrations');
        expect(hits.length).toBeGreaterThan(0);
        const first = hits[0];
        expect(first?.title.toLowerCase()).toContain('integration');
        expect(first?.group).toBe('places');
    });

    it('ranks screens above content', () => {
        // Someone typing a destination's name is asking to GO somewhere. The
        // group order is what puts the answer at the top of the list.
        const keys = buildResults('integrations', EMPTY_CORPUS, EMPTY_MATCHES, ADMIN).groups.map(
            (g) => g.key,
        );
        expect(keys[0]).toBe('places');
    });

    it('says nothing when the query is empty', () => {
        // Otherwise opening search would render all 37 rows before a character
        // is typed — the More tab again, in the one place meant to escape it.
        expect(places('')).toEqual([]);
        expect(places('   ')).toEqual([]);
    });

    it('never offers a screen the person cannot open', () => {
        // A row that 403s is worse than no row.
        const gated = DESTINATIONS.filter((d) => d.requires);
        expect(gated.length).toBeGreaterThan(0);
        for (const d of gated) {
            expect(places(d.label, NOBODY).some((h) => h.title === d.label)).toBe(false);
        }
    });

    it('finds rows the directory deliberately does not render', () => {
        // sitemap.ts states it in as many words: `hidden` means "not rendered,
        // but STILL SEARCHABLE". Those are precisely the rows nobody can reach
        // by browsing, so excluding them here would defeat the whole group.
        const hidden = DESTINATIONS.find((d) => d.weight === 'hidden');
        expect(hidden).toBeDefined();
        expect(places(hidden!.label).some((h) => h.title === hidden!.label)).toBe(true);
    });

    it('carries a real href on every hit, so no tap is dead', () => {
        for (const hit of places('a')) {
            expect(typeof hit.href).toBe('string');
            expect(hit.href).toBeTruthy();
        }
    });

    it('marks a destination that leaves the app', () => {
        const external = DESTINATIONS.find((d) => d.external);
        if (!external) return;
        const hit = places(external.label).find((h) => h.title === external.label);
        expect(hit?.meta).toBe('Opens in browser');
    });
});

describe('the places group in Dutch', () => {
    afterEach(() => {
        _reset();
    });

    it('finds a screen by its Dutch name', () => {
        // The whole point of the group. This product's primary users work in
        // Dutch; a finder that only answers English is a finder they cannot use,
        // and the depth complaint would have survived the fix that was supposed
        // to end it.
        setCatalogue('nl', { 'settings.appearance': 'Weergave' });
        const hits = places('weergave');
        expect(hits.some((h) => h.title === 'Appearance')).toBe(true);
    });

    it('still finds it by its English name', () => {
        // Everybody says "dashboard". A Dutch user who learned the English
        // product noun must not be punished for it — both haystacks, always.
        setCatalogue('nl', { 'settings.appearance': 'Weergave' });
        expect(places('appearance').some((h) => h.title === 'Appearance')).toBe(true);
    });

    it('renders the row in English, and matches in both', () => {
        // The label shown is still the destination's own, because converting
        // the RENDERED sitemap is a separate change from making it searchable.
        setCatalogue('nl', { 'settings.appearance': 'Weergave' });
        const hit = places('weergave').find((h) => h.title === 'Appearance');
        expect(hit).toBeDefined();
    });
});

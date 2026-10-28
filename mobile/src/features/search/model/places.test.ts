/**
 * The magnifier finds screens.
 *
 * This app has some forty destinations and, before this group existed, the
 * only way to reach most of them was to open the old More tab and scroll —
 * roughly 1400dp of it. The search field sitting in ~45 headers would happily
 * find the text inside a document but could not answer "where is
 * Integrations". These tests pin the behaviour that closes that, including the
 * two ways it could quietly go wrong: showing someone a screen they are not
 * allowed to open, and hiding the rows no menu lists.
 */

import { buildAccessSnapshot } from '@/core/access';
import { setCatalogue, _reset } from '@/core/i18n';
import { DESTINATIONS } from '@/features/sitemap';

import { buildResults, EMPTY_CORPUS, EMPTY_MATCHES, type SearchAccess } from './results';

const ADMIN: SearchAccess = buildAccessSnapshot({
    user: { id: 'op', displayName: 'Operator', isAdmin: true, role: 'admin', provider: 'local' },
    permissions: { permissions: [], groups: [], organizations: [], allowedAgentTypes: [] },
});
const NOBODY: SearchAccess = buildAccessSnapshot({
    user: { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local' },
    permissions: { permissions: [], groups: [], organizations: [], allowedAgentTypes: [] },
});

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
        const gated = DESTINATIONS.filter((d) => d.gate);
        expect(gated.length).toBeGreaterThan(0);
        for (const d of gated) {
            expect(places(d.label, NOBODY).some((h) => h.title === d.label)).toBe(false);
        }
    });

    it('finds rows no menu lists', () => {
        // The Settings children sit one level down and the drawer does not
        // list them. Those are precisely the rows nobody can reach by
        // browsing, so excluding them here would defeat the whole group.
        const nested = DESTINATIONS.find((d) => d.href === '/settings/security');
        expect(nested).toBeDefined();
        expect(places(nested!.label).some((h) => h.title === nested!.label)).toBe(true);
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
        expect(hits.some((h) => h.title === 'Weergave')).toBe(true);
    });

    it('still finds it by its English name', () => {
        // Everybody says "dashboard". A Dutch user who learned the English
        // product noun must not be punished for it — both haystacks, always.
        setCatalogue('nl', { 'settings.appearance': 'Weergave' });
        expect(places('appearance').some((h) => h.title === 'Weergave')).toBe(true);
    });

    it('shows the row under its Dutch label, as the sitemap does', () => {
        // What is shown is what is matched: a Dutch reader who typed
        // "weergave" must not be handed a row that says "Appearance".
        setCatalogue('nl', { 'settings.appearance': 'Weergave' });
        const hit = places('weergave').find((h) => h.href === '/settings/appearance');
        expect(hit?.title).toBe('Weergave');
    });

    it('shows the hint in Dutch where the web has the sentence', () => {
        const memory = DESTINATIONS.find((d) => d.id === 'memory');
        expect(memory?.hintKey).toBeTruthy();
        setCatalogue('nl', {
            'settings.memory': 'Geheugen',
            'settings.memory_desc': 'Opgeslagen feiten over jou en je projecten',
        });
        const hit = places('geheugen').find((h) => h.href === '/memory');
        expect(hit?.title).toBe('Geheugen');
        expect(hit?.subtitle).toBe('Opgeslagen feiten over jou en je projecten');
    });

    it('keeps the English hint where the catalogue has no entry for its key', () => {
        // Every destination carries a hint key since the sitemap conversion; a
        // catalogue that translates only the label leaves the hint in English.
        const plain = DESTINATIONS.find((d) => d.i18nKey && d.hintKey && !d.external && !d.gate);
        expect(plain).toBeDefined();
        setCatalogue('nl', { [plain!.i18nKey as string]: 'Vertaald' });
        const hit = places('vertaald').find((h) => h.href === plain!.href);
        expect(hit?.title).toBe('Vertaald');
        expect(hit?.subtitle).toBe(plain!.hint);
    });

    it('falls back to the destination’s own English with no catalogue', () => {
        const memory = DESTINATIONS.find((d) => d.id === 'memory');
        const hit = places('memory').find((h) => h.href === '/memory');
        expect(hit?.title).toBe(memory?.label);
        expect(hit?.subtitle).toBe(memory?.hint);
    });
});

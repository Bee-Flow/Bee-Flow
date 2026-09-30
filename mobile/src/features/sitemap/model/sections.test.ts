import { buildAccessSnapshot } from '@/core/access';
import type { User } from '@/core/auth/types';

import { alphabetSections, translatedLabel, visibleDestinations } from './sections';
import { DESTINATIONS } from '../nav/destinations';

const person = (over: Partial<User>, permissions: string[]) =>
    buildAccessSnapshot({
        user: { id: 'u1', displayName: 'Ada', isAdmin: false, role: 'user', provider: 'local', ...over },
        permissions: { permissions, groups: [], organizations: [], allowedAgentTypes: [] },
    });

const member = person({ orgRole: 'member' }, ['use_notebooks']);
const orgAdmin = person({ orgRole: 'org_admin' }, ['org_admin', 'admin_security', 'manage_users']);
const operator = person({ isAdmin: true, role: 'admin' }, []);

describe('visibleDestinations', () => {
    it('offers the organisation settings to its administrators, not to a member', () => {
        const has = (access: typeof member) => visibleDestinations(access, '').some((d) => d.id === 'org-shield');
        expect(has(operator)).toBe(true);
        expect(has(orgAdmin)).toBe(true);
        expect(has(member)).toBe(false);
    });

    it('narrows to the search', () => {
        const ids = visibleDestinations(operator, 'bot').map((d) => d.id);
        expect(ids).toContain('agents');
        expect(ids).not.toContain('settings');
    });

    it('finds a row by its hint in the reader’s language', () => {
        const t = (key: string, fallback: string) =>
            key === 'settings.memory_desc' ? 'Opgeslagen feiten over jou, je projecten en voorkeuren' : fallback;
        expect(visibleDestinations(member, 'feiten', t).map((d) => d.id)).toContain('memory');
        expect(visibleDestinations(member, 'feiten').map((d) => d.id)).not.toContain('memory');
    });

    it('still finds the retired tabs by the words people used for them', () => {
        expect(visibleDestinations(member, 'transcribe').map((d) => d.id)).toContain('record');
        expect(visibleDestinations(member, 'library').map((d) => d.id)).toContain('library');
    });
});

describe('alphabetSections', () => {
    it('includes every row once, sorted, under its first letter', () => {
        const sections = alphabetSections(DESTINATIONS);
        const rows = sections.flatMap((s) => s.data);
        expect(rows).toHaveLength(DESTINATIONS.length);
        for (const section of sections) {
            for (const d of section.data) expect(d.label.charAt(0).toUpperCase()).toBe(section.title);
        }
        const letters = sections.map((s) => s.title);
        expect(letters).toEqual([...letters].sort((a, b) => a.localeCompare(b)));
    });

    it('sorts and letters by the label the reader sees, not the English one', () => {
        // The bug: rows showed "Instellingen" and "Weergave" but were filed
        // under S and A, in English order.
        const dutch: Record<string, string> = { 'sidebar.settings': 'Instellingen', 'settings.appearance': 'Weergave' };
        const t = (key: string, fallback: string) => dutch[key] ?? fallback;
        const sections = alphabetSections(DESTINATIONS, translatedLabel(t), 'nl');
        const letterOf = (id: string) => sections.find((s) => s.data.some((d) => d.id === id))?.title;
        expect(letterOf('settings')).toBe('I');
        expect(letterOf('appearance')).toBe('W');
        for (const section of sections) {
            const labels = section.data.map(translatedLabel(t));
            expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'nl')));
        }
    });

    it('files an accented first letter under its plain letter', () => {
        const rows = [DESTINATIONS[0]!, DESTINATIONS[1]!];
        const accented = (d: { id: string; label: string }) => (d.id === rows[0]!.id ? 'Één overzicht' : 'Ezels');
        const sections = alphabetSections(rows, accented, 'nl');
        expect(sections.map((s) => s.title)).toEqual(['E']);
        expect(sections[0]!.data.map(accented)).toEqual(['Één overzicht', 'Ezels']);
    });

    it('drops nothing and invents nothing on an empty list', () => {
        expect(alphabetSections([])).toEqual([]);
    });

    // The server accepts language codes Intl does not ('pt_br', which an
    // admin can add): the Collator and toLocaleUpperCase threw a RangeError
    // out of the render, and the whole A–Z screen crashed for that language.
    it('still draws the map in a language whose code Intl does not accept', () => {
        for (const code of ['pt_br', 'zh_hans', 'de-12']) {
            expect(() => alphabetSections(DESTINATIONS, undefined, code)).not.toThrow();
            expect(alphabetSections(DESTINATIONS, undefined, code).flatMap((s) => s.data)).toHaveLength(DESTINATIONS.length);
        }
    });
});

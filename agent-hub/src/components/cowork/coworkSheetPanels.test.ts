// The pages of Cowork (./coworkSheetPanels.ts): each has one address under /app/cowork, the address names the page
// again, and every kind has a component and a name.
import { describe, expect, it } from 'vitest';
import { COWORK_SHEET_PANELS, pageName, pageOfSegment, pageSegment, samePage, type CoworkSheetKind, type CoworkSheetPanel } from './coworkSheetPanels';

const PAGES: [CoworkSheetPanel, string][] = [
    [{ kind: 'task', id: 'w1' }, 'w1'],
    [{ kind: 'shared', id: 's1' }, 'shared-s1'],
    [{ kind: 'settings' }, 'preferences'],
    [{ kind: 'teamwork' }, 'teamwork'],
    [{ kind: 'templates' }, 'templates'],
    [{ kind: 'org' }, 'admin-rules'],
];

describe('the addresses of the Cowork pages', () => {
    it.each(PAGES)('%o is at /app/cowork/%s, and that address names it again', (page, segment) => {
        expect(pageSegment(page)).toBe(segment);
        expect(pageOfSegment(segment)).toEqual(page);
    });

    it('no segment is the home; any other segment is a task by its id', () => {
        expect(pageOfSegment(null)).toBeNull();
        expect(pageOfSegment('')).toBeNull();
        expect(pageOfSegment('0f8fad5b-d9cb-469f-a165-70867728950e')).toEqual({ kind: 'task', id: '0f8fad5b-d9cb-469f-a165-70867728950e' });
        expect(pageOfSegment('shared-')).toEqual({ kind: 'task', id: 'shared-' });
    });

    it('a task opened at its steps is the same page as that task; another task is not', () => {
        expect(samePage({ kind: 'task', id: 'w1', focus: 'steps' }, { kind: 'task', id: 'w1' })).toBe(true);
        expect(samePage({ kind: 'task', id: 'w1' }, { kind: 'task', id: 'w2' })).toBe(false);
        expect(samePage({ kind: 'settings' }, null)).toBe(false);
        expect(samePage(null, null)).toBe(true);
    });

    it('every kind has a component and a name; the names are the ones a user reads', () => {
        const name = (kind: CoworkSheetKind) => pageName(kind, (_key, fallback) => (typeof fallback === 'string' ? fallback : ''));
        expect(Object.keys(COWORK_SHEET_PANELS).sort()).toEqual(['org', 'settings', 'shared', 'task', 'teamwork', 'templates']);
        expect(name('settings')).toBe('Cowork preferences');
        expect(name('org')).toBe('Admin rules');
        expect(name('teamwork')).toBe('Teamwork');
    });
});

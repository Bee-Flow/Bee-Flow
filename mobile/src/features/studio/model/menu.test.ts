/**
 * The Studio destinations as groups: Workspace first, then — only for a
 * builder — the sections under their category headings, empty ones skipped.
 */

import { studioMenuGroups } from './menu';
import { STUDIO_SECTIONS } from './registry';
import { groupSections } from './resolve';
import type { HubLink } from './types';

const COWORK: HubLink = { id: 'cowork', icon: 'Handshake', label: 'Cowork', description: 'Schedules', href: '/cowork' };
const NOTEBOOKS: HubLink = { id: 'notebooks', icon: 'FileText', label: 'Notebooks', description: 'Notes', href: '/notebooks' };
const GROUPS = groupSections(STUDIO_SECTIONS.filter((s) => !s.hiddenFromNav).map((s) => ({ ...s, locked: null })));

describe('studioMenuGroups', () => {
    it('puts the Workspace links first, then every section under its heading', () => {
        const groups = studioMenuGroups({ workspace: [COWORK, NOTEBOOKS], groups: GROUPS, builder: true });
        expect(groups[0]).toMatchObject({ id: 'workspace', labelKey: 'mobile.studio.workspace' });
        expect(groups[0]?.rows.map((r) => r.id)).toEqual(['cowork', 'notebooks']);
        expect(groups.slice(1).map((g) => g.id)).toEqual(GROUPS.map((g) => g.category.id));
        const sections = groups.slice(1).flatMap((g) => g.rows);
        expect(sections.every((r) => r.kind === 'section')).toBe(true);
        expect(sections.map((r) => r.id)).toContain('aiTasks');
    });

    it('gives someone who does not build the Workspace only', () => {
        const groups = studioMenuGroups({ workspace: [COWORK], groups: GROUPS, builder: false });
        expect(groups.map((g) => g.id)).toEqual(['workspace']);
    });

    it('draws no Workspace heading over nothing', () => {
        expect(studioMenuGroups({ workspace: [], groups: GROUPS, builder: false })).toEqual([]);
        expect(studioMenuGroups({ workspace: [], groups: GROUPS, builder: true })[0]?.id).toBe('build');
    });
});

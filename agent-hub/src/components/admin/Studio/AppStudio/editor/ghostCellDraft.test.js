import { describe, expect, it } from 'vitest';
import { projectGhostCell } from './ghostCellDraft';

const DEF = {
    screens: [
        { id: 'scr_a', sections: [{ id: 'sec_a1', children: [{ id: 'cmp_card', type: 'card', children: [] }] }, { id: 'sec_a2', children: [] }] },
        { id: 'scr_b', sections: [{ id: 'sec_b1', children: [] }] },
    ],
};

describe('projectGhostCell', () => {
    it('the last item is the card being typed; its type once closed, its label as typed, in the batch\'s section', () => {
        const draft = { name: 'app_add_components', parentId: 'sec_a1', count: 3, items: [{ kind: 'component', type: 'stat', label: 'Totaal', partial: false }, { kind: 'component', type: 'data_grid', label: 'Factu', partial: true }] };
        const g = projectGhostCell(draft, DEF, 'scr_a');
        expect(g).toMatchObject({ kind: 'component', type: 'data_grid', typeLabel: 'Data grid', label: 'Factu', partial: true, index: 2, count: 3, sectionId: 'sec_a1', caption: 'Factu' });
        expect(g.span).toBe(12);
    });

    it('no type yet → generic caption; a container parent resolves to its section; a parent on ANOTHER screen draws nothing; an unknown parent falls back to the last section', () => {
        const open = { name: 'app_add_components', parentId: 'cmp_card', count: 1, items: [{ kind: 'component', type: null, label: null, partial: true }] };
        const g = projectGhostCell(open, DEF, 'scr_a');
        expect(g.type).toBeNull();
        expect(g.caption).toBe('Adding Component…');
        expect(g.sectionId).toBe('sec_a1');
        // A section — or a container — of another screen: the camera switches
        // there next tick; the ghost must not be drawn in the wrong place first.
        expect(projectGhostCell({ ...open, parentId: 'sec_b1' }, DEF, 'scr_a')).toBeNull();
        expect(projectGhostCell({ ...open, parentId: 'cmp_card' }, DEF, 'scr_b')).toBeNull();
        // Once the canvas shows that screen, the same draft lands in its section.
        expect(projectGhostCell({ ...open, parentId: 'sec_b1' }, DEF, 'scr_b').sectionId).toBe('sec_b1');
        // Not typed yet, or an id nobody has: the active screen's last section.
        expect(projectGhostCell({ ...open, parentId: null }, DEF, 'scr_a').sectionId).toBe('sec_a2');
        expect(projectGhostCell({ ...open, parentId: 'cmp_unknown' }, DEF, 'scr_a').sectionId).toBe('sec_a2');
        const t = (key, en, params) => `⟦${key}⟧`;
        expect(projectGhostCell(open, DEF, 'scr_a', t).caption).toBe('⟦app_studio.builder.draft.typing⟧');
    });

    it('nothing for other tools, empty batches or an unknown screen', () => {
        expect(projectGhostCell({ name: 'app_add_screen', items: [{ kind: 'screen' }] }, DEF, 'scr_a')).toBeNull();
        expect(projectGhostCell({ name: 'app_add_components', items: [] }, DEF, 'scr_a')).toBeNull();
        expect(projectGhostCell({ name: 'app_add_components', items: [{ kind: 'component' }] }, DEF, 'scr_zzz')).toBeNull();
        expect(projectGhostCell(null, DEF, 'scr_a')).toBeNull();
    });
});

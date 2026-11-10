import { describe, it, expect } from 'vitest';
import { deleteSection, sectionPlace, MAX_SECTIONS_PER_SCREEN, MAX_SCREENS } from './structureOps';
import { collectIds } from './definitionOps';
import type { AppDefinition } from '../inspector/appDefinition';

function sample(): AppDefinition {
    return {
        schemaVersion: 2,
        meta: { name: 'Orders', description: '', icon: null },
        theme: { primary: '#0ea5e9' },
        homeScreenId: 'scr_home01',
        screens: [{
            id: 'scr_home01', name: 'Home', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [
                { id: 'sec_top001', style: { padding: 4 }, children: [{ id: 'cmp_btn001', type: 'button', props: { label: 'Edit' }, onClick: 'act_omod01' }] },
                { id: 'sec_bot001', style: { padding: 2 }, children: [{ id: 'cmp_modal1', type: 'modal', props: { title: 'Edit' }, children: [{ id: 'cmp_mtext1', type: 'text', props: { text: 'Hi' } }] }] },
            ],
        }],
        actions: { act_omod01: { kind: 'open_modal', modalId: 'cmp_modal1' } },
    } as unknown as AppDefinition;
}

describe('structureOps — the editor half', () => {
    it('deleteSection takes the components out the way deleting each one does (modal references included)', () => {
        const def = sample();
        const next = deleteSection(def, 'sec_bot001');
        expect(next.screens?.[0].sections?.map((s) => s.id)).toEqual(['sec_top001']);
        const ids = collectIds(next);
        expect(ids.has('cmp_modal1')).toBe(false);
        // No action or wiring may still point at the deleted dialog: that fails every later save.
        expect(JSON.stringify(next)).not.toContain('cmp_modal1');
    });

    it('deleting the only section leaves one fresh empty section', () => {
        const def = sample();
        const once = deleteSection(def, 'sec_top001');
        const twice = deleteSection(once, 'sec_bot001');
        const sections = twice.screens?.[0].sections || [];
        expect(sections).toHaveLength(1);
        expect(sections[0].children).toEqual([]);
        expect(['sec_top001', 'sec_bot001']).not.toContain(sections[0].id);
    });

    it('deleteSection and sectionPlace leave an unknown id alone', () => {
        const def = sample();
        expect(deleteSection(def, 'sec_none00')).toBe(def);
        expect(sectionPlace(def, 'sec_none00')).toBeNull();
        expect(sectionPlace(def, 'sec_bot001')).toEqual({ index: 1, count: 2, screenId: 'scr_home01' });
    });

    it('reads the server limits from the catalogue snapshot', () => {
        expect(MAX_SECTIONS_PER_SCREEN).toBe(40);
        expect(MAX_SCREENS).toBe(40);
    });
});

import { describe, it, expect } from 'vitest';
import { collectDataBindings } from './AppDataScope';
import { buildScope } from './RuntimeContext';
import { sectionHasGate, sectionLoadsData, sectionRoleAllows, sectionWidthClass } from './sectionModel';
import type { SectionModel } from './sectionModel';

const scope = (vars: Record<string, unknown> = {}) => buildScope({ vars, currentUser: null, screen: { id: 'scr_1', params: {} } });

describe('sectionModel — what the data layer may skip', () => {
    it('a section without a gate always loads', () => {
        expect(sectionHasGate({})).toBe(false);
        expect(sectionHasGate({ visibleToRoles: [] })).toBe(false);
        expect(sectionLoadsData({}, scope(), 'member')).toBe(true);
    });

    it('the role gate: closed for another role, open for the owner, the role itself and no role', () => {
        const s: SectionModel = { visibleToRoles: ['manager'] };
        expect(sectionLoadsData(s, scope(), 'member')).toBe(false);
        expect(sectionLoadsData(s, scope(), '__no_role__')).toBe(false);
        expect(sectionLoadsData(s, scope(), 'manager')).toBe(true);
        expect(sectionLoadsData(s, scope(), 'owner')).toBe(true);
        expect(sectionRoleAllows(s, null)).toBe(true);
    });

    it('a condition on the fetch scope roots decides; anything else loads', () => {
        const onVars: SectionModel = { visibleWhen: { kind: 'formula', expr: "vars.view == 'archive'" } };
        expect(sectionLoadsData(onVars, scope({ view: 'open' }), 'owner')).toBe(false);
        expect(sectionLoadsData(onVars, scope({ view: 'archive' }), 'owner')).toBe(true);
        expect(sectionLoadsData({ visibleWhen: false }, scope(), null)).toBe(false);
        expect(sectionLoadsData({ visibleWhen: true }, scope(), null)).toBe(true);
        // Reads loaded rows or an action result: the data layer cannot know, so it loads.
        expect(sectionLoadsData({ visibleWhen: { kind: 'formula', expr: 'count(records.orders) > 0' } }, scope(), null)).toBe(true);
        expect(sectionLoadsData({ visibleWhen: { kind: 'formula', expr: 'actions.act_1.ok' } }, scope(), null)).toBe(true);
        // A formula that does not parse loads too.
        expect(sectionLoadsData({ visibleWhen: { kind: 'formula', expr: 'vars.x ==' } }, scope(), null)).toBe(true);
    });

    it('width classes for the caps only', () => {
        expect(sectionWidthClass({ maxWidth: 'narrow' })).toBe(' app-section-max-narrow');
        expect(sectionWidthClass({ maxWidth: 'full' })).toBe('');
        expect(sectionWidthClass({ maxWidth: 'inherit' })).toBe('');
        expect(sectionWidthClass({})).toBe('');
    });
});

describe('collectDataBindings — the section gate', () => {
    const binding = (tableId: string) => ({ kind: 'records', tableId });
    const def = {
        homeScreenId: 'scr_1',
        screens: [{
            id: 'scr_1',
            sections: [
                { id: 'sec_a', children: [{ id: 'cmp_a', type: 'data_grid', props: { source: binding('tbl_open') } }] },
                { id: 'sec_b', visibleToRoles: ['manager'], children: [{ id: 'cmp_b', type: 'data_grid', props: { source: binding('tbl_admin') } }] },
            ],
        }],
    };
    const tables = (entries: { binding: unknown }[]) => entries.map((e) => (e.binding as { tableId: string }).tableId);

    it('without a gate every section loads, as before', () => {
        expect(tables(collectDataBindings(def, 'scr_1'))).toEqual(['tbl_open', 'tbl_admin']);
    });

    it('a section the gate refuses contributes no binding', () => {
        const gate = (s: SectionModel) => sectionLoadsData(s, scope(), 'member');
        expect(tables(collectDataBindings(def, 'scr_1', gate))).toEqual(['tbl_open']);
        const manager = (s: SectionModel) => sectionLoadsData(s, scope(), 'manager');
        expect(tables(collectDataBindings(def, 'scr_1', manager))).toEqual(['tbl_open', 'tbl_admin']);
    });
});

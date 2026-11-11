import { describe, expect, it } from 'vitest';
import type { AppDefinition } from '../../inspector/appDefinition';
import {
    MAX_PUBLIC_SCREENS, openPublicAccess, publicReach, publicTableGrants, readPublicAccess,
    setEntryScreen, setLookKnob, setTitle, toggleScreen, withPublicAccess,
} from './publicPageModel';
import type { PublicAccess } from './publicPageModel';

const screens = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `scr_s${String(i).padStart(4, '0')}`, name: `S${i}`, sections: [] }));
const DEF: AppDefinition = { homeScreenId: 'scr_s0001', screens: screens(3) };

describe('opening and closing the public page', () => {
    it('opens on the home screen alone, in the canonical shape', () => {
        expect(openPublicAccess(DEF)).toEqual({ entryScreenId: 'scr_s0001', screenIds: ['scr_s0001'], roleKey: 'public' });
    });

    it('falls back to the first screen, and opens nothing for an app without screens', () => {
        expect(openPublicAccess({ screens: screens(2) })?.entryScreenId).toBe('scr_s0000');
        expect(openPublicAccess({ screens: [] })).toBeNull();
    });

    it('closing removes the key entirely, and a no-op keeps the reference', () => {
        const open = withPublicAccess(DEF, openPublicAccess(DEF));
        expect(open.publicAccess).toBeTruthy();
        const closed = withPublicAccess(open, null);
        expect('publicAccess' in closed).toBe(false);
        expect(closed).toEqual(DEF);
        expect(withPublicAccess(DEF, null)).toBe(DEF);
        expect(withPublicAccess(open, readPublicAccess(open))).toBe(open);
    });
});

describe('editing the block', () => {
    const pa = openPublicAccess(DEF) as PublicAccess;

    it('adds and removes screens but never the entry screen', () => {
        const two = toggleScreen(pa, 'scr_s0002');
        expect(two.screenIds).toEqual(['scr_s0001', 'scr_s0002']);
        expect(toggleScreen(two, 'scr_s0002').screenIds).toEqual(['scr_s0001']);
        expect(toggleScreen(two, 'scr_s0001')).toBe(two);
    });

    it(`stops at ${MAX_PUBLIC_SCREENS} screens`, () => {
        let next = pa;
        for (const s of screens(20)) next = toggleScreen(next, s.id);
        expect(next.screenIds).toHaveLength(MAX_PUBLIC_SCREENS);
    });

    it('moves the entry only to a listed screen', () => {
        const two = toggleScreen(pa, 'scr_s0002');
        expect(setEntryScreen(two, 'scr_s0002').entryScreenId).toBe('scr_s0002');
        expect(setEntryScreen(two, 'scr_s0000')).toBe(two);
    });

    it('trims the title and drops an empty one', () => {
        expect(setTitle(pa, '  Intake  ').title).toBe('Intake');
        expect('title' in setTitle(setTitle(pa, 'x'), '   ')).toBe(false);
        expect(setTitle(pa, 'x'.repeat(300)).title).toHaveLength(200);
    });

    it('writes only the knobs that differ, and drops an empty override', () => {
        const themed = setLookKnob(pa, 'theme', 'canvas', '#ffda00');
        expect(themed.theme).toEqual({ canvas: '#ffda00' });
        const both = setLookKnob(themed, 'design', 'font', 'poppins');
        expect(Object.keys(both)).toEqual(['entryScreenId', 'screenIds', 'roleKey', 'theme', 'design']);
        const back = setLookKnob(setLookKnob(both, 'theme', 'canvas', null), 'design', 'font', null);
        expect(back).toEqual(pa);
    });
});

describe('readPublicAccess', () => {
    it('reads nothing from an absent or broken block', () => {
        expect(readPublicAccess(DEF)).toBeNull();
        expect(readPublicAccess({ ...DEF, publicAccess: { screenIds: ['scr_s0000'] } })).toBeNull();
        expect(readPublicAccess(null)).toBeNull();
    });

    it('puts the entry screen in the list when the block left it out', () => {
        expect(readPublicAccess({ ...DEF, publicAccess: { entryScreenId: 'scr_s0001', screenIds: ['scr_s0002'] } })?.screenIds)
            .toEqual(['scr_s0001', 'scr_s0002']);
    });
});

describe('what a visitor reaches', () => {
    const def: AppDefinition = {
        screens: [
            { id: 'scr_pub001', name: 'Form', sections: [{ id: 'sec_a0001', children: [
                { id: 'cmp_f0001', type: 'form', onSubmit: 'act_save01', children: [{ id: 'cmp_b0001', type: 'button', onClick: 'act_gone01' }] },
            ] }] },
            { id: 'scr_back01', name: 'Back office', sections: [{ id: 'sec_b0001', children: [{ id: 'cmp_g0001', type: 'data_grid', props: { rowActions: [{ label: 'x', actionId: 'act_del001' }] } }] }] },
        ],
        actions: {
            act_save01: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_note01' }] },
            act_note01: { kind: 'toast', message: 'ok' },
            act_del001: { kind: 'delete_record' },
        },
    };

    it('lists the listed screens, the actions wired there and what those call', () => {
        const reach = publicReach(def, { entryScreenId: 'scr_pub001', screenIds: ['scr_pub001'], roleKey: 'public' });
        expect(reach.screens).toEqual([{ id: 'scr_pub001', name: 'Form', entry: true }]);
        expect(reach.actions).toEqual(['act_save01']);
        expect(reach.calledActions).toEqual(['act_note01']);
    });

    it('names only tables that grant the public role something', () => {
        const tables = [
            { id: 't1', name: 'Requests', access: { default: 'app', roles: { public: { create: true } } } },
            { id: 't2', name: 'Customers', access: { default: 'app' } },
        ];
        expect(publicTableGrants(tables).map((g) => g.table.name)).toEqual(['Requests']);
    });
});

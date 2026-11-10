import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { AppDefinition, AppScreen, AppSection } from '../../inspector/appDefinition';
import { PUBLIC_ROLE_KEY } from '../publishAccessSummary';
import {
    MAX_PUBLIC_SCREENS, openPublicAccess, publicReach, setEntryScreen, setLookKnob, setTitle, toggleScreen,
} from './publicPageModel';
import type { PublicAccess } from './publicPageModel';

const require = createRequire(import.meta.url);
const server = require('../../../../../../../../server/appStudio/publicAccess.js');
const { canonicalizeAppDefinition } = require('../../../../../../../../server/appStudio/canonicalize.js');

/**
 * The public page tab and the server agree:
 *   - on the limits and the reserved role;
 *   - on the block: what the tab writes is what the canonicalizer keeps, byte
 *     for byte, so a save never rewrites it and undo never sees a phantom step;
 *   - on what a visitor reaches: the actions the tab names are exactly the
 *     actions the server ships to an anonymous browser.
 */

const screen = (id: string, name: string, children: NonNullable<AppSection['children']>): AppScreen => ({ id, name, sections: [{ id: `sec_${id.slice(4)}`, children }] });

const DEF: AppDefinition = {
    schemaVersion: 2,
    meta: { name: 'Intake' },
    homeScreenId: 'scr_home01',
    screens: [
        screen('scr_home01', 'Start', [
            { id: 'cmp_form01', type: 'form', props: {}, onSubmit: 'act_save01', children: [
                { id: 'cmp_btn001', type: 'button', props: { label: 'Next' }, onClick: 'act_next01' },
            ] },
        ]),
        screen('scr_step02', 'Details', [
            { id: 'cmp_grid01', type: 'data_grid', props: {
                rowActions: [{ label: 'Open', actionId: 'act_open01' }],
                columns: [{ key: 'name', label: 'Name', actionId: 'act_col001' }],
                addRowActionId: 'act_add001',
            } },
        ]),
        screen('scr_back01', 'Back office', [
            { id: 'cmp_btn002', type: 'button', props: { label: 'Delete' }, onClick: 'act_del001' },
        ]),
    ],
    actions: {
        act_save01: { kind: 'sequence', steps: [
            { kind: 'condition', if: 'true', then: [{ kind: 'call_action', actionId: 'act_mail01' }], else: [] },
        ] },
        act_mail01: { kind: 'sequence', steps: [{ kind: 'call_action', actionId: 'act_log001' }] },
        act_log001: { kind: 'toast', message: 'Saved' },
        act_next01: { kind: 'navigate', screenId: 'scr_step02' },
        act_open01: { kind: 'toast', message: 'Open' },
        act_col001: { kind: 'toast', message: 'Column' },
        act_add001: { kind: 'toast', message: 'Add' },
        act_del001: { kind: 'toast', message: 'Gone' },
    },
};

describe('public page — limits and role', () => {
    it('caps screens and names the role as the server does', () => {
        expect(MAX_PUBLIC_SCREENS).toBe(server.MAX_PUBLIC_SCREENS);
        expect(PUBLIC_ROLE_KEY).toBe(server.PUBLIC_ROLE_KEY);
    });
});

describe('public page — the block survives the canonicalizer unchanged', () => {
    const edited = (): PublicAccess => {
        let pa = openPublicAccess(DEF) as PublicAccess;
        pa = toggleScreen(pa, 'scr_step02');
        pa = setEntryScreen(pa, 'scr_step02');
        pa = setTitle(pa, 'Apply here');
        pa = setLookKnob(pa, 'theme', 'canvas', '#ffda00');
        pa = setLookKnob(pa, 'theme', 'radius', 'lg');
        pa = setLookKnob(pa, 'design', 'font', 'poppins');
        return setLookKnob(pa, 'design', 'accentEdge', 'none');
    };
    const withLogo = (logo: string) => setLookKnob(edited(), 'design', 'logoUrl', logo);

    const blocks = [
        ['a fresh block', openPublicAccess(DEF) as PublicAccess],
        ['an edited block', edited()],
        ['a page logo by URL', withLogo('https://example.com/logo.png')],
        ['an uploaded page logo', withLogo('asset:9a1b2c3d-0000-4000-8000-00000000abcd')],
    ] as const;
    for (const [name, pa] of blocks) {
        it(name, () => {
            const { def, repairs } = canonicalizeAppDefinition({ ...DEF, publicAccess: pa });
            expect(repairs.filter((r: { code: string }) => r.code.startsWith('publicAccess'))).toEqual([]);
            expect(JSON.stringify(def.publicAccess)).toBe(JSON.stringify(pa));
        });
    }
});

describe('public page — what a visitor reaches matches what the server ships', () => {
    const cases: Array<[string, string[]]> = [
        ['the entry screen alone', ['scr_home01']],
        ['two screens', ['scr_home01', 'scr_step02']],
        ['every screen', ['scr_home01', 'scr_step02', 'scr_back01']],
    ];
    for (const [name, screenIds] of cases) {
        it(name, () => {
            const pa = { entryScreenId: 'scr_home01', screenIds, roleKey: 'public' };
            const def = { ...DEF, publicAccess: pa };
            const surface = server.resolvePublicSurface(def);
            const shipped = Object.keys(server.buildPublicDefinition(def, surface).actions).sort();
            const reach = publicReach(def, pa);
            expect([...reach.actions].sort()).toEqual([...surface.actionIds].filter((id: string) => id in (DEF.actions || {})).sort());
            expect([...reach.actions, ...reach.calledActions].sort()).toEqual(shipped);
            expect(reach.screens.map((s) => s.id).sort()).toEqual([...surface.screenIds].sort());
        });
    }
});

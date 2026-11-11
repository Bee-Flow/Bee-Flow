import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { AppDefinition } from '../../inspector/appDefinition';
import { publicReach } from './publicPageModel';
import type { PublicAccess } from './publicPageModel';

const require = createRequire(import.meta.url);
const server = require('../../../../../../../../server/appStudio/publicAccess.js');
const { canonicalizeAppDefinition } = require('../../../../../../../../server/appStudio/canonicalize.js');

/**
 * A custom_block on a public screen: the public page tab names the same actions the server
 * lets an anonymous visitor run. An event counts only when it is wired AND a control of the
 * template raises it.
 */
const DEF = {
    schemaVersion: 3,
    meta: { name: 'Block' },
    homeScreenId: 'scr_open0001',
    screens: [
        { id: 'scr_open0001', name: 'Open', sections: [{ id: 'sec_open0001', children: [
            { id: 'cmp_block001', type: 'custom_block', props: { block: {
                template: '<button data-emit="pick">a</button><a data-emit="later">b</a><p data-emit="plain">c</p>',
                events: { pick: 'act_pick0001', ghost: 'act_ghost001', plain: 'act_plain001', later: null },
            } } },
        ] }] },
        { id: 'scr_back0001', name: 'Back office', sections: [{ id: 'sec_back0001', children: [
            { id: 'cmp_block002', type: 'custom_block', props: { block: { template: '<button data-emit="other">b</button>', events: { other: 'act_other001' } } } },
        ] }] },
    ],
    actions: {
        act_pick0001: { kind: 'toast', message: 'picked' },
        act_ghost001: { kind: 'toast', message: 'ghost' },
        act_plain001: { kind: 'toast', message: 'plain' },
        act_other001: { kind: 'toast', message: 'other' },
    },
    publicAccess: { entryScreenId: 'scr_open0001', screenIds: ['scr_open0001'] },
};

describe('public page: a custom block', () => {
    it('reaches the actions the server offers a visitor, and no other', () => {
        const def = canonicalizeAppDefinition(structuredClone(DEF)).def as AppDefinition;
        const surface = server.resolvePublicSurface(def);
        const reach = publicReach(def, def.publicAccess as PublicAccess);
        expect([...surface.actionIds]).toEqual(['act_pick0001']);
        expect([...reach.actions]).toEqual(['act_pick0001']);
    });
});

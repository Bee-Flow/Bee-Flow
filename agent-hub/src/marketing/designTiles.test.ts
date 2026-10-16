// @vitest-environment node
/**
 * Run: cd agent-hub && npx vitest run src/marketing/designTiles.test.ts --maxWorkers=2
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { tileVars, TILE_ENUMS, TILE_VAR_PROPS } from './designTiles';

const require = createRequire(import.meta.url);
const { DESIGN_COMPONENT_ENUMS } = require('../../../server/i18n/defaults/cmsDefaults.js');

describe('tileVars', () => {
    it('emits nothing for the identity values, an empty group or a missing one', () => {
        expect(tileVars({ tileShape: 'default', tileFill: 'default', tileSize: 'default', tileIconColor: 'default' })).toEqual({});
        expect(tileVars({})).toEqual({});
        expect(tileVars(null)).toEqual({});
    });

    it('maps a shape to a radius and the hexagon to a clip-path without a ring', () => {
        expect(tileVars({ tileShape: 'circle' })['--tile-radius']).toBe('999px');
        const hex = tileVars({ tileShape: 'hexagon' });
        expect(hex['--tile-clip']).toMatch(/^polygon\(/);
        expect(hex['--tile-border']).toBe('0 none');
    });

    it('a solid fill takes the button text colour and an explicit icon colour wins over it', () => {
        expect(tileVars({ tileFill: 'solid' })['--tile-fg']).toBe('var(--btn-primary-fg, #fff)');
        expect(tileVars({ tileFill: 'solid', tileIconColor: 'dark' })['--tile-fg']).toBe('#0B0B0C');
    });

    it('ignores unknown names, including prototype keys and CSS', () => {
        expect(tileVars({ tileShape: 'constructor', tileFill: 'toString', tileSize: 'url(x)', tileIconColor: 'red' })).toEqual({});
    });

    it('only sets properties it lists for clearing', () => {
        const all = tileVars({ tileShape: 'hexagon', tileFill: 'solid', tileSize: 'lg', tileIconColor: 'light' });
        for (const prop of Object.keys(all)) expect(TILE_VAR_PROPS).toContain(prop);
    });

    it('stays in lockstep with the server enums', () => {
        for (const [key, names] of Object.entries(TILE_ENUMS)) {
            expect(DESIGN_COMPONENT_ENUMS[key], key).toEqual(['default', ...names]);
        }
    });
});

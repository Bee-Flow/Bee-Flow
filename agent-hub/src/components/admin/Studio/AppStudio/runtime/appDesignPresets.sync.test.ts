// @vitest-environment node
/**
 * The preset gallery's data is ONE module (server/shared/appDefinition/
 * designPresets.mjs, mirrored into @shared/appDefinition by npm run gen:shared;
 * lint:shared-mirror catches a stale copy). This test checks the data against
 * the server's design spec and the house colour rule.
 */
import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';
import { APP_DESIGN_PRESETS } from './appDesignPresets';

const require = createRequire(import.meta.url);
const serverPresets = require('../../../../../../../server/appStudio/appDesignPresets');

describe('appDesignPresets client/server sync', () => {
    it('the server entry point serves the same presets', () => {
        expect(APP_DESIGN_PRESETS).toEqual(serverPresets.ALL_APP_DESIGN_PRESETS);
    });

    it('the base seven keep their place and a later preset is marked since 3', () => {
        expect(serverPresets.APP_DESIGN_PRESETS.map((p: { id: string }) => p.id)).toEqual(['classic', 'cloud', 'atlas', 'midnight', 'field', 'paper', 'mono']);
        expect(APP_DESIGN_PRESETS.slice(0, 7)).toEqual(serverPresets.APP_DESIGN_PRESETS);
        for (const p of serverPresets.EXTENSION_APP_DESIGN_PRESETS) expect(p.since).toBe(3);
        expect(new Set(APP_DESIGN_PRESETS.map((p) => p.id)).size).toBe(APP_DESIGN_PRESETS.length);
    });

    it('every preset carries a complete theme + design + navStyle', () => {
        const { DESIGN_SPEC, NAV_STYLES } = require('../../../../../../../server/appStudio/appDesignSpec');
        for (const p of APP_DESIGN_PRESETS) {
            expect(Object.keys(p.theme).sort()).toEqual(['appearance', 'density', 'fontScale', 'primary', 'radius']);
            expect(Object.keys(p.design).sort()).toEqual(Object.keys(DESIGN_SPEC).sort());
            expect(NAV_STYLES).toContain(p.navStyle);
            for (const [key, spec] of Object.entries(DESIGN_SPEC as Record<string, { type: string; values?: string[] }>)) {
                if (spec.type === 'enum') expect(spec.values).toContain(p.design[key as keyof typeof p.design]);
            }
        }
    });

    it('no purple anywhere (house rule)', () => {
        const { THEME_PRIMARY_PRESETS } = require('../../../../../../../server/core/cms/themeSpec');
        for (const p of APP_DESIGN_PRESETS) {
            expect(THEME_PRIMARY_PRESETS).toContain(p.theme.primary);
        }
    });
});

// @vitest-environment node
/**
 * Run: cd agent-hub && npx vitest run src/marketing/designRoles.test.ts --maxWorkers=2
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { roleVars, roleColor, ROLE_VAR_PROPS, LABEL_STYLE_NAMES } from './designRoles';

const require = createRequire(import.meta.url);
const { DESIGN_COMPONENT_ENUMS, BLANKABLE_COLORS } = require('../../../server/i18n/defaults/cmsDefaults.js');

describe('roleVars', () => {
    it('emits nothing while every role is blank, so the roles follow the primary colour', () => {
        expect(roleVars({ cta: '', link: '', highlight: '', tile: '' }, 'default')).toEqual({});
        expect(roleVars(undefined, undefined)).toEqual({});
    });

    it('maps each role to its own property and the cta also to the button fill', () => {
        expect(roleVars({ cta: '#112233', link: '#445566', highlight: '#778899', tile: '#aabbcc' }, undefined)).toEqual({
            '--cta-color': '#112233', '--cta-bg': '#112233', '--link-color': '#445566',
            '--highlight-color': '#778899', '--tile-color': '#aabbcc',
            '--highlight-border': 'color-mix(in srgb, #778899 30%, transparent)',
        });
    });

    it('drops anything that is not #rrggbb', () => {
        expect(roleVars({ cta: 'red', link: 'url(x)', highlight: '#fff', tile: '#12345678' }, undefined)).toEqual({});
        expect(roleColor('#1F2937')).toBe('#1F2937');
        expect(roleColor('var(--x)')).toBe('');
    });

    it('maps the plain label style to the body font in sentence case; mono is the identity', () => {
        expect(roleVars(undefined, 'plain')['--label-font']).toBe('var(--font-body)');
        expect(roleVars(undefined, 'plain')['--label-transform']).toBe('none');
        expect(roleVars(undefined, 'mono')).toEqual({});
        expect(roleVars(undefined, 'constructor')).toEqual({});
    });

    it('only sets properties it lists for clearing', () => {
        const all = roleVars({ cta: '#112233', link: '#445566', highlight: '#778899', tile: '#aabbcc' }, 'plain');
        for (const prop of Object.keys(all)) expect(ROLE_VAR_PROPS).toContain(prop);
    });

    it('stays in lockstep with the server roles and label enum', () => {
        expect(DESIGN_COMPONENT_ENUMS.labelStyle).toEqual(['mono', ...LABEL_STYLE_NAMES]);
        expect([...BLANKABLE_COLORS].sort()).toEqual(['cta', 'highlight', 'link', 'tile']);
    });
});

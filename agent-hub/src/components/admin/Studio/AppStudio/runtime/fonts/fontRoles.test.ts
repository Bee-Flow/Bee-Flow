import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { appDesignProps } from '../appDesign';
import { resolveNodeStyle } from '../styleResolver';
import { FONT_ROLE_FAMILIES, FONT_ROLES, fontAssetIds, fontRolesOf, fontStack } from './fontRoles';

const require = createRequire(import.meta.url);
const server = require('../../../../../../../../server/appStudio/appFontRoles.js') as {
    FONT_ROLES: readonly string[];
    FONT_ROLE_FAMILIES: Record<string, { family: string; kind: string }>;
};

const cell = (style: Record<string, unknown>, design?: unknown) => resolveNodeStyle({ style } as never, { design });

describe('font roles (design.fonts)', () => {
    it('name the same families and roles as the server (appFontRoles.js)', () => {
        expect([...FONT_ROLES]).toEqual([...server.FONT_ROLES]);
        const strip = (table: Record<string, { family: string; kind: string }>) => Object.fromEntries(Object.entries(table).map(([id, { family, kind }]) => [id, { family, kind }]));
        expect(strip(FONT_ROLE_FAMILIES)).toEqual(strip(server.FONT_ROLE_FAMILIES));
    });

    it('a design without roles adds nothing to the root', () => {
        expect(appDesignProps({ design: { font: 'satoshi' } })).toEqual({ className: '', style: { fontFamily: "'Satoshi', system-ui, -apple-system, sans-serif" } });
        expect(appDesignProps({ design: { font: 'satoshi', fonts: { heading: 'comic-sans' } } } as never).className).toBe('');
    });

    it('a role sets its variable, a class for headings and code, and the body font on the root', () => {
        const { className, style } = appDesignProps({ design: { font: 'satoshi', fonts: { heading: 'fraunces', body: 'inter', mono: 'asset:brand_mono' } } } as never);
        expect(className.split(' ')).toEqual(['app-fonts--heading', 'app-fonts--mono']);
        expect(style).toMatchObject({
            '--app-font-heading': "'Fraunces', Georgia, \"Times New Roman\", serif",
            '--app-font-body': "'Inter', system-ui, -apple-system, sans-serif",
            '--app-font-mono': "'app-font-brand_mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
        });
    });

    it('an uploaded font is named once, by its asset id', () => {
        const roles = fontRolesOf({ fonts: { heading: 'asset:f1', body: 'asset:f1', mono: 'fira-code' } });
        expect(fontAssetIds(roles)).toEqual(['f1']);
        expect(fontStack('asset:f1', 'body')).toBe("'app-font-f1', system-ui, -apple-system, sans-serif");
        expect(fontStack('roboto', 'body')).toBeNull();
    });

    it('the font knob writes what it always wrote in an app without roles', () => {
        expect(cell({ font: 'heading' }).style.fontFamily).toBe('inherit');
        expect(cell({ font: 'heading' }, { font: 'inter' }).style.fontFamily).toBe('inherit');
        expect(String(cell({ font: 'mono' }).style.fontFamily)).toContain('ui-monospace');
        expect(cell({ font: 'mono' }).className).not.toContain('app-tk-font');
    });

    it('the font knob follows the roles of the design that sets them', () => {
        const design = { fonts: { heading: 'fraunces' } };
        const heading = cell({ font: 'heading' }, design);
        expect(heading.style.fontFamily).toBe('var(--app-font-heading)');
        expect(heading.className).toContain('app-tk-font');
        // A role the design leaves out keeps today's value.
        expect(String(cell({ font: 'mono' }, design).style.fontFamily)).toContain('ui-monospace');
        expect(cell({ font: 'body' }, design).style.fontFamily).toBe('inherit');
        expect(cell({ font: 'body' }, { fonts: { body: 'inter' } }).style.fontFamily).toBe('var(--app-font-body)');
    });
});

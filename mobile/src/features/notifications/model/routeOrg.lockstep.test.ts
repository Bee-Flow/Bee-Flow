/**
 * The organisation deep links, held to the web's segment table
 * (agent-hub/src/authedApp/settingsRoutes.js) and to features/org's section
 * registry, so a segment the web adds or a section that moves goes red here.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ORG_SECTIONS } from '@/features/org';
import { WEB_ONLY_ORG_SECTIONS } from '@/features/org/model/sections';

import { translateWebLink } from './route';
import { ORG_SETTINGS_SEGMENTS, adminTarget, legacyOrgSettingsTarget } from './routeOrg';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/authedApp/settingsRoutes.js');

/** SETTINGS_ORG_ID_TO_URL as [id, segment] pairs, in the web's order. */
function webOrgSegments(): [string, string][] {
    const src = fs.readFileSync(WEB, 'utf8');
    const body = /export const SETTINGS_ORG_ID_TO_URL\s*=\s*\{([\s\S]*?)\};/.exec(src)?.[1] ?? '';
    return [...body.matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1] as string, m[2] as string]);
}

describe('the organisation settings segments', () => {
    const all = webOrgSegments();
    // A section the phone leaves to the web (sections.ts WEB_ONLY_ORG_SECTIONS)
    // has no screen here: its link opens the org index, tested below.
    const webOnly = all.filter(([id]) => WEB_ONLY_ORG_SECTIONS.includes(id));
    const web = all.filter(([id]) => !WEB_ONLY_ORG_SECTIONS.includes(id));

    it('reads the web table', () => {
        expect(web.length).toBeGreaterThan(10);
    });

    it.each(web)('%s (/app/settings/organisation/%s) opens its section', (id, segment) => {
        const section = ORG_SECTIONS.find((s) => s.id === id);
        expect(section).toBeDefined();
        expect(ORG_SETTINGS_SEGMENTS[segment]).toBe(section?.href);
        expect(translateWebLink(`/app/settings/organisation/${segment}`)?.href).toBe(section?.href);
    });

    it('lists no segment the web does not have', () => {
        expect(Object.keys(ORG_SETTINGS_SEGMENTS).sort()).toEqual(web.map(([, s]) => s).sort());
    });

    it('opens the index for a section the phone leaves to the web', () => {
        expect(webOnly.length).toBe(WEB_ONLY_ORG_SECTIONS.length);
        for (const [, segment] of webOnly) {
            expect(translateWebLink(`/app/settings/organisation/${segment}`)?.href).toBe('/org');
        }
    });

    it('opens the index for a segment it does not know', () => {
        expect(translateWebLink('/app/settings/organisation/nope')?.href).toBe('/org');
    });
});

describe('the legacy org-settings page and the admin dashboard tabs', () => {
    it('maps the users tab and its sub-sections', () => {
        expect(legacyOrgSettingsTarget('users', 'roles').href).toBe('/org/roles');
        expect(legacyOrgSettingsTarget('users', undefined).href).toBe('/org/people');
        expect(translateWebLink('/app/org-settings/knowledge-bases')?.href).toBe('/org/knowledge-bases');
        expect(translateWebLink('/app/org-settings')?.href).toBe('/org');
    });

    it('sends an org-admin tab to its org-side home and the rest to the index', () => {
        expect(adminTarget('access').href).toBe('/org/access');
        expect(translateWebLink('/app/admin/compliance/incidents/i1')?.href).toBe('/org/compliance/incidents/i1');
        expect(translateWebLink('/app/admin/security/users')?.href).toBe('/org/members?status=pending');
        expect(translateWebLink('/app/admin/security')?.href).toBe('/org/members');
        expect(adminTarget('modules')).toEqual({ href: '/org', approximate: true });
    });
});

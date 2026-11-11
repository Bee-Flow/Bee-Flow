/**
 * The organisation deep links, held to the web's segment table
 * (agent-hub/src/authedApp/settingsRoutes.ts) and to features/org's section
 * registry, so a segment the web adds or a section that moves goes red here.
 */

import { ORG_SECTIONS } from '@/features/org';
import { WEB_ONLY_ORG_SECTIONS, WEB_ORG_SECTIONS } from '@/features/org/model/sections';
import { loadWebModule } from '@/shared/testing/webModule';

import { translateWebLink } from './route';
import { ORG_SETTINGS_SEGMENTS, adminTarget, legacyOrgSettingsTarget } from './routeOrg';

const webRoutes = loadWebModule<{ SETTINGS_ORG_ID_TO_URL: Record<string, string> }>('authedApp/settingsRoutes.ts');

/** SETTINGS_ORG_ID_TO_URL as [id, segment] pairs, in the web's order (the web module itself, run). */
function webOrgSegments(): [string, string][] {
    return Object.entries(webRoutes.SETTINGS_ORG_ID_TO_URL);
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

    it('gives every web section an address', () => {
        // sections.lockstep.test.ts holds WEB_ORG_SECTIONS to the web's row
        // lists, so a web row without a segment shows up here.
        const ids = all.map(([id]) => id);
        expect(WEB_ORG_SECTIONS.map((s) => s.id).filter((id) => !ids.includes(id))).toEqual([]);
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

    it('sends the organisation tab and its sections to the screen of the same settings segment', () => {
        expect(adminTarget('organisation').href).toBe('/org');
        expect(translateWebLink('/app/admin/organisation')?.href).toBe('/org');
        for (const [segment, href] of Object.entries(ORG_SETTINGS_SEGMENTS)) {
            expect(translateWebLink(`/app/admin/organisation/${segment}`)?.href).toBe(href);
        }
        expect(adminTarget('organisation', ['mcp'])).toEqual({ href: '/org', approximate: true });
    });

    it('sends the organisation shield and the monitoring pages to their screens', () => {
        expect(translateWebLink('/app/admin/security/guardrails')?.href).toBe('/org/shield');
        expect(translateWebLink('/app/admin/monitoring')?.href).toBe('/org/usage');
        expect(translateWebLink('/app/admin/monitoring/activity')?.href).toBe('/org/usage');
    });
});

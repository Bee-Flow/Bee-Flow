// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { FamilyAvailability, IntegrationFamily, OrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import type { IntegrationEntry } from '@/config/integrationCatalog';
import {
    PER_USER_INTEGRATION_IDS,
    TARGETS,
    appStatusGroups,
    familyStatusRows,
    integrationCards,
    nothingAvailable,
    targetHref,
} from './integrationStatusModel';

const yes: FamilyAvailability = { serverConfigured: true, inCeiling: true, available: true };
const notGranted: FamilyAvailability = { serverConfigured: true, inCeiling: false, available: false, reason: 'not_granted_to_org' };
const notSetUp: FamilyAvailability = { serverConfigured: false, inCeiling: true, available: false, reason: 'not_configured' };
const notBound: FamilyAvailability = { serverConfigured: true, inCeiling: true, available: false, reason: 'not_bound' };
const notInPlan: FamilyAvailability = { serverConfigured: true, inCeiling: false, available: false, reason: 'not_in_plan' };

const FAMILY_IDS: IntegrationFamily[] = ['google', 'microsoft', 'nextcloud', 'github', 'n8n', 'maps', 'mcp', 'meetingNotes', 'projects', 'learningCenter', 'automations', 'imageGen'];

function answer(families: Partial<Record<IntegrationFamily, FamilyAvailability>>, integrations: Record<string, FamilyAvailability> = {}, degraded = false): { data: OrgIntegrationAvailability } {
    return {
        data: {
            orgId: 'org-b',
            homeOrg: false,
            degraded,
            families: Object.fromEntries(FAMILY_IDS.map(id => [id, families[id] ?? notGranted])) as Record<IntegrationFamily, FamilyAvailability>,
            nextcloud: { bound: false, apps: [], pairingAvailable: true },
            microsoft: { directoryConnected: false },
            github: { syncConfigured: false },
            signIn: { password: true, google: false, microsoft: false, ssoLicensed: false },
            integrations,
        },
    };
}

const byId = <T extends { id: string }>(rows: T[]) => Object.fromEntries(rows.map(r => [r.id, r]));

describe('familyStatusRows', () => {
    it('reads the chosen organisation: available, not granted, not set up, not bound', () => {
        const rows = byId(familyStatusRows(answer({ n8n: yes, github: notGranted, maps: notSetUp, nextcloud: notBound, mcp: notInPlan }), true));
        expect(rows.n8n.state).toBe('available');
        expect(rows.n8n.target).toBeNull();
        expect(rows.github.state).toBe('not_granted');
        expect(rows.github.target).toBe(TARGETS.access);
        expect(rows.maps.state).toBe('not_configured');
        expect(rows.maps.target).toBe(TARGETS.platformServices);
        expect(rows.nextcloud.state).toBe('not_bound');
        expect(rows.nextcloud.target).toBe(TARGETS.ncPairing);
        expect(rows.mcp.state).toBe('not_in_plan');
        expect(rows.mcp.target).toBe(TARGETS.licence);
    });

    it('sends a self-hosted server to the server licence for something not in the plan (the organisation licence row is cloud only)', () => {
        const admin = byId(familyStatusRows(answer({ mcp: notInPlan }), true, { selfHosted: true }));
        expect(admin.mcp.target).toBe(TARGETS.serverLicence);
        const orgAdmin = byId(familyStatusRows(answer({ mcp: notInPlan }), false, { selfHosted: true }));
        expect(orgAdmin.mcp.target).toBeNull();
        const apps = byId(appStatusGroups(answer({}, { fireflies: notInPlan }), true, [{ id: 'fireflies', label: 'Fireflies', description: '', category: 'Productivity' }], { selfHosted: true }).flatMap(g => g.rows));
        expect(apps.fireflies.target).toBe(TARGETS.serverLicence);
    });

    it('gives an organisation admin no link for an unbound Nextcloud (its row is not there until it is bound)', () => {
        const rows = byId(familyStatusRows(answer({ nextcloud: notBound }), false));
        expect(rows.nextcloud.state).toBe('not_bound');
        expect(rows.nextcloud.target).toBeNull();
    });

    it('gives an organisation admin no link to a whole-server page', () => {
        const rows = byId(familyStatusRows(answer({ maps: notSetUp, google: notSetUp }), false));
        expect(rows.maps.state).toBe('not_configured');
        expect(rows.maps.target).toBeNull();
        expect(rows.google.target).toBeNull();
    });

    it('sends a platform admin to Sign-in & SSO for Google or Microsoft that is not set up', () => {
        const rows = byId(familyStatusRows(answer({ google: notSetUp, microsoft: notSetUp }), true));
        expect(rows.google.target).toBe(TARGETS.signIn);
        expect(rows.microsoft.target).toBe(TARGETS.signIn);
    });

    it('says a member connects Google or Microsoft in their own Settings', () => {
        const rows = byId(familyStatusRows(answer({ google: yes, microsoft: yes }), false));
        expect(rows.google.state).toBe('per_user');
        expect(rows.google.target).toBe(TARGETS.connections);
    });

    it('links an available Nextcloud, GitHub or MCP to its own row', () => {
        const rows = byId(familyStatusRows(answer({ nextcloud: yes, github: yes, mcp: yes }), false));
        expect(rows.nextcloud.target).toBe(TARGETS.nextcloud);
        expect(rows.github.target).toBe(TARGETS.githubSync);
        expect(rows.mcp.target).toBe(TARGETS.mcp);
    });

    it('is unknown without an answer, or when a degraded plan read cannot vouch for a refusal', () => {
        expect(familyStatusRows({ data: null, isError: true }, true).every(r => r.state === 'unknown')).toBe(true);
        const rows = byId(familyStatusRows(answer({ n8n: notInPlan, maps: notSetUp }, {}, true), true));
        expect(rows.n8n.state).toBe('unknown');
        expect(rows.maps.state).toBe('not_configured');
    });
});

describe('appStatusGroups', () => {
    const catalog: IntegrationEntry[] = [
        { id: 'gmail', label: 'Gmail', description: 'Mail', category: 'Google Workspace' },
        { id: 'fireflies', label: 'Fireflies', description: 'Transcripts', category: 'Productivity' },
        { id: 'nmbrs', label: 'NMBRS', description: 'Payroll', category: 'Productivity' },
        { id: 'linkedin', label: 'LinkedIn', description: 'Posts', category: 'Social' },
        { id: 'image-gen', label: 'Image Generation', description: 'Images', category: 'AI & Media' },
    ];

    it('lists every catalogue integration in the admin UIs category order', () => {
        const groups = appStatusGroups(answer({}, {}), true, catalog);
        expect(groups.map(g => g.category)).toEqual(['Google Workspace', 'AI & Media', 'Productivity', 'Social']);
    });

    it('marks the per-user integrations: available means each member connects in Settings', () => {
        const groups = appStatusGroups(answer({}, { fireflies: yes, nmbrs: notGranted, gmail: yes }), false, catalog);
        const rows = byId(groups.flatMap(g => g.rows));
        expect(rows.fireflies.state).toBe('per_user');
        expect(rows.fireflies.target).toBe(TARGETS.connections);
        expect(rows.nmbrs.state).toBe('not_granted');
        expect(rows.nmbrs.target).toBe(TARGETS.access);
        expect(rows.gmail.state).toBe('available');
        expect(groups.find(g => g.category === 'Productivity')?.usable).toBe(1);
    });

    it('points a platform admin to where an app is set up on the server', () => {
        const rows = byId(appStatusGroups(answer({}, { linkedin: notSetUp, 'image-gen': notSetUp, gmail: notSetUp }), true, catalog).flatMap(g => g.rows));
        expect(rows.linkedin.target).toBe(TARGETS.platformServices);
        expect(rows['image-gen'].target).toBe(TARGETS.aiProviders);
        expect(rows.gmail.target).toBe(TARGETS.signIn);
    });

    it('covers the per-user integrations the brief names', () => {
        for (const id of ['fireflies', 'nmbrs', 'afas-profit', 'frappe-crm', 'firebird', 'vplan', 'signrequest', 'youtrack', 'gamma']) {
            expect(PER_USER_INTEGRATION_IDS.has(id), id).toBe(true);
        }
    });
});

describe('nothingAvailable', () => {
    it('is true only when every answer is definite and nothing is usable', () => {
        const none = answer({}, {});
        expect(nothingAvailable(familyStatusRows(none, false), appStatusGroups(none, false, []))).toBe(true);
        const some = answer({ n8n: yes });
        expect(nothingAvailable(familyStatusRows(some, false), appStatusGroups(some, false, []))).toBe(false);
        const unknown = { data: null, isError: true };
        expect(nothingAvailable(familyStatusRows(unknown, true), appStatusGroups(unknown, true, []))).toBe(false);
    });
});

describe('integrationCards', () => {
    it('follows the chosen organisation, not the viewer: no n8n card where n8n is not granted', () => {
        expect(integrationCards(answer({ n8n: notGranted, nextcloud: notBound }), true)).toEqual({ showN8n: false, showNc: false });
        expect(integrationCards(answer({ n8n: yes, nextcloud: yes }), false)).toEqual({ showN8n: true, showNc: true });
    });

    it('fails open for a platform admin and closed for an organisation admin while the answer is missing', () => {
        expect(integrationCards({ data: null }, true)).toEqual({ showN8n: true, showNc: true });
        expect(integrationCards({ data: null }, false)).toEqual({ showN8n: false, showNc: false });
    });
});

describe('targetHref', () => {
    it('keeps the dashboard organisation on an admin row, never on Settings', () => {
        expect(targetHref(TARGETS.access, '?org=org-b')).toBe('/app/admin/access/grants?org=org-b');
        expect(targetHref(TARGETS.access, '')).toBe('/app/admin/access/grants');
        expect(targetHref(TARGETS.connections, '?org=org-b')).toBe('/app/settings/integrations');
    });
});

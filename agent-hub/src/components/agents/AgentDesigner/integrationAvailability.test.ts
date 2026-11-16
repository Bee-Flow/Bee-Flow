// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { filterAvailableIntegrations, needsPersonalConnection, ALWAYS_AVAILABLE } from './integrationAvailability';
import type { OrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';

// Minimal catalog stand-in — the filter only reads id/group.
const CATALOG = [
    { id: 'agent-search', label: 'Web Search', group: 'platform' },
    { id: 'gmail', label: 'Gmail', group: 'google' },
    { id: 'google-calendar', label: 'Calendar', group: 'google' },
    { id: 'outlook', label: 'Outlook', group: 'microsoft' },
    { id: 'onedrive', label: 'OneDrive', group: 'microsoft' },
    { id: 'fireflies', label: 'Fireflies', group: 'third-party' },
    { id: 'youtrack', label: 'YouTrack', group: 'third-party' },
    { id: 'gamma', label: 'Gamma', group: 'third-party' },
    { id: 'n8n', label: 'n8n', group: 'third-party' },
    { id: 'linkedin', label: 'LinkedIn', group: 'third-party' },
    { id: 'afas-profit', label: 'AFAS', group: 'third-party' },
    { id: 'nmbrs', label: 'NMBRS', group: 'third-party' },
    { id: 'frappe-crm', label: 'Frappe CRM', group: 'third-party' },
    { id: 'firebird', label: 'Firebird', group: 'third-party' },
    { id: 'vplan', label: 'vPlan', group: 'third-party' },
    { id: 'signrequest', label: 'SignRequest', group: 'third-party' },
    { id: 'nextcloud-talk', label: 'Talk', group: 'nextcloud' },
    { id: 'github', label: 'GitHub', group: 'third-party' },
];

const ids = (list: { id: string }[]) => list.map((i) => i.id);

describe('filterAvailableIntegrations', () => {
    it('returns the full catalog while status has not loaded', () => {
        expect(filterAvailableIntegrations(CATALOG, null)).toEqual(CATALOG);
        expect(filterAvailableIntegrations(CATALOG, undefined)).toEqual(CATALOG);
    });

    it('can read a status that has not loaded as "nothing yet" instead', () => {
        expect(filterAvailableIntegrations(CATALOG, null, { mode: 'user', unloaded: 'none' })).toEqual([]);
    });

    it('gates google-group apps on isGoogleUser', () => {
        const out = ids(filterAvailableIntegrations(CATALOG, { isGoogleUser: false }));
        expect(out).not.toContain('gmail');
        expect(out).not.toContain('google-calendar');
        const on = ids(filterAvailableIntegrations(CATALOG, { isGoogleUser: true }));
        expect(on).toContain('gmail');
    });

    it('gates credentialed third-party apps on their config flags', () => {
        const none = ids(filterAvailableIntegrations(CATALOG, {}));
        expect(none).not.toContain('fireflies');
        expect(none).not.toContain('youtrack');
        expect(none).not.toContain('gamma');
        expect(none).not.toContain('n8n');
        expect(none).not.toContain('linkedin');

        const all = ids(filterAvailableIntegrations(CATALOG, {
            hasFirefliesKey: true, hasYouTrackConfig: true, hasGammaKey: true,
            hasN8nConfig: true, linkedInConnected: true,
        }));
        expect(all).toEqual(expect.arrayContaining(['fireflies', 'youtrack', 'gamma', 'n8n', 'linkedin']));
    });

    it('gates the business apps on the personal config the settings payload reports', () => {
        const personal = ['afas-profit', 'nmbrs', 'frappe-crm', 'firebird', 'vplan', 'signrequest'];
        const none = ids(filterAvailableIntegrations(CATALOG, {}));
        for (const id of personal) expect(none).not.toContain(id);
        const all = ids(filterAvailableIntegrations(CATALOG, {
            hasAfasConfig: true, hasNmbrsConfig: true, hasFrappeCrmConfig: true,
            hasFirebirdConfig: true, hasVplanConfig: true, hasSignRequestConfig: true,
        }));
        expect(all).toEqual(expect.arrayContaining(personal));
        // Nothing personal about GitHub here: it stays.
        expect(none).toContain('github');
    });

    it('gates Nextcloud apps on the Nextcloud login or app password when the caller knows them', () => {
        expect(ids(filterAvailableIntegrations(CATALOG, {}))).toContain('nextcloud-talk');
        expect(ids(filterAvailableIntegrations(CATALOG, { isNextcloudUser: false, hasNextcloudAppPassword: false }))).not.toContain('nextcloud-talk');
        expect(ids(filterAvailableIntegrations(CATALOG, { hasNextcloudAppPassword: true }))).toContain('nextcloud-talk');
    });

    it('gates microsoft-group apps on the Microsoft login, Outlook also on a 365 connection', () => {
        const none = ids(filterAvailableIntegrations(CATALOG, { isGoogleUser: true }));
        expect(none).not.toContain('outlook');
        expect(none).not.toContain('onedrive');

        // Google SSO + Microsoft 365 connected in Settings: only Outlook.
        const connected = ids(filterAvailableIntegrations(CATALOG, { isGoogleUser: true, hasMicrosoftConnection: true }));
        expect(connected).toContain('outlook');
        expect(connected).not.toContain('onedrive');

        const msUser = ids(filterAvailableIntegrations(CATALOG, { isMicrosoftUser: true }));
        expect(msUser).toEqual(expect.arrayContaining(['outlook', 'onedrive']));
    });

    it('org-enabled list filters everything except ALWAYS_AVAILABLE', () => {
        const out = ids(filterAvailableIntegrations(CATALOG, {
            orgEnabledIntegrations: ['outlook'], isGoogleUser: true, isMicrosoftUser: true,
        }));
        expect(out).toEqual(['agent-search', 'outlook']);
        expect(ALWAYS_AVAILABLE.has('agent-search')).toBe(true);
    });
});

/** An availability answer in which only `available` lists apps the organisation has. */
function availability(available: string[], degraded = false): OrgIntegrationAvailability {
    const integrations = Object.fromEntries(CATALOG.map(i => [i.id, available.includes(i.id)
        ? { serverConfigured: true, inCeiling: true, available: true }
        : { serverConfigured: false, inCeiling: true, available: false, reason: 'not_configured' as const }]));
    return {
        orgId: 'org-b', homeOrg: false, degraded,
        families: {} as OrgIntegrationAvailability['families'],
        nextcloud: { bound: true, apps: [], pairingAvailable: false },
        microsoft: { directoryConnected: false }, github: { syncConfigured: false },
        signIn: { password: true, google: false, microsoft: false, ssoLicensed: false },
        integrations,
    };
}

describe('filterAvailableIntegrations in admin mode', () => {
    it("follows the organisation's availability, never the admin's own logins or keys", () => {
        const read = { data: availability(['gmail', 'outlook', 'onedrive', 'nmbrs', 'nextcloud-talk']) };
        // The admin signed in with a password and has no keys at all.
        const out = ids(filterAvailableIntegrations(CATALOG, { isGoogleUser: false }, { mode: 'admin', availability: read, platformAdmin: false }));
        expect(out).toEqual(['agent-search', 'gmail', 'outlook', 'onedrive', 'nmbrs', 'nextcloud-talk']);
    });

    it('Microsoft apps the server has no Microsoft app for are not offered', () => {
        const read = { data: availability(['gmail']) };
        const out = ids(filterAvailableIntegrations(CATALOG, { isMicrosoftUser: true }, { mode: 'admin', availability: read, platformAdmin: true }));
        expect(out).not.toContain('outlook');
        expect(out).not.toContain('onedrive');
    });

    it('without an answer: everything for a platform admin, only the built-ins for an organisation admin', () => {
        for (const read of [null, { isError: true }]) {
            expect(filterAvailableIntegrations(CATALOG, null, { mode: 'admin', availability: read, platformAdmin: true })).toEqual(CATALOG);
            expect(ids(filterAvailableIntegrations(CATALOG, null, { mode: 'admin', availability: read, platformAdmin: false }))).toEqual(['agent-search']);
        }
    });
});

describe('needsPersonalConnection', () => {
    it('is true for apps that run on each person\'s own login or key', () => {
        const byId = new Map(CATALOG.map(i => [i.id, i]));
        for (const id of ['gmail', 'outlook', 'nextcloud-talk', 'fireflies', 'nmbrs']) expect(needsPersonalConnection(byId.get(id)!)).toBe(true);
        for (const id of ['agent-search', 'github']) expect(needsPersonalConnection(byId.get(id)!)).toBe(false);
    });

    it('is false for n8n: it runs on the organisation\'s own n8n instance, not on a personal key', () => {
        expect(needsPersonalConnection({ id: 'n8n', group: 'third-party' })).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import type { FamilyAvailability, IntegrationFamily, OrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import type { TranslateFn } from '@/hooks/useTranslation';
import {
    availabilityReasonText,
    availabilityUnknownText,
    familyAvailable,
    integrationAvailable,
} from './integrationAvailability';
import { GOOGLE_APP_IDS, MICROSOFT_APP_IDS } from './integrationFamilies';

const PLATFORM = { platformAdmin: true };
const ORG_ADMIN = { platformAdmin: false };

const ON: FamilyAvailability = { serverConfigured: true, inCeiling: true, available: true };
const FAMILIES: IntegrationFamily[] = ['google', 'microsoft', 'nextcloud', 'github', 'n8n', 'maps', 'mcp', 'meetingNotes', 'projects', 'learningCenter', 'automations', 'imageGen'];

function answer(over: Partial<OrgIntegrationAvailability> = {}, families: Partial<Record<IntegrationFamily, FamilyAvailability>> = {}): OrgIntegrationAvailability {
    return {
        orgId: 'org-1',
        homeOrg: true,
        degraded: false,
        families: { ...Object.fromEntries(FAMILIES.map(f => [f, ON])), ...families } as Record<IntegrationFamily, FamilyAvailability>,
        nextcloud: { bound: false, apps: [], pairingAvailable: true },
        microsoft: { directoryConnected: false },
        github: { syncConfigured: false },
        signIn: { password: true, google: true, microsoft: true, ssoLicensed: true },
        integrations: {
            gmail: { serverConfigured: true, inCeiling: true, available: true },
            maps: { serverConfigured: false, inCeiling: true, available: false, reason: 'not_configured' },
            github: { serverConfigured: true, inCeiling: false, available: false, reason: 'not_in_plan' },
        },
        ...over,
    };
}

describe('familyAvailable: a definite answer', () => {
    it('is the answer for every viewer', () => {
        const read = { data: answer({}, { google: { serverConfigured: false, inCeiling: true, available: false, reason: 'not_configured' } }) };
        expect(familyAvailable(read, 'microsoft', ORG_ADMIN)).toEqual({ available: true, unknown: false });
        expect(familyAvailable(read, 'google', ORG_ADMIN)).toEqual({ available: false, reason: 'not_configured', unknown: false });
        expect(familyAvailable(read, 'google', PLATFORM)).toEqual({ available: false, reason: 'not_configured', unknown: false });
    });

    it('carries the reason the server gave', () => {
        const read = { data: answer({}, { nextcloud: { serverConfigured: true, inCeiling: true, available: false, reason: 'not_bound' } }) };
        expect(familyAvailable(read, 'nextcloud', ORG_ADMIN).reason).toBe('not_bound');
    });
});

describe('familyAvailable: no definite answer (the fail policy)', () => {
    it('while loading: open for a platform admin with the unknown flag, closed for an org admin form', () => {
        expect(familyAvailable({ data: undefined }, 'google', PLATFORM)).toEqual({ available: true, unknown: true });
        expect(familyAvailable({ data: undefined }, 'google', ORG_ADMIN)).toEqual({ available: false, unknown: true });
        expect(familyAvailable(undefined, 'google', ORG_ADMIN)).toEqual({ available: false, unknown: true });
    });

    it('after an error, even with stale data', () => {
        const read = { data: answer(), isError: true };
        expect(familyAvailable(read, 'google', PLATFORM)).toEqual({ available: true, unknown: true });
        expect(familyAvailable(read, 'google', ORG_ADMIN)).toEqual({ available: false, unknown: true });
    });

    it('a degraded plan read cannot vouch for a plan reason, but a server reason stands', () => {
        const read = {
            data: answer({ degraded: true }, {
                mcp: { serverConfigured: true, inCeiling: false, available: false, reason: 'not_in_plan' },
                imageGen: { serverConfigured: false, inCeiling: false, available: false, reason: 'not_configured' },
            }),
        };
        expect(familyAvailable(read, 'mcp', PLATFORM)).toEqual({ available: true, unknown: true });
        expect(familyAvailable(read, 'mcp', ORG_ADMIN)).toEqual({ available: false, unknown: true });
        expect(familyAvailable(read, 'imageGen', PLATFORM)).toEqual({ available: false, reason: 'not_configured', unknown: false });
    });

    it('a family the answer does not know is unknown', () => {
        const data = answer();
        delete (data.families as Partial<Record<IntegrationFamily, FamilyAvailability>>).maps;
        expect(familyAvailable({ data }, 'maps', ORG_ADMIN)).toEqual({ available: false, unknown: true });
    });
});

describe('integrationAvailable', () => {
    it('reads one catalogue integration with the same policy', () => {
        const read = { data: answer() };
        expect(integrationAvailable(read, 'gmail', ORG_ADMIN)).toEqual({ available: true, unknown: false });
        expect(integrationAvailable(read, 'maps', ORG_ADMIN)).toEqual({ available: false, reason: 'not_configured', unknown: false });
        expect(integrationAvailable(read, 'github', ORG_ADMIN)).toEqual({ available: false, reason: 'not_in_plan', unknown: false });
        expect(integrationAvailable(read, 'no-such-app', PLATFORM)).toEqual({ available: true, unknown: true });
        expect(integrationAvailable({ data: undefined }, 'gmail', ORG_ADMIN)).toEqual({ available: false, unknown: true });
    });
});

describe('texts', () => {
    const t = ((key: string, fallback?: unknown) => `${key}|${String(fallback)}`) as TranslateFn;

    it('has a keyed sentence for every reason and for the unknown note', () => {
        for (const reason of ['not_configured', 'not_in_plan', 'not_granted_to_org', 'module_off', 'not_bound'] as const) {
            expect(availabilityReasonText(t, reason)).toMatch(new RegExp(`^admin_availability\\.reason_${reason}\\|`));
        }
        expect(availabilityUnknownText(t)).toMatch(/^admin_availability\.unknown\|/);
    });
});

describe('integration families', () => {
    it('keeps the ids the connections page has always used', () => {
        expect(GOOGLE_APP_IDS).toEqual(['gmail', 'google-calendar', 'google-drive']);
        expect(MICROSOFT_APP_IDS).toEqual(['outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts']);
    });
});

/** Contract readers for the organisation, people, Privacy Shield and DSR payloads. */

import { field, nullable, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    DsrRequest,
    DsrSubmitResponse,
    GuardStatus,
    LicenseHealth,
    Organization,
    OrgMember,
    OrgShield,
    UserGroup,
    UserShield,
} from '../model/types';

const organizationSpec = {
    id: field.str(''),
    name: field.str(''),
    description: field.optStr,
    tagline: field.optStr,
    email: field.optStr,
    phone: field.optStr,
    website: field.optStr,
    address: field.optStr,
    billingLine2: field.optStr,
    billingPostalCode: field.optStr,
    billingCity: field.optStr,
    billingCountry: field.optStr,
    kvk: field.optStr,
    vat: field.optStr,
    logo: field.strOrNull,
    footerText: field.optStr,
    allowSignup: field.optBool,
    authMethod: field.strOrNull,
    autoApproveSSO: field.optBool,
    allowedDomains: field.optStrArray,
    usagePooled: field.optBool,
};

export const readOrganization: (raw: unknown) => Organization | null = nullable(
    shapeOf(organizationSpec),
);

/** `groups` arrives as a list, or as one comma-joined string from older rows. */
function readGroupsField(value: unknown): string[] | string | undefined {
    return typeof value === 'string' ? value : field.optStrArray(value);
}

export const readOrgMembers: (raw: unknown) => OrgMember[] = shapeListOf({
    id: field.str(''),
    username: field.optStr,
    displayName: field.optStr,
    firstName: field.optStr,
    lastName: field.optStr,
    email: field.optStr,
    role: field.optStr,
    orgRole: field.optStr,
    organizationId: field.optStr,
    avatar: field.strOrNull,
    avatarType: field.strOrNull,
    groups: readGroupsField,
    isSystem: field.optBool,
    disabled: field.optBool,
});

export const readGroups: (raw: unknown) => UserGroup[] = shapeListOf({
    id: field.str(''),
    name: field.str(''),
    description: field.optStr,
    organizationId: field.optStr,
    role: field.optStr,
    permissions: field.optStrArray,
});

export const readDsrRequests: (raw: unknown) => DsrRequest[] = shapeListOf({
    id: field.num(0),
    status: field.str(''),
    request_type: field.str(''),
    subject_email: field.optStr,
    created_at: field.str(''),
    fulfilled_at: field.strOrNull,
    notes: field.optStr,
});

export const readDsrSubmit: (raw: unknown) => DsrSubmitResponse | null = nullable(
    shapeOf({
        id: field.numOrNull,
        created_at: field.str(''),
        status_url: field.str(''),
        ack: field.str(''),
    }),
);

/** Defaults are the server's own secure ones (core/privacy/userShieldDefaults.js). */
const readUserShieldFields = shapeOf({
    enabled: field.bool(true),
    euModeEnabled: field.bool(false),
    disableSearchOnUpload: field.bool(false),
    piiDetectionEnabled: field.bool(true),
    piiDetectionCategories: field.strArray,
    piiDetectionConfidenceThreshold: field.num(0.7),
    piiDetectionAction: field.str('tokenize'),
    piiFailureMode: field.str('fail_closed'),
    showRawPayload: field.bool(false),
    implicitDefault: field.optBool,
    updatedAt: field.optStr,
});

/**
 * The user's shield, with every field this build knows validated — and every
 * field it does not know kept. The screen PUTs the whole document back and
 * PUT /user/me replaces the stored one, so a setting added on the server next
 * year must travel back untouched rather than be reset by an allow-list.
 */
export function readUserShield(raw: unknown): UserShield | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return { ...(raw as Record<string, unknown>), ...readUserShieldFields(raw) };
}

export const readGuardStatus: (raw: unknown) => GuardStatus | null = nullable(
    shapeOf({ configured: field.bool(false), reachable: field.bool(false) }),
);

export const readOrgShield: (raw: unknown) => OrgShield | null = nullable(
    shapeOf({
        enabled: field.bool(false),
        collectionIds: field.strArray,
        scope: shapeOf({ userInput: field.bool(false), agentOutput: field.bool(false) }),
        action: field.str(''),
        euModeEnabled: field.bool(false),
        piiDetectionCategories: field.strArray,
        piiDetectionConfidenceThreshold: field.num(0.7),
        piiDetectionAction: field.str(''),
        piiFailureMode: field.str(''),
        monitorIntegrations: field.bool(false),
        applyToAutomations: field.bool(false),
        piiAllowTerms: field.strArray,
        piiAllowPublicOrgs: field.bool(false),
        clamped_fields: field.optStrArray,
        clamped_tier: field.optStr,
        stalenessWarnings: field.optStrArray,
    }),
);

/** GET /api/integrations/github/status: `{connected, username}`; anything else is "not connected". */
export function readGithubStatus(raw: unknown): boolean {
    return shapeOf({ connected: field.bool(false) })(raw ?? {}).connected;
}

export const readLicenseHealth: (raw: unknown) => LicenseHealth | null = nullable(
    shapeOf({
        refresher: shapeOf({
            enabled: field.bool(false),
            lastTickAt: field.strOrNull,
            lastError: field.strOrNull,
        }),
        crl: shapeOf({ enabled: field.bool(false), lastPollAt: field.strOrNull }),
        dunning: shapeOf({ past_due_count: field.num(0), suspended_count: field.num(0) }),
        now: field.str(''),
    }),
);

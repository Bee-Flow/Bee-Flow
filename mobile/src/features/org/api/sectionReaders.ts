/**
 * Contract readers for the org-admin settings sections: default language,
 * encryption, AI context, integration cache and the Academy overview. The
 * fallbacks are the server's own defaults, so an older server that omits a
 * field reads as the product default rather than as zero.
 */

import { field, nullable, shapeListOf, shapeOf } from '@/core/api/contract';

import type {
    AcademyOverview,
    EncryptionSaveResult,
    OrgAiContext,
    OrgEncryption,
    OrgIntegrationCache,
    OrgLanguages,
} from '../model/sectionTypes';

export const readOrgLanguages: (raw: unknown) => OrgLanguages = shapeOf({
    defaultLocale: field.str('en'),
    locales: (value: unknown) =>
        shapeListOf({ code: field.str(''), name: field.str('') })(value).filter((l) => l.code),
});

/** POST …/logo answers `{ success, logo }` with the new server-relative path. */
export const readLogoUpload: (raw: unknown) => { logo: string | null } = shapeOf({ logo: field.strOrNull });

export const readOrgEncryption: (raw: unknown) => OrgEncryption | null = nullable(
    shapeOf({
        tier: field.str('none'),
        entitled: field.bool(false),
        tierOptions: shapeListOf({
            tier: field.str(''),
            selectable: field.bool(false),
            reason: field.strOrNull,
            warningReason: field.strOrNull,
            blockedBy: field.strOrNull,
        }),
    }),
);

export const readEncryptionSave: (raw: unknown) => EncryptionSaveResult = shapeOf({
    tier: field.str('none'),
    sessionsBusted: field.bool(false),
});

const range = (min: number, max: number) => shapeOf({ min: field.num(min), max: field.num(max) });

/** Defaults: core/llm/contextPolicy.js DEFAULT_POLICY and the budget range. */
export const readOrgAiContext: (raw: unknown) => OrgAiContext | null = nullable(
    shapeOf({
        compactionEnabled: field.bool(false),
        compactionThreshold: field.num(16),
        recentWindow: field.num(8),
        contextBudgetPercent: field.num(75),
        contextWindowExamples: shapeListOf({ label: field.str(''), contextWindow: field.num(0) }),
        contextBudgetRange: range(25, 95),
    }),
);

/** Defaults: the editor's own (ttl 300 s, range 60–3600, app answers on, web calls off). */
export const readOrgIntegrationCache: (raw: unknown) => OrgIntegrationCache | null = nullable(
    shapeOf({
        enabled: field.bool(false),
        ttlSeconds: field.num(300),
        scopes: shapeOf({ integration: field.bool(true), http: field.bool(false) }),
        killSwitch: field.bool(false),
        ttlRange: range(60, 3600),
        entries: field.num(0),
        expiredEntries: field.num(0),
        bytes: field.num(0),
        purged: field.num(0),
    }),
);

export const readAcademyOverview: (raw: unknown) => AcademyOverview | null = nullable(
    shapeOf({
        courses: shapeListOf({ id: field.str(''), title: field.str(''), lessonCount: field.num(0) }),
        totals: shapeOf({
            members: field.numOrNull,
            coursesCompleted: field.numOrNull,
            certificatesIssued: field.numOrNull,
            activeLast30d: field.numOrNull,
        }),
        members: shapeListOf({
            userId: field.str(''),
            displayName: field.str(''),
            email: field.strOrNull,
            avatar: field.strOrNull,
            avatarType: field.strOrNull,
            coursesDone: field.strArray,
            badges: field.strArray,
            certificates: shapeListOf({
                certificateId: field.str(''),
                level: field.strOrNull,
                issuedAt: field.strOrNull,
            }),
            lastActivity: field.strOrNull,
        }),
    }),
);

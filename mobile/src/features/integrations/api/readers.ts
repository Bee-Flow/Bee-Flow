/** Contract readers for the integration payloads. */

import { field, nullable, pick, shapeOf } from '@/core/api/contract';

import type { IntegrationStatus, UserSettings } from '../model/types';

/** The union of the five providers' `/status` shapes; each fills what it has. */
export const readIntegrationStatus: (raw: unknown) => IntegrationStatus | null = nullable(
    shapeOf({
        connected: field.bool(false),
        configured: field.optBool,
        needsReauth: field.optBool,
        email: field.strOrNull,
        name: field.strOrNull,
        username: field.strOrNull,
    }),
);

/** The OAuth URL out of `{ url }`, or null when there is none to open. */
export function readAuthUrl(raw: unknown): string | null {
    return field.strOrNull(pick(raw, 'url'));
}

export const readGithubConnect: (raw: unknown) => { username?: string } | null = nullable(
    shapeOf({ username: field.optStr }),
);

const flag = field.bool(false);

export const readUserSettings: (raw: unknown) => UserSettings | null = nullable(
    shapeOf({
        enabledApps: field.strArrayOrNull,
        orgEnabledIntegrations: field.strArrayOrNull,
        isGoogleUser: flag,
        isMicrosoftUser: flag,
        hasFirefliesKey: flag,
        hasYouTrackConfig: flag,
        hasGammaKey: flag,
        hasSignRequestConfig: flag,
        hasAfasConfig: flag,
        hasNmbrsConfig: flag,
        hasVplanConfig: flag,
        hasLinkedInConfig: flag,
        hasWithingsConfig: flag,
        hasN8nConfig: flag,
        simpleMode: flag,
        userEuModeEnabled: flag,
        orgEuModeForced: flag,
        hasEuModelsConfigured: flag,
        disableSearchOnUpload: flag,
    }),
);

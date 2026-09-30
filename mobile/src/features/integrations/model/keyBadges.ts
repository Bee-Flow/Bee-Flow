/**
 * Which API-key integrations already have a key stored.
 *
 * `/ai/user-settings` reports presence only — the secrets themselves never
 * leave the server — so this is a set of badges rather than a set of fields.
 */

import type { UserSettings } from './types';

export function keyBadges(
    settings: UserSettings | null | undefined,
): { label: string; present: boolean }[] {
    return [
        { label: 'Fireflies', present: Boolean(settings?.hasFirefliesKey) },
        { label: 'YouTrack', present: Boolean(settings?.hasYouTrackConfig) },
        { label: 'Gamma', present: Boolean(settings?.hasGammaKey) },
        { label: 'SignRequest', present: Boolean(settings?.hasSignRequestConfig) },
        { label: 'AFAS Profit', present: Boolean(settings?.hasAfasConfig) },
        { label: 'NMBRS', present: Boolean(settings?.hasNmbrsConfig) },
        { label: 'vPlan', present: Boolean(settings?.hasVplanConfig) },
        { label: 'n8n', present: Boolean(settings?.hasN8nConfig) },
    ];
}

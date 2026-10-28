/**
 * Which API-key integrations already have a key stored.
 *
 * `/ai/user-settings` reports presence only — the secrets themselves never
 * leave the server — so this is a set of badges rather than a set of fields.
 */

import { translate } from '@/core/i18n';

import type { Copy, UserSettings } from './types';

// The same names, and the same keys, as the catalogue entries of these tools.
const FIREFLIES: Copy = { i18nKey: 'mobile.integrations.app_fireflies', en: 'Fireflies' };
const YOUTRACK: Copy = { i18nKey: 'mobile.integrations.app_youtrack', en: 'YouTrack' };
const GAMMA: Copy = { i18nKey: 'mobile.integrations.app_gamma', en: 'Gamma' };
const SIGNREQUEST: Copy = { i18nKey: 'mobile.integrations.app_signrequest', en: 'SignRequest' };
const AFAS: Copy = { i18nKey: 'mobile.integrations.app_afas_profit', en: 'AFAS Profit' };
const NMBRS: Copy = { i18nKey: 'mobile.integrations.app_nmbrs', en: 'NMBRS' };
const VPLAN: Copy = { i18nKey: 'mobile.integrations.app_vplan', en: 'vPlan' };
const N8N: Copy = { i18nKey: 'mobile.integrations.app_n8n', en: 'n8n' };

const badge = (copy: Copy, present: boolean) => ({ label: translate(copy.i18nKey, copy.en), present });

export function keyBadges(
    settings: UserSettings | null | undefined,
): { label: string; present: boolean }[] {
    return [
        badge(FIREFLIES, Boolean(settings?.hasFirefliesKey)),
        badge(YOUTRACK, Boolean(settings?.hasYouTrackConfig)),
        badge(GAMMA, Boolean(settings?.hasGammaKey)),
        badge(SIGNREQUEST, Boolean(settings?.hasSignRequestConfig)),
        badge(AFAS, Boolean(settings?.hasAfasConfig)),
        badge(NMBRS, Boolean(settings?.hasNmbrsConfig)),
        badge(VPLAN, Boolean(settings?.hasVplanConfig)),
        badge(N8N, Boolean(settings?.hasN8nConfig)),
    ];
}

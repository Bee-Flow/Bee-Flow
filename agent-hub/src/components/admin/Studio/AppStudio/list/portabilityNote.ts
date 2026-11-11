import type { useTranslation } from '@/hooks/useTranslation';

type T = ReturnType<typeof useTranslation>['t'];

/**
 * What an import report says about the parts of an app outside its screens
 * (server/appStudio/portabilityReport.mts): absent when the file held none of them.
 */
export interface PortableSummary {
    assets?: { carried: number; left: number };
    triggers?: { count: number; webhooks: number; armed: false };
    columnRights?: { unknownRoles: string[] };
}

/**
 * The sentences shown with an imported template or app: which uploaded files
 * came along, that triggers arrive switched off (and webhooks get a new address
 * and secret at the next publish), and column rights naming a missing role.
 * Empty when the report has no summary, so an import of an older file reads as before.
 */
export function portabilityNote(t: T, summary: PortableSummary | null | undefined): string {
    if (!summary) return '';
    const parts: string[] = [];
    if (summary.assets?.carried) parts.push(t('studio_apps_w3a.import.assets_carried', '{count} uploaded files (pictures, logo, fonts) came along.', { count: summary.assets.carried }));
    if (summary.assets?.left) parts.push(t('studio_apps_w3a.import.assets_left', '{count} uploaded files did not come along; upload them again in the app.', { count: summary.assets.left }));
    if (summary.triggers?.count) {
        parts.push(t('studio_apps_w3a.import.triggers_off', '{count} triggers came along switched off: they start when you publish the app.', { count: summary.triggers.count }));
        if (summary.triggers.webhooks) parts.push(t('studio_apps_w3a.import.webhooks_new', 'A webhook trigger gets a new address and secret when you publish; the old ones did not come along.'));
    }
    if (summary.columnRights?.unknownRoles.length) parts.push(t('studio_apps_w3a.import.unknown_roles', 'Some column rights name a role the app does not have; that role sees nothing of those fields.'));
    return parts.join(' ');
}

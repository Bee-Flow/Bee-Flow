/**
 * Nextcloud Sync's words and small rules, from NextcloudSyncPanel.tsx and
 * OrgNcPairingPanel.tsx (pinned by orgIntegrations.lockstep.test.ts).
 */

import type { TranslateFn } from '@/core/i18n';

import type { NcSync, NcSyncMode, NcSyncUser } from './nextcloudTypes';

/** "Fresh" is a sync in the last half hour: the web's green dot. */
export const FRESH_MS = 30 * 60_000;

export function syncFreshness(lastSyncAt: string | null, now = Date.now()): 'fresh' | 'stale' | 'never' {
    if (!lastSyncAt) return 'never';
    return now - new Date(lastSyncAt).getTime() < FRESH_MS ? 'fresh' : 'stale';
}

export function activeUsers(users: readonly NcSyncUser[]): number {
    return users.filter((u) => u.status === 'active').length;
}

/** The instance without its scheme, as the web's stat tile shows it. */
export function instanceHost(sync: Pick<NcSync, 'ncBaseUrl'>): string {
    return sync.ncBaseUrl ? sync.ncBaseUrl.replace(/^https?:\/\//, '') : '—';
}

/** fmtCountdown: "12m 05s", or null once the code has expired. */
export function countdown(expiresAt: string | null, now = Date.now()): string | null {
    if (!expiresAt) return '';
    const ms = new Date(expiresAt).getTime() - now;
    if (ms <= 0) return null;
    const min = Math.floor(ms / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    return `${min}m ${sec.toString().padStart(2, '0')}s`;
}

/** The connector's setup page, by deploy daemon (the web's SETUP_PAGE_ADDRESSES): where the code is entered. */
export const SETUP_PAGE_ADDRESSES = `https://<your-nextcloud>/exapps/bee_flow/setup
https://<your-nextcloud>/index.php/apps/app_api/proxy/bee_flow/setup`;

/**
 * The code as an install-time value, for a first install of the connector (the
 * web's AT_INSTALL_COMMAND). AppAPI has no command that changes a value of an
 * installed app: there the code goes in on the connector's setup page.
 */
export function pairingCommands(code: string): string {
    return `occ app_api:app:register bee_flow <daemon> --env BEEFLOW_PAIRING_CODE=${code}`;
}

export function syncModeLabel(mode: NcSyncMode, t: TranslateFn): string {
    if (mode === 'selective_groups') return t('mobile.orgIntegrations.nc_mode_selective', 'Selective groups');
    if (mode === 'manual') return t('mobile.orgIntegrations.nc_mode_manual', 'Manual only');
    return t('mobile.orgIntegrations.nc_mode_mirror', 'Mirror everything');
}

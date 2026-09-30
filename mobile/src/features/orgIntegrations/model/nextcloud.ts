/**
 * Nextcloud Sync's words and small rules, from NextcloudSyncPanel.jsx and
 * OrgNcPairingPanel.jsx (pinned by nextcloud.lockstep.test.ts).
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

/** What the connector's admin runs on the new Nextcloud (the web's "How to use this code"). */
export function pairingCommands(code: string): string {
    return [
        `occ app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE ${code}`,
        'occ app_api:app:disable bee_flow',
        'occ app_api:app:enable bee_flow',
    ].join('\n');
}

export function syncModeLabel(mode: NcSyncMode, t: TranslateFn): string {
    if (mode === 'selective_groups') return t('mobile.orgIntegrations.nc_mode_selective', 'Selective groups');
    if (mode === 'manual') return t('mobile.orgIntegrations.nc_mode_manual', 'Manual only');
    return t('mobile.orgIntegrations.nc_mode_mirror', 'Mirror everything');
}

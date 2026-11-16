// The words of the Nextcloud sync panel that are computed, kept apart from
// the panel so they are tested on their own: the sync modes and the age of
// the last sync in the viewer's language (Intl.RelativeTimeFormat, never a
// hand-built "5 min ago").

import type { TranslateFn } from '@/hooks/useTranslation';

export type NcSyncMode = 'mirror_all' | 'selective_groups' | 'manual';

export const NC_SYNC_MODES: readonly NcSyncMode[] = ['mirror_all', 'selective_groups', 'manual'];

export function isNcSyncMode(v: unknown): v is NcSyncMode {
    return typeof v === 'string' && (NC_SYNC_MODES as readonly string[]).includes(v);
}

/** The short name of a sync mode. */
export function syncModeLabel(t: TranslateFn, mode: NcSyncMode): string {
    switch (mode) {
        case 'mirror_all': return t('admin_connections.nc_mode_mirror_all', 'Mirror everyone');
        case 'selective_groups': return t('admin_connections.nc_mode_selective', 'Selected groups');
        default: return t('admin_connections.nc_mode_manual', 'Manual only');
    }
}

/** What a sync mode does, one sentence. */
export function syncModeDescription(t: TranslateFn, mode: NcSyncMode): string {
    switch (mode) {
        case 'mirror_all': return t('admin_connections.nc_mode_mirror_all_desc', 'Every Nextcloud user gets a Bee Flow account automatically.');
        case 'selective_groups': return t('admin_connections.nc_mode_selective_desc', 'Only members of the Nextcloud groups you pick get an account.');
        default: return t('admin_connections.nc_mode_manual_desc', 'No accounts are created automatically; you invite people yourself.');
    }
}

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
];

/**
 * How long ago `iso` was, in `locale`: "5 minutes ago", "2 days ago"; under a
 * minute "now"; a week or more the date itself. Missing or unreadable: null.
 */
export function relativeSince(iso: string | number | Date | null | undefined, locale: string, now: number = Date.now()): string | null {
    if (iso === null || iso === undefined || iso === '') return null;
    const at = new Date(iso).getTime();
    if (!Number.isFinite(at)) return null;
    const ms = Math.max(0, now - at);
    if (ms >= 7 * 86_400_000) return new Date(at).toLocaleDateString(locale);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    for (const [unit, size] of UNITS) {
        if (ms >= size) return rtf.format(-Math.floor(ms / size), unit);
    }
    return rtf.format(0, 'second');
}

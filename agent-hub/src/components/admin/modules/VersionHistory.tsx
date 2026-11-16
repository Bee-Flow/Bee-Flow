import { History, Loader2, RotateCcw } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { LedgerVersion, MarketplaceHubVersion } from '@/api/queries/modules.types';
import { CHIP, CHIP_ERROR, CHIP_SUCCESS, CHIP_WARNING, PRIMARY_BTN, SECONDARY_BTN } from '@/components/shared/adminUi';

export interface VersionRow {
    version: string;
    channel: string | null;
    changelog: string | null;
    yanked: boolean;
    ledger: LedgerVersion | null;
}

interface VersionHistoryProps {
    hubVersions?: MarketplaceHubVersion[] | null;
    ledgerVersions?: LedgerVersion[] | null;
    busy?: boolean;
    onRollback?: (version: string) => void;
    onActivateStaged?: (version: string) => void;
}

// Unified version list for the detail drawer: hub catalogue versions joined
// with the local install ledger. Pure join/gating helpers are exported for
// unit tests.

/**
 * Join hub versions with local ledger rows by version string. Hub order is
 * kept (newest first from the hub); ledger-only versions (e.g. sideloads or
 * versions the hub no longer lists) are appended.
 */
export function mergeVersionRows(hubVersions?: MarketplaceHubVersion[] | null, ledgerVersions?: LedgerVersion[] | null): VersionRow[] {
    const hub = (Array.isArray(hubVersions) ? hubVersions : []).filter((v: MarketplaceHubVersion) => v && v.version);
    const ledger = (Array.isArray(ledgerVersions) ? ledgerVersions : []).filter((v: LedgerVersion) => v && v.version);
    const ledgerByVersion = new Map<string, LedgerVersion>(ledger.map((l: LedgerVersion) => [l.version, l]));
    const seen = new Set<string>();
    const rows: VersionRow[] = [];
    for (const h of hub) {
        if (seen.has(h.version)) continue;
        seen.add(h.version);
        rows.push({
            version: h.version,
            channel: h.channel || null,
            changelog: h.changelog || null,
            yanked: !!h.yanked,
            ledger: ledgerByVersion.get(h.version) || null,
        });
    }
    for (const l of ledger) {
        if (seen.has(l.version)) continue;
        seen.add(l.version);
        rows.push({ version: l.version, channel: null, changelog: null, yanked: false, ledger: l });
    }
    return rows;
}

/** Rollback is only offered for retired versions whose package is still on disk. */
export function canRollback(row: VersionRow | null | undefined) {
    return !!(row && row.ledger && row.ledger.status === 'retired' && row.ledger.hasPackageFile);
}

// Ledger status → dict key (variable lookup; all values exist in the dict).
const STATUS_KEY: Record<string, string> = {
    active: 'modules.version_status_active',
    retired: 'modules.version_status_retired',
    staged: 'modules.version_status_staged',
    failed: 'modules.version_status_failed',
    incompatible: 'modules.version_status_incompatible',
    quarantined: 'modules.version_status_quarantined',
};

// Ledger status → chip (the theme's status pairs; retired and unknown are neutral).
const STATUS_CHIP: Record<string, string> = {
    active: CHIP_SUCCESS,
    staged: CHIP_WARNING,
    failed: CHIP_ERROR,
    incompatible: CHIP_ERROR,
    quarantined: CHIP_ERROR,
};

export default function VersionHistory({ hubVersions, ledgerVersions, busy = false, onRollback, onActivateStaged }: VersionHistoryProps) {
    const { t } = useTranslation();
    const rows = mergeVersionRows(hubVersions, ledgerVersions);

    if (rows.length === 0) {
        return <p className="text-xs text-[var(--text-muted)]">{t('modules.no_versions')}</p>;
    }

    return (
        <ul className="divide-y border-[var(--border-subtle)]" data-testid="version-history">
            {rows.map((row: VersionRow) => {
                const status = row.ledger?.status || null;
                return (
                    <li key={row.version} className="py-2.5" data-testid={`version-row-${row.version}`}>
                        <div className="flex items-center gap-2 flex-wrap">
                            <History className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                            <span className="text-xs font-semibold text-[var(--text-primary)]">v{row.version}</span>
                            {row.channel && row.channel !== 'stable' && (
                                <span className={CHIP_WARNING}>
                                    {row.channel}
                                </span>
                            )}
                            {row.yanked && (
                                <span className={CHIP_ERROR}>
                                    {t('modules.yanked')}
                                </span>
                            )}
                            {status && (
                                <span className={STATUS_CHIP[status] || CHIP}>
                                    {t(STATUS_KEY[status] || 'modules.version_status_retired')}
                                </span>
                            )}
                            <div className="flex-1" />
                            {status === 'staged' && onActivateStaged && (
                                <button
                                    onClick={() => onActivateStaged(row.version)}
                                    disabled={busy}
                                    className={PRIMARY_BTN}
                                >
                                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                                    {t('modules.activate_staged')}
                                </button>
                            )}
                            {canRollback(row) && onRollback && (
                                <button
                                    onClick={() => onRollback(row.version)}
                                    disabled={busy}
                                    className={SECONDARY_BTN}
                                    data-testid={`rollback-${row.version}`}
                                >
                                    {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
                                    {t('modules.rollback')}
                                </button>
                            )}
                        </div>
                        {row.changelog && (
                            <p className="text-xs mt-1 ml-5 leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]">
                                {row.changelog}
                            </p>
                        )}
                        {row.ledger?.error && (
                            <p className="text-xs mt-1 ml-5 text-[var(--error-ink)]">{row.ledger.error}</p>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

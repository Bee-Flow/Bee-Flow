import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { useTeamsOrgOverview } from '@/api/queries/teamsSetup';
import DiagnosticsChecklist from './DiagnosticsChecklist';
import { failureText, skipText } from './checkText';
import type { TeamsMemberRow } from './types';

const WINDOWS = [7, 14, 30] as const;

const TH = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-[var(--text-muted)]';
const TD = 'px-3 py-2 align-top text-[12px] text-[var(--text-primary)]';
const BADGE = 'inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-muted)]';
const COVERED_BADGE = 'inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success-ink)]';

function connectionText(t: TranslateFn, state: TeamsMemberRow['microsoft']): string {
    switch (state) {
        case 'active': return t('teams_setup.members.connection_active');
        case 'needs_reauth': return t('teams_setup.members.connection_needs_reauth');
        case 'revoked': return t('teams_setup.members.connection_revoked');
        default: return t('teams_setup.members.connection_none');
    }
}

const CONNECTION_INK: Record<TeamsMemberRow['microsoft'], string> = {
    active: 'text-[var(--success-ink)]',
    needs_reauth: 'text-[var(--warning-ink)]',
    revoked: 'text-[var(--error-ink)]',
    none: 'text-[var(--text-muted)]',
};

/**
 * The automatic-import cell for a member without a recorded skip. The poller only looks at a
 * member whose automatic import is on, and a skip is only recorded when it looked, so "runs"
 * needs more than a usable connection or coverage: the organisation must have switched
 * automatic import on for everyone. With the org value left to members (null) the row carries
 * no per-member value, so the cell says it depends on the member rather than guessing.
 */
function AutoImportCell({ row, orgAutoImport }: { row: TeamsMemberRow; orgAutoImport: boolean | null }) {
    const { t } = useTranslation();
    // Organisation-wide import gives a covered member without their own connection the access.
    if (!row.teamsReady && !row.appImportCovered) return null;
    if (orgAutoImport === true) return <span className="text-[var(--success-ink)]">{t('teams_setup.members.runs')}</span>;
    if (orgAutoImport === false) return <span className="text-[var(--text-muted)]">{t('teams_setup.members.auto_import_off')}</span>;
    return <span className="text-[var(--text-muted)]">{t('teams_setup.members.auto_import_member_decides')}</span>;
}

function MemberRow({ row, orgAutoImport }: { row: TeamsMemberRow; orgAutoImport: boolean | null }) {
    const { t } = useTranslation();
    const connected = row.microsoft !== 'none';
    return (
        <tr data-user-id={row.userId}>
            <td className={TD}>
                <span className="font-medium">{row.displayName || row.username || row.userId}</span>
                <span className="mt-0.5 flex flex-wrap gap-1">
                    {!row.meetingNotesAccess && <span className={BADGE}>{t('teams_setup.members.no_access')}</span>}
                    {!row.verifiedMicrosoftIdentity && <span className={BADGE}>{t('teams_setup.members.no_identity')}</span>}
                    {row.appImportCovered && <span className={COVERED_BADGE}>{t('teams_setup.members.app_import_covered')}</span>}
                </span>
            </td>
            <td className={`${TD} ${CONNECTION_INK[row.microsoft] ?? CONNECTION_INK.none}`}>{connectionText(t, row.microsoft)}</td>
            <td className={TD}>
                {connected && (row.missingPermissions.length > 0
                    ? <span className="font-mono text-[11px] text-[var(--warning-ink)]">{row.missingPermissions.join(', ')}</span>
                    : <span className="text-[var(--text-muted)]">{t('teams_setup.members.none')}</span>)}
            </td>
            <td className={TD}>
                {row.autoImportSkip
                    ? <span className="text-[var(--warning-ink)]">{skipText(t, row.autoImportSkip.reason, row.autoImportSkip.missingPermissions)}</span>
                    : <AutoImportCell row={row} orgAutoImport={orgAutoImport} />}
            </td>
            <td className={TD}>
                {row.failures.length === 0
                    ? <span className="text-[var(--text-muted)]">{t('teams_setup.members.none')}</span>
                    : (
                        <ul className="flex flex-col gap-0.5">
                            {row.failures.map((f) => <li key={f.code}>{failureText(t, f.code)} ({f.count})</li>)}
                        </ul>
                    )}
            </td>
        </tr>
    );
}

/**
 * For the organisation admin: per member whether Microsoft 365 is connected, which Teams
 * permissions are missing, whether automatic import runs or was skipped and why, and the
 * failed imports in the chosen window (GET /api/teams-setup/org/overview). Built from what
 * Bee Flow stored; nothing is asked of Microsoft and no meeting is shown. The org checks
 * (consent link, recorded admin consent) come with it.
 */
export default function TeamsMembersOverview() {
    const { t } = useTranslation();
    const [days, setDays] = useState<number>(7);
    const overview = useTeamsOrgOverview(days);
    const data = overview.data;

    return (
        <section className="flex flex-col gap-3" aria-labelledby="teams-members-title" data-testid="teams-members-overview">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                    <h4 id="teams-members-title" className="text-[13px] font-semibold text-[var(--text-primary)]">{t('teams_setup.members.title')}</h4>
                    <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.members.intro')}</p>
                </div>
                <select
                    value={days} onChange={(e) => setDays(Number(e.target.value))}
                    aria-label={t('teams_setup.members.col_failures')}
                    className="px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
                >
                    {WINDOWS.map((d) => <option key={d} value={d}>{t('teams_setup.members.window', { days: d })}</option>)}
                </select>
            </div>

            {overview.isLoading && (
                <div className="flex items-center gap-2 px-4 py-3 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-subtle)]">
                    <Loader2 className="w-4 h-4 animate-spin text-[var(--accent-secondary)]" aria-hidden="true" />
                    <span className="text-[13px] text-[var(--text-muted)]">{t('common.loading', 'Loading…')}</span>
                </div>
            )}
            {overview.isError && (
                <p role="alert" className="px-4 py-3 rounded-xl border text-[13px] bg-[var(--bg-secondary)] border-[var(--border-subtle)] text-[var(--error-ink)]">
                    {t('teams_setup.members.load_failed')}
                </p>
            )}

            {data && (
                <>
                    {data.checks.length > 0 && <DiagnosticsChecklist checks={data.checks} />}
                    <p className="text-[12px] text-[var(--text-secondary)]" data-testid="teams-members-totals">
                        {t('teams_setup.members.totals', {
                            connected: data.totals.connected, members: data.totals.members, missing: data.totals.missingPermissions,
                            expired: data.totals.needsReauth, skipped: data.totals.skipped, failed: data.totals.failedImports,
                        })}
                    </p>
                    {data.truncated && (
                        <p className="text-[12px] text-[var(--warning-ink)]">{t('teams_setup.members.truncated', { count: data.members.length })}</p>
                    )}
                    {data.members.length === 0 ? (
                        <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.members.empty')}</p>
                    ) : (
                        <div className="overflow-x-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                            <table className="w-full min-w-[640px] divide-y divide-[var(--border-subtle)]">
                                <thead>
                                    <tr>
                                        <th scope="col" className={TH}>{t('teams_setup.members.col_member')}</th>
                                        <th scope="col" className={TH}>{t('teams_setup.members.col_connection')}</th>
                                        <th scope="col" className={TH}>{t('teams_setup.members.col_permissions')}</th>
                                        <th scope="col" className={TH}>{t('teams_setup.members.col_auto_import')}</th>
                                        <th scope="col" className={TH}>{t('teams_setup.members.col_failures')}</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[var(--border-subtle)]">
                                    {data.members.map((row) => <MemberRow key={row.userId} row={row} orgAutoImport={data.settings?.autoImport ?? null} />)}
                                </tbody>
                            </table>
                        </div>
                    )}
                </>
            )}
        </section>
    );
}

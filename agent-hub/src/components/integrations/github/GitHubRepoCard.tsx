import { GitBranch, Settings, Unlink, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { CHIP, CHIP_SUCCESS } from '@/components/shared/adminUi';
import type { GitHubSyncConfig, GitHubSyncOverview } from './githubSync.types';

interface GitHubRepoCardProps {
    config: GitHubSyncConfig;
    overview: GitHubSyncOverview | null | undefined;
    /** Editing checks the repository with the viewer's own GitHub token; false without one. */
    canEdit?: boolean;
    onEdit: () => void;
    onDisconnect: () => void;
}

const ICON_BTN = 'p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent';

/** The connected repository with its edit and disconnect buttons and the sync counters. */
export function GitHubRepoCard({ config, overview, canEdit = true, onEdit, onDisconnect }: GitHubRepoCardProps) {
    const { t } = useTranslation();
    const stats = overview ? [
        { label: t('admin_connections.gh_stat_synced', 'Synced'), value: overview.synced, tone: 'text-[var(--success-ink)]' },
        { label: t('admin_connections.gh_stat_pending', 'Pending'), value: overview.pending, tone: 'text-[var(--warning-ink)]' },
        { label: t('admin_connections.gh_stat_errors', 'Errors'), value: overview.error, tone: 'text-[var(--error-ink)]' },
        { label: t('admin_connections.gh_stat_total', 'Total'), value: overview.total, tone: 'text-[var(--text-secondary)]' },
    ] : [];
    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
            <div className="p-5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-4 min-w-0">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0 bg-[var(--bg-tertiary)]">
                        <GitBranch className="w-5 h-5 text-[var(--text-secondary)]" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="m-0 text-sm font-semibold text-[var(--text-primary)] truncate">
                                {config.repoOwner}/{config.repoName}
                            </h3>
                            <span className={CHIP_SUCCESS}>{t('integ.git_hub_sync_connected', 'Connected')}</span>
                        </div>
                        <p className="m-0 text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-1.5">
                            <GitBranch className="w-3 h-3" aria-hidden="true" />
                            {config.branch}
                            {config.autoSync && <span className={`${CHIP} ml-1`}>{t('integ.git_hub_sync_auto_sync_2', 'auto-sync')}</span>}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <a
                        href={`https://github.com/${config.repoOwner}/${config.repoName}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={ICON_BTN}
                        title={t('integ.git_hub_sync_open_in_github', 'Open in GitHub')}
                        aria-label={t('integ.git_hub_sync_open_in_github', 'Open in GitHub')}
                    >
                        <ExternalLink className="w-4 h-4" aria-hidden="true" />
                    </a>
                    <button
                        type="button"
                        onClick={onEdit}
                        disabled={!canEdit}
                        className={ICON_BTN}
                        title={t('integ.git_hub_sync_edit_configuration', 'Edit configuration')}
                        aria-label={t('integ.git_hub_sync_edit_configuration', 'Edit configuration')}
                    >
                        <Settings className="w-4 h-4" aria-hidden="true" />
                    </button>
                    <button
                        type="button"
                        onClick={onDisconnect}
                        className="p-2 rounded-lg text-[var(--text-muted)] hover:text-[var(--error-ink)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] transition-colors"
                        title={t('integ.git_hub_sync_disconnect', 'Disconnect')}
                        aria-label={t('integ.git_hub_sync_disconnect', 'Disconnect')}
                    >
                        <Unlink className="w-4 h-4" aria-hidden="true" />
                    </button>
                </div>
            </div>

            {stats.length > 0 && (
                <div className="grid grid-cols-4 divide-x divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                    {stats.map(s => (
                        <div key={s.label} className="p-3.5 text-center">
                            <div className="text-lg font-bold text-[var(--text-primary)]">{s.value}</div>
                            <div className={`text-[10px] uppercase tracking-wider mt-0.5 ${s.tone}`}>{s.label}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

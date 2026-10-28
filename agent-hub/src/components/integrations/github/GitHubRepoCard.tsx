import { GitBranch, Settings, Unlink, ExternalLink } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { GitHubSyncConfig, GitHubSyncOverview } from './githubSync.types';

interface GitHubRepoCardProps {
    config: GitHubSyncConfig;
    overview: GitHubSyncOverview | null | undefined;
    onEdit: () => void;
    onDisconnect: () => void;
}

/** The connected repository with its edit and disconnect buttons and the sync counters. */
export function GitHubRepoCard({ config, overview, onEdit, onDisconnect }: GitHubRepoCardProps) {
    const { t } = useTranslation();
    return (
        <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <div className="p-5 flex items-center justify-between [background:var(--brand-gradient-soft)]">
                <div className="flex items-center gap-4">
                    <div className="w-11 h-11 rounded-xl flex items-center justify-center [background:var(--brand-gradient)]">
                        <GitBranch className="w-5 h-5 text-white" />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-[var(--text-primary)]">
                                {config.repoOwner}/{config.repoName}
                            </h3>
                            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-green-500/15 text-green-500">{t('integ.git_hub_sync_connected', 'Connected')}</span>
                        </div>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-1.5">
                            <GitBranch className="w-3 h-3" />
                            {config.branch}
                            {config.autoSync && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-primary)]/10 text-[var(--accent-primary)] font-medium ml-1">{t('integ.git_hub_sync_auto_sync_2', 'auto-sync')}</span>
                            )}
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <a
                        href={`https://github.com/${config.repoOwner}/${config.repoName}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-2 rounded-lg hover:bg-white/10 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        title={t('integ.git_hub_sync_open_in_github', 'Open in GitHub')}
                    >
                        <ExternalLink className="w-4 h-4" />
                    </a>
                    <button
                        onClick={onEdit}
                        className="p-2 rounded-lg hover:bg-white/10 text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
                        title={t('integ.git_hub_sync_edit_configuration', 'Edit configuration')}
                    >
                        <Settings className="w-4 h-4" />
                    </button>
                    <button
                        onClick={onDisconnect}
                        className="p-2 rounded-lg hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors"
                        title={t('integ.git_hub_sync_disconnect', 'Disconnect')}
                    >
                        <Unlink className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {/* Sync Overview Stats */}
            {overview && (
                <div className="grid grid-cols-4 divide-x divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                    {[
                        { label: 'Synced', value: overview.synced, color: '#10b981' },
                        { label: 'Pending', value: overview.pending, color: '#f59e0b' },
                        { label: 'Errors', value: overview.error, color: '#ef4444' },
                        { label: 'Total', value: overview.total, color: 'var(--text-secondary)' },
                    ].map(s => (
                        <div key={s.label} className="p-3.5 text-center">
                            <div className="text-lg font-bold text-[var(--text-primary)]">{s.value}</div>
                            <div className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: s.color }}>{s.label}</div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

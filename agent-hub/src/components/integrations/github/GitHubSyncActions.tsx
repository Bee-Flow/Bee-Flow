import { RefreshCw, Upload, Clock, Loader2, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { GitHubSyncOverview } from './githubSync.types';

interface GitHubSyncActionsProps {
    syncing: boolean;
    overview: GitHubSyncOverview | null | undefined;
    lastFullSync: string | null | undefined;
    showDetails: boolean;
    onPushAll: () => void;
    onPushPending: () => void;
    onToggleDetails: () => void;
}

/** Push buttons, the last full sync and the toggle for the detailed sync states. */
export function GitHubSyncActions({ syncing, overview, lastFullSync, showDetails, onPushAll, onPushPending, onToggleDetails }: GitHubSyncActionsProps) {
    const { t } = useTranslation();
    return (
        <>
            {/* Action Buttons */}
            <div className="flex gap-3">
                <button
                    onClick={onPushAll}
                    disabled={syncing}
                    className="flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 disabled:opacity-50 [background:var(--brand-gradient)]"
                >
                    {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                    {t('integ.git_hub_sync_push_all_to_github', 'Push All to GitHub')}
                </button>
                {overview && overview.pending > 0 && (
                    <button
                        onClick={onPushPending}
                        disabled={syncing}
                        className="flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold border transition-all hover:bg-[var(--bg-tertiary)] disabled:opacity-50 border-[var(--border-default)] text-[var(--text-primary)]"
                    >
                        {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                        {t('integ.git_hub_sync_push_pending_pending', 'Push {pending} Pending', { pending: overview.pending })}
                    </button>
                )}
            </div>

            {/* Last Sync Info */}
            {lastFullSync && (
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <Clock className="w-3.5 h-3.5" />
                    {t('integ.git_hub_sync_last_full_sync', 'Last full sync: {when}', { when: new Date(lastFullSync).toLocaleString() })}
                </div>
            )}

            {/* Details toggle */}
            <button
                onClick={onToggleDetails}
                className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--accent-primary)] transition-colors"
            >
                <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showDetails ? 'rotate-90' : ''}`} />
                {showDetails ? 'Hide' : 'Show'} {t('integ.git_hub_sync_sync_details', 'sync details')}
            </button>
        </>
    );
}

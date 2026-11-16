import { RefreshCw, Upload, Clock, ChevronRight } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/shared/Button';
import type { GitHubSyncOverview } from './githubSync.types';

interface GitHubSyncActionsProps {
    syncing: boolean;
    /** The viewer has a GitHub account of their own linked; the server pushes with it. */
    canPush?: boolean;
    overview: GitHubSyncOverview | null | undefined;
    lastFullSync: string | null | undefined;
    showDetails: boolean;
    onPushAll: () => void;
    onPushPending: () => void;
    onToggleDetails: () => void;
}

/** Push buttons, the last full sync and the toggle for the detailed sync states. */
export function GitHubSyncActions({ syncing, canPush = true, overview, lastFullSync, showDetails, onPushAll, onPushPending, onToggleDetails }: GitHubSyncActionsProps) {
    const { t } = useTranslation();
    return (
        <>
            <div className="flex flex-wrap gap-3">
                <Button variant="primary" icon={Upload} busy={syncing} disabled={!canPush} onClick={onPushAll} className="flex-1">
                    {t('integ.git_hub_sync_push_all_to_github', 'Push All to GitHub')}
                </Button>
                {overview && overview.pending > 0 && (
                    <Button variant="secondary" icon={RefreshCw} busy={syncing} disabled={!canPush} onClick={onPushPending}>
                        {t('integ.git_hub_sync_push_pending_pending', 'Push {pending} Pending', { pending: overview.pending })}
                    </Button>
                )}
            </div>

            {lastFullSync && (
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('integ.git_hub_sync_last_full_sync', 'Last full sync: {when}', { when: new Date(lastFullSync).toLocaleString() })}
                </div>
            )}

            <button
                type="button"
                onClick={onToggleDetails}
                aria-expanded={showDetails}
                className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
                <ChevronRight className={`w-3.5 h-3.5 transition-transform ${showDetails ? 'rotate-90' : ''}`} aria-hidden="true" />
                {showDetails ? t('admin_connections.gh_hide_details', 'Hide sync details') : t('admin_connections.gh_show_details', 'Show sync details')}
            </button>
        </>
    );
}

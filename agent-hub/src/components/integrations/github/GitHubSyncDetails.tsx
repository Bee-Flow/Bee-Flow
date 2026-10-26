import { Bot, Sparkles } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { GitHubSyncDetail } from './githubSync.types';

/** The per-resource sync states, newest sync info and any error message. */
export function GitHubSyncDetails({ details }: { details: GitHubSyncDetail[] }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <div className="max-h-72 overflow-y-auto">
                {details.length === 0 ? (
                    <p className="p-4 text-sm text-[var(--text-muted)] text-center">{t('integ.git_hub_sync_no_sync_data_yet_push_to_github_to_get', 'No sync data yet. Push to GitHub to get started.')}</p>
                ) : details.map(item => (
                    <div key={item.id} className="px-4 py-2.5 border-b border-[var(--border-subtle)] last:border-0">
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5 min-w-0">
                                {item.resource_type === 'agent'
                                    ? <Bot className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0" />
                                    : <Sparkles className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0" />
                                }
                                <div className="min-w-0">
                                    <span className="text-xs font-medium text-[var(--text-primary)] truncate block">
                                        {item.resource_type}/{item.resource_id.substring(0, 8)}
                                    </span>
                                    {item.last_synced_at && (
                                        <span className="text-[10px] text-[var(--text-muted)]">
                                            {new Date(item.last_synced_at).toLocaleString()}
                                        </span>
                                    )}
                                </div>
                            </div>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full font-semibold flex-shrink-0 ${item.sync_status === 'synced' ? 'bg-green-500/15 text-green-500'
                                : item.sync_status === 'pending' ? 'bg-amber-500/15 text-amber-500'
                                    : item.sync_status === 'error' ? 'bg-red-500/15 text-red-500'
                                        : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'
                                }`}>
                                {item.sync_status}
                            </span>
                        </div>
                        {item.sync_status === 'error' && item.error_message && (
                            <p className="mt-1.5 ml-6 text-[10px] text-red-500/90 break-words">
                                {item.error_message}
                            </p>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

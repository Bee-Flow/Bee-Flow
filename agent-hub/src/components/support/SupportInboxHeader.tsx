import { BarChart3, Inbox, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import SegmentedControl from '../shared/SegmentedControl';
import IconButton from '../shared/IconButton';

interface SupportInboxHeaderProps {
    activeTotal: number;
    resolved: number;
    view: string;
    setView: (view: string) => void;
    loading: boolean;
    onRefresh: () => void;
}

/**
 * The bar above the inbox: the counters, the view switch (Inbox, Settings,
 * Insights) and the refresh button. The page's name is the dashboard's (the
 * rail row "Support inbox"), so the bar draws no title of its own.
 */
export default function SupportInboxHeader({ activeTotal, resolved, view, setView, loading, onRefresh }: SupportInboxHeaderProps) {
    const { t } = useTranslation();
    const views = [
        { value: 'inbox', label: t('support.support_inbox_inbox', 'Inbox'), icon: <Inbox className="h-3.5 w-3.5" aria-hidden="true" /> },
        { value: 'settings', label: t('support.inbox_view_settings', 'Settings'), icon: <SettingsIcon className="h-3.5 w-3.5" aria-hidden="true" /> },
        { value: 'insights', label: t('support.ai_config_tab_insights', 'Insights'), icon: <BarChart3 className="h-3.5 w-3.5" aria-hidden="true" /> },
    ];
    return (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-3 md:px-6">
            <p className="m-0 text-sm text-[var(--text-secondary)]">
                {t('support.support_inbox_active_counter_resolved', '{active} active · {resolved} resolved', { active: activeTotal, resolved })}
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
                <SegmentedControl size="sm" value={view} onChange={setView} options={views} ariaLabel={t('support.inbox_views', 'Support views')} />
                {view === 'inbox' && (
                    <IconButton onClick={onRefresh} ariaLabel={t('support.support_inbox_refresh', 'Refresh')}>
                        <RefreshCw className={loading ? 'animate-spin' : ''} />
                    </IconButton>
                )}
            </div>
        </div>
    );
}

import { Inbox, RefreshCw, Settings as SettingsIcon, Link2 } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import SectionHeader from '../shared/SectionHeader';
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

/** The inbox title with its counters, the view switch and the refresh button. */
export default function SupportInboxHeader({ activeTotal, resolved, view, setView, loading, onRefresh }: SupportInboxHeaderProps) {
    const { t } = useTranslation();
    const views = [
        { value: 'inbox', label: t('support.support_inbox_inbox', 'Inbox'), icon: <Inbox className="h-3.5 w-3.5" aria-hidden="true" /> },
        { value: 'ai-config', label: t('support.support_inbox_ai_configuration', 'AI configuration'), icon: <SettingsIcon className="h-3.5 w-3.5" aria-hidden="true" /> },
        { value: 'connections', label: t('support.support_inbox_connections', 'Connections'), icon: <Link2 className="h-3.5 w-3.5" aria-hidden="true" /> },
    ];
    return (
        <div className="shrink-0 border-b border-[var(--border-default)] px-6 py-4">
            <SectionHeader
                title={t('support.support_inbox_customer_support', 'Customer Support')}
                description={t('support.support_inbox_active_counter_resolved', '{active} active · {resolved} resolved', { active: activeTotal, resolved })}
                status={(
                    <div className="flex flex-wrap items-center justify-end gap-2">
                        <SegmentedControl size="sm" value={view} onChange={setView} options={views} ariaLabel={t('support.support_inbox_customer_support', 'Customer Support')} />
                        {view === 'inbox' && (
                            <IconButton onClick={onRefresh} ariaLabel={t('support.support_inbox_refresh', 'Refresh')}>
                                <RefreshCw className={loading ? 'animate-spin' : ''} />
                            </IconButton>
                        )}
                    </div>
                )}
            />
        </div>
    );
}

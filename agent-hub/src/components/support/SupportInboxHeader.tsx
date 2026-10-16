import { Inbox, RefreshCw, Settings as SettingsIcon, Link2 } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';

interface SupportInboxHeaderProps {
    activeTotal: number;
    resolved: number;
    view: string;
    setView: (view: string) => void;
    loading: boolean;
    onRefresh: () => void;
}

/** The inbox title with its counters, the view tabs and the refresh button. */
export default function SupportInboxHeader({ activeTotal, resolved, view, setView, loading, onRefresh }: SupportInboxHeaderProps) {
    const { t } = useTranslation();
    return (
        <div className="px-6 py-4 border-b flex items-center justify-between border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <div className="flex items-center gap-3">
                <Inbox className="w-5 h-5" style={{ color: 'var(--text-primary)' }} />
                <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('support.support_inbox_customer_support', 'Customer Support')}</h2>
                <span className="text-xs px-2 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                    {t('support.support_inbox_active_counter_resolved', '{active} active · {resolved} resolved', { active: activeTotal, resolved })}
                </span>
            </div>
            <div className="flex items-center gap-2">
                {/* View tabs — Inbox / AI configuration */}
                <div className="flex gap-1 p-1 rounded-md bg-[var(--bg-tertiary)]">
                    <button
                        onClick={() => setView('inbox')}
                        className="px-3 py-1 rounded text-sm font-medium flex items-center gap-1.5"
                        style={{
                            background: view === 'inbox' ? 'var(--accent-primary)' : 'transparent',
                            color: view === 'inbox' ? 'white' : 'var(--text-secondary)',
                        }}
                    >
                        <Inbox className="w-3.5 h-3.5" /> {t('support.support_inbox_inbox', 'Inbox')}
                    </button>
                    <button
                        onClick={() => setView('ai-config')}
                        className="px-3 py-1 rounded text-sm font-medium flex items-center gap-1.5"
                        style={{
                            background: view === 'ai-config' ? 'var(--accent-primary)' : 'transparent',
                            color: view === 'ai-config' ? 'white' : 'var(--text-secondary)',
                        }}
                    >
                        <SettingsIcon className="w-3.5 h-3.5" /> {t('support.support_inbox_ai_configuration', 'AI configuration')}
                    </button>
                    <button
                        onClick={() => setView('connections')}
                        className="px-3 py-1 rounded text-sm font-medium flex items-center gap-1.5"
                        style={{
                            background: view === 'connections' ? 'var(--accent-primary)' : 'transparent',
                            color: view === 'connections' ? 'white' : 'var(--text-secondary)',
                        }}
                    >
                        <Link2 className="w-3.5 h-3.5" /> {t('support.support_inbox_connections', 'Connections')}
                    </button>
                </div>
                {view === 'inbox' && (
                    <button onClick={onRefresh} title={t('support.support_inbox_refresh', 'Refresh')} className="p-2 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                )}
            </div>
        </div>
    );
}

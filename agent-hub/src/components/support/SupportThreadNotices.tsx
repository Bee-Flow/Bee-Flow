import { AlertTriangle, BellRing, ChevronDown, ChevronRight, History } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import { formatRelative } from './supportInboxLabels';
import type { SupportEvent, SupportMessage, SupportThread } from './SupportInboxPanel.types';

export function SupportFollowupBanner({ thread, onClear }: { thread: SupportThread; onClear: () => void }) {
    const { t } = useTranslation();
    if (!thread.followup_needed_at) return null;
    return (
        <div className="px-4 py-2 border-b flex items-center justify-between gap-3 [border-color:var(--border-default)]! [background:rgba(245,158,11,0.10)]">
            <div className="flex items-start gap-2 min-w-0 text-xs">
                <BellRing className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: '#b45309' }} />
                <span className="text-[var(--text-primary)]">
                    <strong>{t('support.support_inbox_needs_a_follow_up', 'Needs a follow-up.')}</strong> {thread.followup_reason}
                    <span className="text-[var(--text-muted)]"> {t('support.support_inbox_the_customer_has_not_been_told', '— the customer has not been told.')}</span>
                </span>
            </div>
            <button onClick={onClear}
                className="px-2 py-1 rounded text-xs border shrink-0 border-[var(--border-default)] text-[var(--text-secondary)]">
                {t('support.support_inbox_mark_followed_up', 'Mark followed up')}
            </button>
        </div>
    );
}

export function SupportEmailFailureBanner({ messages }: { messages: SupportMessage[] }) {
    const { t } = useTranslation();
    const failed = messages.find(m => m.email_send_status && m.email_send_status.ok === false);
    if (!failed) return null;
    const err = failed.email_send_status?.error || 'Unknown error';
    return (
        <div className="px-4 py-2 border-b text-xs flex items-start gap-2 [background:rgba(245,158,11,0.10)] [border-color:rgba(245,158,11,0.35)]! [color:#92400e]!">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div>
                <div className="font-medium">{t('support.support_inbox_outbound_email_failed_for_one_of_the', 'Outbound email failed for one of the messages in this thread.')}</div>
                <div className="opacity-80">{err}</div>
                <div className="opacity-60 mt-0.5">{t('support.support_inbox_check_admin_integrations_email_and', 'Check Admin → Integrations → Email and confirm SMTP credentials are valid.')}</div>
            </div>
        </div>
    );
}

interface SupportActivityLogProps {
    activity: SupportEvent[];
    showActivity: boolean;
    setShowActivity: (update: (open: boolean) => boolean) => void;
}

export function SupportActivityLog({ activity, showActivity, setShowActivity }: SupportActivityLogProps) {
    const { t } = useTranslation();
    return (
        <div className="px-4 py-1.5 border-b border-[var(--border-default)]">
            <button
                onClick={() => setShowActivity(v => !v)}
                className="text-xs flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-muted)]"
            >
                {showActivity ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                <History className="w-3 h-3" /> {t('support.support_inbox_activity_log', 'Activity log')}
                {activity.length > 0 && (
                    <span className="ml-1 px-1.5 py-0 rounded bg-[var(--bg-tertiary)]">{activity.length}</span>
                )}
            </button>
            {showActivity && (
                <div className="mt-2 max-h-40 overflow-y-auto text-xs space-y-1 pl-4 pb-2 text-[var(--text-muted)]">
                    {activity.length === 0 && <div className="opacity-60">{t('support.support_inbox_no_events_recorded_yet', 'No events recorded yet.')}</div>}
                    {activity.map(ev => (
                        <div key={ev.id} className="flex items-baseline gap-2">
                            <span className="[color:var(--text-secondary)] min-w-[84px]">{formatRelative(ev.created_at)}</span>
                            <span><strong>{ev.actor_kind}{ev.actor_user_id ? ` (${ev.actor_user_id.slice(0, 8)})` : ''}</strong> — {ev.action}{ev.payload && Object.keys(ev.payload).length ? `: ${JSON.stringify(ev.payload).slice(0, 120)}` : ''}</span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

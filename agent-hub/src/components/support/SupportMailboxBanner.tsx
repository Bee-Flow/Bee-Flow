import { Mail, Unlink } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import { formatRelative } from './supportInboxLabels';
import type { SupportMailbox } from './SupportInboxPanel.types';

interface SupportMailboxBannerProps {
    mailbox: SupportMailbox;
    disconnecting: boolean;
    onDisconnect: () => void;
}

export default function SupportMailboxBanner({ mailbox, disconnecting, onDisconnect }: SupportMailboxBannerProps) {
    const { t } = useTranslation();
    return (
        <div
            className="px-6 py-3 border-b flex items-center justify-between gap-4 [border-color:var(--border-default)]! [background:rgba(245,158,11,0.08)]"
        >
            <div className="flex items-start gap-3 min-w-0">
                <Mail className="w-4 h-4 mt-0.5 shrink-0 [color:#b45309]" />
                <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                        {t('support.support_inbox_an_email_box_is_feeding_this_inbox', 'An email box is feeding this inbox')}
                    </div>
                    <div className="text-xs mt-0.5 text-[var(--text-secondary)]">
                        {mailbox.count === 1 ? t('support.support_inbox_ticket_one', '{count} ticket here came in over a connected mailbox', { count: 1 }) : t('support.support_inbox_ticket_other', '{count} tickets here came in over a connected mailbox', { count: mailbox.count })}
                        {mailbox.activeCount ? ` (${mailbox.activeCount} still active)` : ''}
                        {mailbox.lastAt ? ` · last message ${formatRelative(mailbox.lastAt)}` : ''}{t('support.support_inbox_disconnecting_removes_them_marketing', '. Disconnecting removes them; marketing-form and in-app tickets stay.')}
                    </div>
                </div>
            </div>
            <button
                onClick={onDisconnect}
                disabled={disconnecting}
                className="px-3 py-1.5 rounded-md text-sm font-medium flex items-center gap-1.5 shrink-0 disabled:opacity-60 [background:#dc2626] [color:white]!"
            >
                <Unlink className="w-3.5 h-3.5" />
                {disconnecting ? 'Disconnecting…' : 'Disconnect mailbox'}
            </button>
        </div>
    );
}

import { Mail, Unlink } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import { formatRelative } from './supportInboxLabels';
import type { SupportMailbox } from './SupportInboxPanel.types';
import { DANGER_BTN } from '../mcpLibrary/ui';

interface SupportMailboxBannerProps {
    mailbox: SupportMailbox;
    disconnecting: boolean;
    onDisconnect: () => void;
}

export default function SupportMailboxBanner({ mailbox, disconnecting, onDisconnect }: SupportMailboxBannerProps) {
    const { t } = useTranslation();
    return (
        <div className="flex shrink-0 items-center justify-between gap-4 flex-wrap border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-4 py-3 md:px-6">
            <div className="flex min-w-0 items-start gap-3">
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning-ink)]" aria-hidden="true" />
                <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                        {t('support.support_inbox_an_email_box_is_feeding_this_inbox', 'An email box is feeding this inbox')}
                    </div>
                    <div className="mt-0.5 text-xs text-[var(--text-secondary)]">
                        {mailbox.count === 1 ? t('support.support_inbox_ticket_one', '{count} ticket here came in over a connected mailbox', { count: 1 }) : t('support.support_inbox_ticket_other', '{count} tickets here came in over a connected mailbox', { count: mailbox.count })}
                        {mailbox.activeCount ? ` ${t('support.mailbox_still_active', '({count} still active)', { count: mailbox.activeCount })}` : ''}
                        {mailbox.lastAt ? ` ${t('support.mailbox_last_message', '· last message {when}', { when: formatRelative(mailbox.lastAt) })}` : ''}{t('support.support_inbox_disconnecting_removes_them_marketing', '. Disconnecting removes them; marketing-form and in-app tickets stay.')}
                    </div>
                </div>
            </div>
            <button type="button" onClick={onDisconnect} disabled={disconnecting} className={`${DANGER_BTN} shrink-0`}>
                <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                {disconnecting ? t('support.inbox_mailbox_disconnecting', 'Disconnecting…') : t('support.inbox_mailbox_disconnect', 'Disconnect mailbox')}
            </button>
        </div>
    );
}

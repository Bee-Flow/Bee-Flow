// The Mailbox card of Settings > Connections: where the inbox's tickets come
// from, and the mailbox tickets that reached it, with the way to cut that
// mailbox loose in the same place the other connections are made. The inbox
// has no mailbox connector of its own (routes/support/mailbox.js): its tickets
// come from the Help button in the app and the website form; mail only lands
// here from a mailbox connected to a support desk elsewhere.

import { Mail, Unlink } from 'lucide-react';
import { useTranslation } from '../../hooks/useTranslation';
import { SettingsGroup } from '@/components/shared/SettingsList';
import useConfirm from '@/components/shared/useConfirm';
import { ALERT_INFO, ALERT_WARNING, DANGER_BTN } from '@/components/shared/adminUi';
import { formatRelative } from './supportInboxLabels';
import { useSupportMailbox } from './useSupportMailbox';

export default function SupportMailboxCard() {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const { mailbox, disconnecting, disconnectMailbox } = useSupportMailbox({ confirm });
    const count = mailbox?.count || 0;
    return (
        <SettingsGroup
            title={<span className="inline-flex items-center gap-2"><Mail className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />{t('support.mailbox_card_title', 'Mailbox')}</span>}
            description={t('support.mailbox_card_desc', 'Tickets reach this inbox from the Help button inside the app and from the contact form on the website. The inbox has no mailbox of its own.')}
        >
            {mailbox?.connected ? (
                <div className={`${ALERT_WARNING} flex-wrap justify-between`} data-testid="support-mailbox-connected">
                    <span className="min-w-0">
                        {count === 1
                            ? t('support.support_inbox_ticket_one', '{count} ticket here came in over a connected mailbox', { count })
                            : t('support.support_inbox_ticket_other', '{count} tickets here came in over a connected mailbox', { count })}
                        {mailbox.lastAt ? ` ${t('support.mailbox_last_message', '· last message {when}', { when: formatRelative(mailbox.lastAt) })}` : ''}
                    </span>
                    <button type="button" onClick={disconnectMailbox} disabled={disconnecting} className={`${DANGER_BTN} shrink-0`}>
                        <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                        {disconnecting ? t('support.inbox_mailbox_disconnecting', 'Disconnecting…') : t('support.inbox_mailbox_disconnect', 'Disconnect mailbox')}
                    </button>
                </div>
            ) : (
                <div className={ALERT_INFO} data-testid="support-mailbox-none">
                    {t('support.mailbox_card_none', 'No mailbox is feeding this inbox.')}
                </div>
            )}
            {confirmDialog}
        </SettingsGroup>
    );
}

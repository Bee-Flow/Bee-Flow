import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supportInboxKeys, useSupportMailboxQuery } from '../../api/queries/supportInbox';
import { supportInboxApi } from '../../api/supportInboxApi';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';
import { toast } from '../shared/Toast';
import type useConfirm from '../shared/useConfirm';
import type { SupportMailbox } from './SupportInboxPanel.types';

interface MailboxDeps {
    confirm: ReturnType<typeof useConfirm>['confirm'];
    /** The inbox's open ticket, cleared once its mailbox tickets are gone. */
    setSelectedId?: (id: string | null) => void;
}

/** The mailbox feeding the inbox, and the way out of it. */
export function useSupportMailbox({ confirm, setSelectedId }: MailboxDeps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    // Mailbox feeding this inbox. The company inbox has no connector of its own,
    // so anything here arrived from a Support-studio mailbox — see
    // GET /api/support/mailbox.
    const mailboxQuery = useSupportMailboxQuery<SupportMailbox>();
    const mailbox = mailboxQuery.data ?? null;
    const [disconnecting, setDisconnecting] = useState(false);
    const { refetch } = mailboxQuery;
    const fetchMailbox = useCallback(async () => { await refetch(); }, [refetch]);

    // Unlink the mailbox and delete every ticket it produced. Destructive and
    // unrecoverable, so it asks twice with the exact count.
    const disconnectMailbox = async () => {
        const n = mailbox?.count || 0;
        const ok = await confirm({
            title: t('support.mailbox_disconnect_title', 'Disconnect the mailbox from the support inbox?'),
            description: n === 1
                ? t('support.mailbox_disconnect_desc_one', '{count} ticket that came in over that mailbox will be permanently deleted, together with its messages and history. Tickets from the website form and from inside the app are untouched. This cannot be undone.', { count: n })
                : t('support.mailbox_disconnect_desc_other', '{count} tickets that came in over that mailbox will be permanently deleted, together with their messages and history. Tickets from the website form and from inside the app are untouched. This cannot be undone.', { count: n }),
            confirmLabel: t('support.mailbox_disconnect_confirm', 'Disconnect'),
            destructive: true,
        });
        if (!ok) return;
        setDisconnecting(true);
        try {
            const res = await supportInboxApi.disconnectMailbox();
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(data.error || t('support.mailbox_disconnect_failed', 'Disconnecting the mailbox failed.'));
                return;
            }
            setSelectedId?.(null);
            // Every read of the inbox: the mailbox, and the ticket lists and
            // tickets of every filter, wherever the disconnect was asked from
            // (the inbox's banner, or the Mailbox card under Settings while
            // the inbox's list stays mounted).
            await queryClient.invalidateQueries({ queryKey: supportInboxKeys.all });
        } catch (e) {
            toast.error(t('support.mailbox_disconnect_failed_detail', 'Disconnecting the mailbox failed: {error}', { error: errorMessage(e) }));
        } finally {
            setDisconnecting(false);
        }
    };

    return { mailbox, disconnecting, fetchMailbox, disconnectMailbox };
}

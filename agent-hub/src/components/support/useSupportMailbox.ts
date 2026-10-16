import { useCallback, useEffect, useState } from 'react';
import { supportInboxApi } from '../../api/supportInboxApi';
import { errorMessage } from '../../utils/caughtError';
import { toast } from '../shared/Toast';
import type useConfirm from '../shared/useConfirm';
import type { SupportMailbox } from './SupportInboxPanel.types';

interface MailboxDeps {
    confirm: ReturnType<typeof useConfirm>['confirm'];
    setSelectedId: (id: string | null) => void;
    fetchThreads: () => Promise<void>;
}

/** The mailbox feeding the inbox, and the way out of it. */
export function useSupportMailbox({ confirm, setSelectedId, fetchThreads }: MailboxDeps) {
    // Mailbox feeding this inbox. The company inbox has no connector of its own,
    // so anything here arrived from a Support-studio mailbox — see
    // GET /api/support/mailbox.
    const [mailbox, setMailbox] = useState<SupportMailbox | null>(null);
    const [disconnecting, setDisconnecting] = useState(false);

    const fetchMailbox = useCallback(async () => {
        try {
            const res = await supportInboxApi.mailbox();
            if (res.ok) {
                const data = await res.json();
                setMailbox(data.mailbox || null);
            }
        } catch (e) {
            console.warn('[Support] fetchMailbox:', errorMessage(e));
        }
    }, []);

    useEffect(() => { fetchMailbox(); }, [fetchMailbox]);

    // Unlink the mailbox and delete every ticket it produced. Destructive and
    // unrecoverable, so it asks twice with the exact count.
    const disconnectMailbox = async () => {
        const n = mailbox?.count || 0;
        const ok = await confirm({
            title: 'Disconnect the email box from Customer Support?',
            description: `${n} ticket${n === 1 ? '' : 's'} that came in over that mailbox will be permanently deleted, `
                + 'together with their messages and history. Tickets from the marketing form and from inside the app are untouched. '
                + 'This cannot be undone.',
            confirmLabel: 'Disconnect',
            destructive: true,
        });
        if (!ok) return;
        setDisconnecting(true);
        try {
            const res = await supportInboxApi.disconnectMailbox();
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(data.error || 'Disconnecting the mailbox failed.');
                return;
            }
            setSelectedId(null);
            await Promise.all([fetchMailbox(), fetchThreads()]);
        } catch (e) {
            toast.error(`Disconnecting the mailbox failed: ${errorMessage(e)}`);
        } finally {
            setDisconnecting(false);
        }
    };

    return { mailbox, disconnecting, fetchMailbox, disconnectMailbox };
}

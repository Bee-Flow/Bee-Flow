import { useState, useEffect, useRef, useCallback } from 'react';
import { IconTrigger, NotificationStyles, ResultModal, RowTrigger } from './notifications/NotificationChrome';
import type { ResultModalData } from './notifications/NotificationChrome';
import NotificationPanel from './notifications/NotificationPanel';
import type { NotifFilter } from './notifications/NotificationPanel';
import { isResult } from './notifications/NotificationRow';
import type { NotificationRowActions } from './notifications/NotificationRow';
import { resolveChatTarget, startReconnect, useNotifications } from './notifications/useNotifications';
import type { AppNotification } from './notifications/useNotifications';
import useOutsideDismiss from '../../hooks/useOutsideDismiss';
import { useViewport } from '../../hooks/useViewport';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

/** Hand a finished run to the chat surface, on the thread it belongs to. */
async function continueInChat(n: AppNotification | null | undefined, title: string | undefined, content: string) {
    const { agentId, conversationId } = await resolveChatTarget(n);
    window.dispatchEvent(new CustomEvent('openDirectChatWithContext', {
        detail: { title, content, agentId, conversationId, surface: n?.category === 'cowork' ? 'cowork' : 'automation' },
    }));
}

/**
 * Notifications panel: trigger + inbox popover.
 *
 * Two variants:
 *  - 'row'  (default): full-width sidebar-style row with icon + label + badge.
 *                      Popover floats above the trigger.
 *  - 'icon'           : compact icon-only button (badge overlaid). Popover
 *                       drops downward from the trigger. Use this when the
 *                       trigger sits in a top bar.
 *
 * The inbox itself lives in notifications/: the data in useNotifications.ts,
 * the popover in NotificationPanel.tsx, one row in NotificationRow.tsx.
 */
export default function NotificationCenter({ variant = 'row' }: { variant?: 'row' | 'icon' } = {}) {
    const { isMobile } = useViewport();
    const [open, setOpen] = useState(false);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [notifFilter, setNotifFilter] = useState<NotifFilter>('all');
    const [resultModal, setResultModal] = useState<ResultModalData | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const inbox = useNotifications();
    const { notifications, fetchNotifications, markRead } = inbox;

    useAdjustOnChange([open], () => { if (open) setExpandedId(null); });
    useEffect(() => {
        if (open) fetchNotifications();
    }, [open, fetchNotifications]);

    useOutsideDismiss(panelRef, () => setOpen(false), { enabled: open, escape: false, defer: false });

    const openInDirectChat = useCallback(async (title: string | undefined, content: string, notifId?: string) => {
        setResultModal(null);
        const n = notifId ? notifications.find(x => x.id === notifId) : null;
        await continueInChat(n, title, content);
    }, [notifications]);

    const actions = rowActions({ markRead, setOpen, expandedId, setExpandedId, deleteNotification: inbox.deleteNotification, openInDirectChat });
    const isIcon = variant === 'icon';
    const Trigger = isIcon ? IconTrigger : RowTrigger;

    return (
        <div ref={panelRef} className="[position:relative]">
            <Trigger open={open} unreadCount={inbox.unreadCount} onToggle={() => setOpen(o => !o)} />

            {/* Dropdown panel */}
            {open && (
                <NotificationPanel
                    isMobile={isMobile}
                    isIcon={isIcon}
                    notifications={notifications}
                    unreadCount={inbox.unreadCount}
                    loading={inbox.loading}
                    filter={notifFilter}
                    setFilter={setNotifFilter}
                    onMarkAllRead={inbox.markAllRead}
                    expandedId={expandedId}
                    actions={actions}
                />
            )}

            {/* AI Task Result Modal (still surfaced from notifications) */}
            {resultModal && (
                <ResultModal
                    modal={resultModal}
                    onClose={() => setResultModal(null)}
                    onDiscuss={() => openInDirectChat(resultModal.title, resultModal.content, resultModal.notifId)}
                />
            )}

            <NotificationStyles />
        </div>
    );
}

/** What the rows can do, wired to the inbox and the panel's open/expanded state. */
function rowActions({ markRead, setOpen, expandedId, setExpandedId, deleteNotification, openInDirectChat }: {
    markRead: (id: string) => Promise<void>;
    setOpen: (open: boolean) => void;
    expandedId: string | null;
    setExpandedId: (id: string | null) => void;
    deleteNotification: (id: string) => Promise<void>;
    openInDirectChat: (title: string | undefined, content: string, notifId?: string) => Promise<void>;
}): NotificationRowActions {
    const toggleExpand = (n: AppNotification) => {
        if (expandedId === n.id) {
            setExpandedId(null);
        } else {
            setExpandedId(n.id);
            if (!n.read) markRead(n.id);
        }
    };

    // Notifications that carry an in-app `link` (e.g. support replies)
    // deep-link to the relevant screen, through the same history + popstate
    // path the app already uses to open overlays from the URL.
    const navigateToLink = (n: AppNotification) => {
        if (!n?.link) return;
        if (!n.read) markRead(n.id);
        setOpen(false);
        try {
            window.history.pushState({ page: 'settings' }, '', n.link);
            window.dispatchEvent(new PopStateEvent('popstate'));
        } catch (_) {
            window.location.assign(n.link);
        }
    };

    return {
        // A link-bearing notification IS its destination — an approval
        // request, a support reply. One click goes there; expand-then-Open
        // was two clicks for the only action anyone takes. Results
        // (ai_task/cowork) keep expanding: their payload is the message.
        onActivate: (n) => (n.link && !isResult(n) ? navigateToLink(n) : toggleExpand(n)),
        onDelete: async (id) => {
            await deleteNotification(id);
            if (expandedId === id) setExpandedId(null);
        },
        onNavigateLink: navigateToLink,
        // The one action on a finished run: continue it in the right chat.
        onOpenResultInChat: async (n, body) => {
            if (!n.read) markRead(n.id);
            setOpen(false);
            await continueInChat(n, n.title, body);
        },
        onOpenInDirectChat: (title, content, notifId) => { openInDirectChat(title, content, notifId); },
        onReconnect: (provider) => { startReconnect(provider); },
    };
}

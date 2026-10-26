import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SupportEvent, SupportMessage, SupportThread } from './SupportInboxPanel.types';
import { supportInboxKeys, useSupportEventsQuery, useSupportThreadQuery } from '../../api/queries/supportInbox';

const NO_MESSAGES: SupportMessage[] = [];
const NO_EVENTS: SupportEvent[] = [];

/** The open thread with its messages and its activity log; opening another thread starts from the thread itself. */
export function useSupportSelectedThread(selectedId: string | null) {
    const queryClient = useQueryClient();
    const threadQuery = useSupportThreadQuery<SupportThread, SupportMessage>(selectedId);
    // The activity panel is open for one thread; another selection closes it.
    const [activityFor, setActivityFor] = useState<string | null>(null);
    const showActivity = !!selectedId && activityFor === selectedId;
    const setShowActivity = useCallback(
        (update: (open: boolean) => boolean) => setActivityFor(update(showActivity) ? selectedId : null),
        [selectedId, showActivity],
    );
    const eventsQuery = useSupportEventsQuery<SupportEvent>(selectedId, showActivity);

    // Re-read one thread (after a reply, an edit, or a server event about it).
    const fetchThread = useCallback(async (id: string | null) => {
        if (id) await queryClient.invalidateQueries({ queryKey: supportInboxKeys.thread(id) });
    }, [queryClient]);

    return {
        thread: selectedId ? threadQuery.data?.thread ?? null : null,
        messages: selectedId ? threadQuery.data?.messages ?? NO_MESSAGES : NO_MESSAGES,
        fetchThread, showActivity, setShowActivity,
        activity: showActivity ? eventsQuery.data ?? NO_EVENTS : NO_EVENTS,
    };
}

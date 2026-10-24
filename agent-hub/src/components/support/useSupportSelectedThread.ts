import { useCallback, useEffect, useState } from 'react';
import { supportInboxApi } from '../../api/supportInboxApi';
import { errorMessage } from '../../utils/caughtError';
import type { SupportEvent, SupportMessage, SupportThread } from './SupportInboxPanel.types';
import { logger } from '../../utils/logger';

/** The open thread with its messages and its activity log, reloaded whenever the selection changes. */
export function useSupportSelectedThread(selectedId: string | null) {
    const [thread, setThread] = useState<SupportThread | null>(null);
    const [messages, setMessages] = useState<SupportMessage[]>([]);
    const [showActivity, setShowActivity] = useState(false);
    const [activity, setActivity] = useState<SupportEvent[]>([]);

    const fetchThread = useCallback(async (id: string | null) => {
        if (!id) return;
        try {
            const res = await supportInboxApi.thread(id);
            if (res.ok) {
                const data = await res.json();
                setThread(data.thread);
                setMessages(data.messages || []);
            }
        } catch (e) {
            console.warn('[Support] fetchThread:', errorMessage(e));
        }
    }, []);

    useEffect(() => {
        if (selectedId) fetchThread(selectedId);
        else { setThread(null); setMessages([]); }
        setShowActivity(false);
        setActivity([]);
    }, [selectedId, fetchThread]);

    const fetchActivity = useCallback(async () => {
        if (!selectedId) return;
        try {
            const res = await supportInboxApi.events(selectedId);
            if (res.ok) {
                const data = await res.json();
                setActivity(Array.isArray(data?.events) ? data.events : []);
            }
        } catch (err) { logger.warn('thread activity load failed', err); }
    }, [selectedId]);

    useEffect(() => {
        if (showActivity && selectedId) fetchActivity();
    }, [showActivity, selectedId, fetchActivity]);

    return { thread, messages, fetchThread, showActivity, setShowActivity, activity };
}

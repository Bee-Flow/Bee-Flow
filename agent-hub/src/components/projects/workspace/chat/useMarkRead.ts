// Keeps the server's read marker at the newest message, but only while the
// reader can actually have seen it: the tab is visible AND the list is
// scrolled to its newest end. Someone reading history 200 messages up has not
// seen what arrived below, so the chat stays unread until they get there.

import { useEffect, useRef, useState } from 'react';
import { newestSeq, useMarkTeamChatRead, useTeamChatMessages } from '../../../../api/queries/projectChats';

export default function useMarkRead(projectId: string, chatId: string, atBottom = true) {
    const { data } = useTeamChatMessages(projectId, chatId);
    const { mutate } = useMarkTeamChatRead(projectId, chatId);
    const marked = useRef(0);
    const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
    const seq = newestSeq(data?.messages || []);
    useEffect(() => {
        const onChange = () => setVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', onChange);
        return () => document.removeEventListener('visibilitychange', onChange);
    }, []);
    useEffect(() => {
        if (!visible || !atBottom || !seq || seq <= marked.current) return;
        marked.current = seq;
        mutate(seq);
    }, [visible, atBottom, seq, mutate]);
}

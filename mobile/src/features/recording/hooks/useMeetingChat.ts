/**
 * The state of "Ask about this meeting": the thread, the draft, the error and
 * the stream. Nothing is persisted — the thread is gone when the sheet closes.
 *
 * This does NOT go through the persisted chat's hook: its payload has no
 * `systemPrompt`, which is exactly the field this needs.
 * `POST /ai/chat/direct/stream` accepts `systemPrompt` and prepends it
 * (promptAssembly.js), the same mechanism the web's meeting assistant uses.
 */

import type React from 'react';
import { useCallback, useMemo, useState } from 'react';

import { describeTurnFailure, emptyMeetingTurn, MEETING_FRAMES, useTurn, useTurnStream, type MeetingTurn } from '@/shared/stream';

import { buildSystemPrompt, meetingSuggestions } from '../model/meetingPrompt';
import type { Transcription } from '../model/types';

export interface MeetingChatTurn {
    role: 'user' | 'assistant';
    content: string;
}

export function useMeetingChat(meeting: Transcription) {
    const [turns, setTurns] = useState<MeetingChatTurn[]>([]);
    const [input, setInput] = useState('');
    const [error, setError] = useState<string | null>(null);

    // The answer streams through the shared stack (the meeting adapter acts on
    // the answer and the ways a turn ends). The live text is drawn into the
    // trailing assistant turn and committed to `turns` when the turn ends.
    const { run, stop, streaming, store } = useTurnStream<MeetingTurn>({
        empty: emptyMeetingTurn,
        adapter: MEETING_FRAMES,
        onFailure: (turn, err) => {
            turn.error = describeTurnFailure(err);
        },
        onDone: (turn) => {
            appendToLast(setTurns, () => turn.text);
            if (turn.error) setError(turn.error);
        },
    });
    const liveText = useTurn(store, (turn) => turn.text);

    const systemPrompt = useMemo(() => buildSystemPrompt(meeting), [meeting]);
    const suggestions = useMemo(
        () => meetingSuggestions({ attendees: meeting.attendees, speakers: meeting.speakers }),
        [meeting.attendees, meeting.speakers],
    );

    const send = useCallback(
        async (text: string) => {
            const question = text.trim();
            if (!question || streaming) return;
            setError(null);
            setInput('');

            const history = turns.map((turn) => ({ role: turn.role, content: turn.content }));
            setTurns((prev) => [...prev, { role: 'user', content: question }, { role: 'assistant', content: '' }]);

            await run('/ai/chat/direct/stream', {
                message: question,
                modelTier: 'auto',
                attachments: [],
                // No conversationId: this thread is deliberately not persisted,
                // so the server has no history to load and every turn carries
                // what has been said so far.
                history,
                systemPrompt,
                // The transcript is the whole context. A web search here would
                // answer from the internet instead of from the meeting.
                webSearchEnabled: false,
                memoryWriteEnabled: false,
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            });
        },
        [streaming, turns, systemPrompt, run],
    );

    return { turns, input, setInput, error, streaming, stop, liveText, suggestions, send };
}

/** Rewrite the trailing assistant turn — the only one a stream ever touches. */
function appendToLast(
    setTurns: React.Dispatch<React.SetStateAction<MeetingChatTurn[]>>,
    next: (previous: string) => string,
): void {
    setTurns((prev) => {
        const last = prev[prev.length - 1];
        if (!last || last.role !== 'assistant') return prev;
        return [...prev.slice(0, -1), { ...last, content: next(last.content) }];
    });
}

/**
 * The turns of one chat, for any runtime: the transcript (persisted plus
 * local), and the four ways a turn starts — a new message, "Try again" or
 * "Retry" under an answer (optionally on another tier), and editing a question
 * — each of which ends in the caller's `start`.
 *
 * An edit and a retry CUT the transcript at the question and send it again
 * with everything before it as `history` (the web's editAndRegenerate and
 * retryMessage in useChatEngine.ts), so the server truncates its own copy to
 * match.
 */

import { useCallback, useEffect, useRef } from 'react';

import { describeError } from '@/core/api/errors';

import { useLatest } from './useLatest';
import { useLocalTranscript, type TurnStart } from './useLocalTranscript';
import { encodeAttachments, toWire, type WireAttachment } from '../model/attachments';
import { promptFor } from '../model/retry';
import type { Attachment, ChatMessage } from '../model/types';

export interface TurnOptions {
    /** The message this turn replaces, with everything after it. */
    cutFrom?: string;
    /** This turn only, on another tier ("Retry with a different model"). */
    tierOverride?: string | null;
}

export interface StartTurn {
    text: string;
    attachments: WireAttachment[];
    turn: TurnStart;
    options: TurnOptions;
}

export interface TranscriptTurnsOptions {
    persisted: ChatMessage[] | undefined;
    persistedAt: number;
    streaming: boolean;
    /** What of the local list survives the server catching up. */
    keep: (local: ChatMessage[], persisted: ChatMessage[]) => ChatMessage[];
    /** Empty the live turn, so the new bubble does not show the last answer. */
    reset: () => void;
    /** Open the turn's stream. */
    start: (turn: StartTurn) => Promise<void>;
}

/** Only files still on the phone can be sent again — a saved one has no local copy to re-read. */
const localFiles = (message: ChatMessage) => (message.attachments ?? []).filter((a) => a.uri || a.dataUrl);

export function useTranscriptTurns({ persisted, persistedAt, streaming, keep, reset, start }: TranscriptTurnsOptions) {
    const transcript = useLocalTranscript({ persisted, persistedAt, streaming, keep });

    const send = (text: string, attachments: Attachment[], options: TurnOptions = {}) => {
        reset();
        const turn = transcript.begin(text, attachments, { cutFrom: options.cutFrom });
        void (async () => {
            let wire;
            try {
                // Attachments ride INLINE in the turn body as base64 data URLs —
                // there is no upload endpoint for chat — so they are resized and
                // size-checked here, before anything is sent.
                wire = toWire(await encodeAttachments(attachments));
            } catch (err) {
                transcript.fail(turn.placeholderId, describeError(err).message);
                return;
            }
            await start({ text, attachments: wire, turn, options });
        })();
    };

    /** The question an answer replied to, asked again in its place — on another tier when given one. */
    const retry = (answer: ChatMessage, tierOverride?: string | null) => {
        if (streaming) return;
        // `messages` is newest-first, for the inverted list.
        const prompt = promptFor(transcript.messages.slice().reverse(), answer.id);
        if (!prompt) return;
        send(prompt.content, localFiles(prompt), { cutFrom: prompt.id, tierOverride });
    };

    /** A question rewritten: everything from it onward goes, and the new words are sent in its place. */
    const edit = (question: ChatMessage, text: string) => {
        const trimmed = text.trim();
        if (streaming || !trimmed) return;
        send(trimmed, localFiles(question), { cutFrom: question.id });
    };

    // The conversation as it stands, oldest first, read when asked rather than
    // captured: what "Include conversation" sends with a rating.
    const latest = useRef(transcript.messages);
    useEffect(() => {
        latest.current = transcript.messages;
    });
    const conversation = useCallback(() => latest.current.slice().reverse(), []);

    return {
        messages: transcript.messages,
        conversation,
        settle: transcript.settle,
        // Stable identities for the memoised composer and transcript; each
        // call runs the latest render's version.
        handleSend: useLatest(send),
        handleRetry: useLatest(retry),
        handleEdit: useLatest(edit),
    };
}


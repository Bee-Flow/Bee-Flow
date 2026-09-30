/**
 * Messages added this session, layered over the persisted transcript, and
 * handed back to the server once it has caught up.
 *
 * The merge dedupes by id, and it can never match: local ids are
 * `Crypto.randomUUID()` and persisted ids are the server's. So without the
 * hand-back, every turn stays local for the life of the screen and the refetch
 * that follows a turn renders the whole conversation TWICE.
 *
 * Keyed on `persistedAt` (the query's `dataUpdatedAt`) rather than on the data:
 * it changes on every successful fetch, including one that returned an
 * identical body, which is exactly the "the server has it now" signal. Held
 * back while a turn streams, or is being prepared to (its files encoding),
 * because dropping the local placeholder then would blank the answer being
 * written — and after it, until a fetch newer than the turn lands: the
 * transcript on hand when a turn ends predates it, so handing back against
 * that one would hide the new question and answer for a round trip.
 *
 * An edit or a retry CUTS the transcript (model/transcript.ts cutAt): saved
 * messages from the cut onward are hidden until the server's truncated copy
 * arrives, and local ones are dropped at once.
 */

import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
    assistantPlaceholder,
    chronological,
    cutAt,
    failPlaceholder,
    historyOf,
    lastSavedOf,
    mergeTranscript,
    settleStreaming,
    userMessage,
    type FinishedTurn,
} from '../model/transcript';
import type { Attachment, ChatMessage } from '../model/types';

export interface LocalTranscriptOptions {
    persisted: ChatMessage[] | undefined;
    persistedAt: number;
    streaming: boolean;
    /** What of the local list survives the server catching up. */
    keep: (local: ChatMessage[], persisted: ChatMessage[]) => ChatMessage[];
}

/** What a new turn starts from: its placeholder, and the history it must carry. */
export interface TurnStart {
    placeholderId: string;
    history: { role: 'user' | 'assistant'; content: string }[];
    /** The history is a truncation the server must apply (an edit or retry of saved messages). */
    historyOverride: boolean;
}

const NO_IDS: ReadonlySet<string> = new Set();

export function useLocalTranscript({ persisted, persistedAt, streaming, keep }: LocalTranscriptOptions) {
    const [local, setLocal] = useState<ChatMessage[]>([]);
    const [hidden, setHidden] = useState<ReadonlySet<string>>(NO_IDS);
    // The fetch the last turn ended on, and whether a turn was streaming.
    const endedOn = useRef(0);
    const wasStreaming = useRef(false);
    // Read by the hand-back, not a reason to run it.
    const localNow = useRef(local);
    useEffect(() => {
        localNow.current = local;
    });

    const messages = useMemo(() => mergeTranscript(persisted ?? [], local, hidden), [persisted, local, hidden]);

    useEffect(() => {
        if (streaming) {
            wasStreaming.current = true;
            return;
        }
        if (wasStreaming.current) {
            wasStreaming.current = false;
            endedOn.current = persistedAt;
        }
        if (!persistedAt || persistedAt <= endedOn.current) return;
        // A turn begun but not streaming yet (its files still encoding) is
        // not the server's to take: its question and placeholder, and the
        // cut it made, wait for the fetch after it.
        if (localNow.current.some((m) => m.streaming)) return;
        // The server catching up is an external event; this is the one place
        // it is observed, so the hand-back happens here rather than in render.
        setHidden((prev) => (prev.size ? NO_IDS : prev));
        setLocal((prev) => {
            if (!prev.length) return prev;
            const kept = keep(prev, persisted ?? []);
            return kept.length === prev.length ? prev : kept;
        });
    }, [persistedAt, persisted, streaming, keep]);

    /**
     * Add a question and its streaming placeholder. `cutFrom` names the
     * message the new turn replaces, with everything after it — the question
     * an edit rewrites, or the one a retry asks again.
     */
    const begin = (text: string, attachments: Attachment[], { cutFrom }: { cutFrom?: string } = {}): TurnStart => {
        const saved = persisted ?? [];
        const savedIds = new Set(saved.map((m) => m.id));
        const visible = chronological(saved, local, hidden);
        const cut = cutFrom ? cutAt(visible, savedIds, cutFrom) : { before: visible, removed: [], override: false };
        const question = {
            ...userMessage(Crypto.randomUUID(), text, attachments),
            sentAfter: lastSavedOf(cut.before, savedIds),
            replaces: cut.override || undefined,
        };
        const placeholder = assistantPlaceholder(Crypto.randomUUID());
        const removed = new Set(cut.removed.map((m) => m.id));
        if (cut.removed.length) setHidden((prev) => new Set([...prev, ...removed]));
        setLocal((prev) => [...prev.filter((m) => !removed.has(m.id)), question, placeholder]);
        // Without a cut the rule is the web's: history only for a chat the
        // server has not saved yet, which is exactly the local messages.
        const history = historyOf(cut.override ? cut.before : local.filter((m) => !removed.has(m.id)));
        return { placeholderId: placeholder.id, history, historyOverride: cut.override };
    };

    const settle = (finished: FinishedTurn, interrupted: boolean) =>
        setLocal((prev) => settleStreaming(prev, finished, interrupted));

    const fail = (placeholderId: string, message: string) =>
        setLocal((prev) => failPlaceholder(prev, placeholderId, message));

    return { messages, begin, settle, fail };
}

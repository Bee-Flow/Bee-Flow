/**
 * The transcript of a notebook or template chat: the persisted turns, the ones
 * this panel added ahead of the server round-trip, and sending a new one.
 *
 * History is sent on EVERY turn, unlike direct chat. Both server runtimes
 * build their prompt from `req.body.history` and neither reads the persisted
 * transcript back (notebookChat.js, templateChat.js) — the stored copy exists
 * so the panel can rehydrate, not so the model can. The server trims it to a
 * token budget, so sending the lot is safe.
 */

import * as Crypto from 'expo-crypto';
import { useCallback, useMemo, useState } from 'react';

import { encodeAttachments, toWire, type Attachment, type ChatMessage } from '@/features/chat';

import { useLibraryChatStream, type LibraryStreamCallbacks, type LibraryTurn } from './useLibraryChatStream';

export interface LibraryTurnsOptions {
    /** Full client path, e.g. '/ai/chat/notebook/stream'. */
    streamPath: string;
    /** Runtime-specific body fields: notebookId + documentContent, or templateId. */
    extraBody: Record<string, unknown>;
    initialMessages: ChatMessage[];
    modelTier: string;
    callbacks: Pick<LibraryStreamCallbacks, 'onDocumentUpdate' | 'onSourceAdded'>;
    onTurnComplete?: () => void;
}

/** The streaming placeholder, settled with what the turn produced. */
function settle(message: ChatMessage, finished: LibraryTurn): ChatMessage {
    if (!message.streaming) return message;
    return {
        ...message,
        streaming: false,
        content: finished.text || message.content,
        thinking: finished.thinking || undefined,
        tools: finished.tools,
        sources: finished.sources,
        error: finished.error ?? undefined,
        // Nothing arrived and nothing failed: the socket died, which on a
        // phone is a walk out of wifi.
        interrupted: !finished.error && !finished.text ? true : undefined,
    };
}

function newTurn(text: string, attachments: Attachment[]): [ChatMessage, ChatMessage] {
    return [
        { id: Crypto.randomUUID(), role: 'user', content: text, attachments, createdAt: new Date().toISOString() },
        { id: Crypto.randomUUID(), role: 'assistant', content: '', streaming: true },
    ];
}

export function useLibraryTurns(options: LibraryTurnsOptions) {
    const { streamPath, extraBody, initialMessages, modelTier, onTurnComplete } = options;
    /** Turns added since this panel opened, ahead of the server round-trip. */
    const [local, setLocal] = useState<ChatMessage[]>([]);

    const { turn, streaming, send, stop } = useLibraryChatStream({
        ...options.callbacks,
        onDone: (finished) => {
            setLocal((prev) => prev.map((m) => settle(m, finished)));
            onTurnComplete?.();
        },
        onUnhandled: (event) => {
            if (__DEV__) console.warn(`[library-chat] unhandled SSE event: ${event}`);
        },
    });

    /** Persisted first, then anything this session added. Reversed for the inverted list. */
    const messages = useMemo(() => [...initialMessages, ...local].slice().reverse(), [initialMessages, local]);

    const sendTurn = useCallback(
        (text: string, attachments: Attachment[]) => {
            const [userMessage, placeholder] = newTurn(text, attachments);
            const history = [...initialMessages, ...local]
                .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim())
                .map((m) => ({ role: m.role, content: m.content }));
            setLocal((prev) => [...prev, userMessage, placeholder]);

            void (async () => {
                let wire;
                try {
                    // Attachments ride INLINE as base64 data URLs — neither
                    // runtime has an upload endpoint — so they are resized and
                    // budget-checked before anything is sent.
                    wire = toWire(await encodeAttachments(attachments));
                } catch (err) {
                    const error = (err as Error).message;
                    setLocal((prev) =>
                        prev.map((m) => (m.id === placeholder.id ? { ...m, streaming: false, error } : m)),
                    );
                    return;
                }
                await send(streamPath, {
                    ...extraBody,
                    message: text,
                    history,
                    modelTier,
                    attachments: wire,
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
            })();
        },
        [extraBody, initialMessages, local, send, modelTier, streamPath],
    );

    return { messages, turn, streaming, send: sendTurn, stop };
}

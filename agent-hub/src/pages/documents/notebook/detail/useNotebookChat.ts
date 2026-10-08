/**
 * useNotebookChat — the notebook's AI chat: the shared chat engine pointed at
 * the notebook chat endpoint, the private history loaded once per open, the
 * editor's bubble-menu actions (Rewrite, Shorten, Expand, Ask) and "Insert
 * into document".
 *
 * The chat is private to each person, also in a shared notebook: the history
 * belongs to the caller and "New chat" only clears theirs.
 *
 * Every turn carries the document the page shows and the version it was
 * loaded at (`docVersion`), so an AI edit is written over that version only,
 * never over a newer save. While the notebook is co-edited the AI's edit
 * arrives through the live session like anybody's typing, and the SSE copy of
 * it is ignored here.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import useChatEngine from '../../../../hooks/useChatEngine';
import type { ChatMessage } from '../../../../hooks/useChatEngine/types';
import { apiClient } from '../../../../api/client';
import { useClearNotebookChat, useNotebookConversation, type ChatHistoryMessage } from '../notebookQueries';
import type { NotebookEditorHandle } from './editorHandle';

export interface SelectionPayload { text: string; from: number | null; to: number | null; action: string }

interface Options {
    notebookId: string;
    selectedTier: string;
    editorRef: MutableRefObject<NotebookEditorHandle | null>;
    /** The document as the page shows it right now (HTML). */
    getDocument: () => string;
    /** The version the page last saved or loaded. */
    getDocVersion: () => number | null;
    /** The editor follows a live co-editing session. */
    bound: boolean;
    onDocUpdate: (content: string, version: number | null) => void;
    onSourceAdded: (source: unknown) => void;
}

const PREVIEW_CHARS = 300;

function toMessages(notebookId: string, list: ChatHistoryMessage[]): ChatMessage[] {
    return list.map((m, i) => ({
        ...m, // keep tokenisationInfo / pii badge / modelId so the privacy panel survives reload
        id: m.id || `nb-${notebookId}-${i}`,
        role: m.role,
        content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    }) as ChatMessage);
}

export default function useNotebookChat({
    notebookId, selectedTier, editorRef, getDocument, getDocVersion, bound, onDocUpdate, onSourceAdded,
}: Options) {
    const conversation = useNotebookConversation(notebookId);
    const clearChat = useClearNotebookChat(notebookId);
    const [locked, setLocked] = useState(false);
    // The selection a bubble-menu action attached to the NEXT turn (one-shot).
    const pendingSelectionRef = useRef<SelectionPayload | null>(null);
    const boundRef = useRef(bound);
    useEffect(() => { boundRef.current = bound; }, [bound]);
    const latest = useRef({ getDocument, getDocVersion, onDocUpdate, onSourceAdded });
    useEffect(() => { latest.current = { getDocument, getDocVersion, onDocUpdate, onSourceAdded }; });

    const directMode = useMemo(() => ({
        enabled: true,
        modelTier: selectedTier,
        customEndpoint: '/ai/chat/notebook/stream',
        getExtraPayload: () => {
            const payload: Record<string, unknown> = { notebookId, documentContent: latest.current.getDocument() };
            const version = latest.current.getDocVersion();
            if (version != null) payload.docVersion = version;
            if (pendingSelectionRef.current) {
                payload.notebookSelection = pendingSelectionRef.current;
                pendingSelectionRef.current = null;
            }
            return payload;
        },
    }), [selectedTier, notebookId]);

    const reloadConversation = useCallback(async () => {
        const data = await apiClient.get<{ messages?: ChatHistoryMessage[]; locked?: boolean }>(
            `/api/notebooks/${encodeURIComponent(notebookId)}/conversation`, { retry: false },
        );
        setLocked(!!data?.locked);
        return toMessages(notebookId, Array.isArray(data?.messages) ? data.messages : []);
    }, [notebookId]);

    const engine = useChatEngine({
        selectedAgent: null,
        currentConversation: null,
        onConversationCreated: useCallback(() => {}, []),
        getNotebookPayload: useCallback(() => ({}), []),
        onNotebookUpdate: useCallback(() => {}, []),
        directMode,
        onDirectConversationCreated: useCallback(() => {}, []),
        onNotebookDocUpdate: useCallback((content: unknown, _title: unknown, version: unknown) => {
            // Co-edited: the edit already reached every editor through the session.
            if (boundRef.current || typeof content !== 'string') return;
            latest.current.onDocUpdate(content, typeof version === 'number' ? version : null);
        }, []),
        onNotebookSourceAdded: useCallback((source: unknown) => latest.current.onSourceAdded(source), []),
        onHistoryLocked: useCallback(() => setLocked(true), []),
        reloadConversation,
    });
    const { setMessages, sendMessage } = engine;

    // The private history, once per open.
    const hydrated = useRef(false);
    useEffect(() => {
        if (hydrated.current || !conversation.data) return;
        hydrated.current = true;
        setLocked(conversation.data.locked);
        setMessages(toMessages(notebookId, conversation.data.messages));
    }, [conversation.data, notebookId, setMessages]);

    // Typing still inside the editor's save debounce is saved first, so the
    // AI reads (and edits over) what the user sees.
    const flushEditor = useCallback(() => { try { editorRef.current?.flush?.(); } catch { /* the save path reports */ } }, [editorRef]);

    const send = useCallback((text: string, attachments?: unknown[]) => {
        if (!text?.trim() && !attachments?.length) return;
        flushEditor();
        void sendMessage(text, attachments as never);
    }, [sendMessage, flushEditor]);

    /** A bubble-menu action on the editor's selection. */
    const onEditorAIAction = useCallback((actionKey: string, selectedText: string, range?: { from?: number; to?: number }, customQuery?: string) => {
        if (!selectedText?.trim()) return;
        pendingSelectionRef.current = {
            text: selectedText,
            from: typeof range?.from === 'number' ? range.from : null,
            to: typeof range?.to === 'number' ? range.to : null,
            action: ['rewrite', 'shorten', 'expand', 'ask'].includes(actionKey) ? actionKey : 'ask',
        };
        const preview = selectedText.length > PREVIEW_CHARS ? `${selectedText.slice(0, PREVIEW_CHARS).trimEnd()}…` : selectedText;
        // The instructions to the model stay in English on purpose: they are a
        // prompt, not interface text.
        flushEditor();
        const prompts: Record<string, string> = {
            rewrite: 'Rewrite the selected text. Use notebook_doc_replace to apply the change in place.',
            shorten: 'Shorten the selected text. Use notebook_doc_replace to apply the change in place.',
            expand: 'Expand the selected text with more detail. Use notebook_doc_replace to apply the change in place.',
            ask: `**Selected text:**\n> ${preview.split('\n').join('\n> ')}\n\n${customQuery || 'Analyze this text and provide insights.'}`,
        };
        void sendMessage(prompts[actionKey] || prompts.ask);
    }, [sendMessage, flushEditor]);

    /**
     * Put an answer into the document, through the editor so it is saved like
     * typing. The answer is Markdown: insertContent reads headings, lists and
     * tables from it (wrapping every line in <p> turned them into plain text).
     */
    const insertIntoDocument = useCallback((content: string) => {
        if (!content) return;
        editorRef.current?.insertContent?.(content);
    }, [editorRef]);

    const newChat = useCallback(async () => {
        await clearChat.mutateAsync();
        setMessages([]);
        setLocked(false);
    }, [clearChat, setMessages]);

    return {
        messages: engine.messages,
        isLoading: engine.isLoading,
        stop: engine.stopGenerating,
        retry: engine.retryMessage,
        edit: engine.editAndRegenerate,
        send,
        locked,
        historyLoading: conversation.isPending,
        historyFailed: conversation.isError,
        onEditorAIAction,
        insertIntoDocument,
        newChat,
        clearingChat: clearChat.isPending,
    };
}

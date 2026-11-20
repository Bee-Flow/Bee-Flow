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
 *
 * An action started from the editor is followed until its turn ends
 * (`editorBusy`), and `onEditorRunEnd` then says whether it changed the
 * document and what the AI answered: beside the main chat there is no
 * notebook chat to read that answer in.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import useChatEngine from '@/hooks/useChatEngine';
import type { ChatMessage } from '@/hooks/useChatEngine/types';
import { apiClient } from '@/api/client';
import { useClearNotebookChat, useNotebookConversation, type ChatHistoryMessage } from '../notebookQueries';
import type { NotebookEditorHandle } from './editorHandle';
import { logger } from '@/utils/logger';

export interface SelectionPayload { text: string; from: number | null; to: number | null; action: string }

/** How an editor AI action ended. */
export interface EditorRunOutcome {
    action: string;
    /** The AI changed the document during the run. */
    docUpdated: boolean;
    /** The AI's last answer (the error text when the run failed). */
    answer: string;
    failed: boolean;
}

/** An editor AI action in flight; `started` once the turn is seen loading. */
interface EditorRun { action: string; docUpdated: boolean; started: boolean }

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
    /**
     * Ask AI asks for a change to the selected text in place instead of an
     * answer in the chat (beside the main chat, where no notebook chat shows).
     */
    askInPlace?: boolean;
    /** An editor AI action finished (also when it failed). */
    onEditorRunEnd?: (outcome: EditorRunOutcome) => void;
}

const PREVIEW_CHARS = 300;
const ACTIONS = ['rewrite', 'shorten', 'expand', 'ask'];

/** The instruction for an editor action. Prompts stay in English on purpose: they are not interface text. */
function actionPrompt(actionKey: string, selectedText: string, customQuery: string | undefined, askInPlace: boolean): string {
    const preview = selectedText.length > PREVIEW_CHARS ? `${selectedText.slice(0, PREVIEW_CHARS).trimEnd()}…` : selectedText;
    const quoted = `**Selected text:**\n> ${preview.split('\n').join('\n> ')}`;
    const question = customQuery || 'Analyze this text and provide insights.';
    const prompts: Record<string, string> = {
        rewrite: 'Rewrite the selected text. Use notebook_doc_replace to apply the change in place.',
        shorten: 'Shorten the selected text. Use notebook_doc_replace to apply the change in place.',
        expand: 'Expand the selected text with more detail. Use notebook_doc_replace to apply the change in place.',
        ask: askInPlace
            ? `${quoted}\n\nChange the selected text as asked: ${question}. Use notebook_doc_replace to apply the change in place. `
                + 'If the question cannot be answered by changing the text, answer briefly instead.'
            : `${quoted}\n\n${question}`,
    };
    return prompts[actionKey] || prompts.ask;
}

/** The last assistant message of the conversation. */
function lastAnswer(messages: ChatMessage[]): ChatMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return messages[i];
    return undefined;
}

function toMessages(notebookId: string, list: ChatHistoryMessage[]): ChatMessage[] {
    return list.map((m, i) => ({
        ...m, // keep tokenisationInfo / pii badge / modelId so the privacy panel survives reload
        id: m.id || `nb-${notebookId}-${i}`,
        role: m.role,
        content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
    }) as ChatMessage);
}

/**
 * Follow an editor action to the end of its turn. It adjusts state while
 * rendering: the final messages and the end of loading arrive in one render.
 */
function useFollowEditorRun(
    run: EditorRun | null, setRun: (run: EditorRun | null) => void, isLoading: boolean, messages: ChatMessage[],
    onEnd: ((outcome: EditorRunOutcome) => void) | undefined,
) {
    if (run && !run.started && isLoading) {
        setRun({ ...run, started: true });
    } else if (run?.started && !isLoading) {
        setRun(null);
        const last = lastAnswer(messages);
        onEnd?.({
            action: run.action,
            docUpdated: run.docUpdated,
            answer: typeof last?.content === 'string' ? last.content.trim() : '',
            failed: !!last?.isError,
        });
    }
}

export default function useNotebookChat({
    notebookId, selectedTier, editorRef, getDocument, getDocVersion, bound, onDocUpdate, onSourceAdded, askInPlace = false, onEditorRunEnd,
}: Options) {
    const conversation = useNotebookConversation(notebookId);
    const clearChat = useClearNotebookChat(notebookId);
    const [locked, setLocked] = useState(false);
    const [editorRun, setEditorRun] = useState<EditorRun | null>(null);
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
            setEditorRun((run) => (run && !run.docUpdated ? { ...run, docUpdated: true } : run));
            // Co-edited: the edit already reached every editor through the session.
            if (boundRef.current || typeof content !== 'string') return;
            latest.current.onDocUpdate(content, typeof version === 'number' ? version : null);
        }, []),
        onNotebookSourceAdded: useCallback((source: unknown) => latest.current.onSourceAdded(source), []),
        onHistoryLocked: useCallback(() => setLocked(true), []),
        reloadConversation,
    });
    const { setMessages, sendMessage, isLoading } = engine;
    useFollowEditorRun(editorRun, setEditorRun, isLoading, engine.messages, onEditorRunEnd);

    // The private history, once per open.
    const [hydrated, setHydrated] = useState(false);
    if (!hydrated && conversation.data) {
        setHydrated(true);
        setLocked(conversation.data.locked);
        setMessages(toMessages(notebookId, conversation.data.messages));
    }

    // Typing still inside the editor's save debounce is saved first, so the
    // AI reads (and edits over) what the user sees.
    const flushEditor = useCallback(() => { try { editorRef.current?.flush?.(); } catch (err) { logger.debug('the save path reports', err); } }, [editorRef]);

    const send = useCallback((text: string, attachments?: unknown[]) => {
        if (!text?.trim() && !attachments?.length) return;
        flushEditor();
        void sendMessage(text, attachments as never);
    }, [sendMessage, flushEditor]);

    /** A bubble-menu action on the editor's selection. */
    const onEditorAIAction = useCallback((actionKey: string, selectedText: string, range?: { from?: number; to?: number }, customQuery?: string | null) => {
        // A turn is running: the engine would drop this one, and the selection would ride along with the next.
        if (!selectedText?.trim() || isLoading) return;
        const action = ACTIONS.includes(actionKey) ? actionKey : 'ask';
        pendingSelectionRef.current = {
            text: selectedText,
            from: typeof range?.from === 'number' ? range.from : null,
            to: typeof range?.to === 'number' ? range.to : null,
            action,
        };
        flushEditor();
        setEditorRun({ action, docUpdated: false, started: false });
        void sendMessage(actionPrompt(actionKey, selectedText, customQuery ?? undefined, askInPlace));
    }, [sendMessage, flushEditor, isLoading, askInPlace]);

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
        /** The editor action whose turn is running, if any. */
        editorBusy: editorRun?.action ?? null,
        insertIntoDocument,
        newChat,
        clearingChat: clearChat.isPending,
    };
}

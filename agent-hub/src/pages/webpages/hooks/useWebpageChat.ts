import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction , useLayoutEffect } from 'react';
import useChatEngine from '../../../hooks/useChatEngine';
import type { ChatAttachment } from '../../../hooks/useChatEngine/historyAttachment';
import type { ChatMessage } from '../../../hooks/useChatEngine/types';
import computeWebpageDiff from '../../../utils/computeWebpageDiff';
import scopedStorage from '../../../utils/scopedStorage';
import { appendEditToLatestAssistant, markApprovedPlansExecuted, setPlanStatus } from '../webpageChatMessages';
import { isPrimaryFile, type PrimaryContent, type PrimaryFile, type PrimarySetters } from '../../../api/webpageEditorTypes';
import { api } from '../../../api/webpagesApi';
import { useWebpageChatPersistence } from './useWebpageSave';
import { useLatestAssistantRef, useWebpageTurnUndo } from './useWebpageTurnUndo';
import type { WebpageExtraFiles } from './useWebpageExtraFiles';
import { logger } from '../../../utils/logger';

const CHAT_MODES = ['ask', 'auto', 'plan'];
const noop = () => {};
const emptyNotebookPayload = () => ({});

type SetMessages = Dispatch<SetStateAction<ChatMessage[]>>;

/** A preview-iframe selection, shown as a removable pill above the chat input. */
export interface AttachedSelection {
    text: string;
    tagName: string | null;
    className: string | null;
    elementId: string | null;
}

interface PlanExecution { planId: string; action: 'execute' }

/** Chat mode (ask / auto / plan), persisted per user. */
function useChatMode() {
    const [chatMode, setChatMode] = useState<string>(() => {
        try {
            const stored = scopedStorage.getItem('webpages_chat_mode');
            return stored && CHAT_MODES.includes(stored) ? stored : 'auto';
        } catch { return 'auto'; }
    });
    const handleChatModeChange = useCallback((mode: string) => {
        if (!CHAT_MODES.includes(mode)) return;
        setChatMode(mode);
        try { scopedStorage.setItem('webpages_chat_mode', mode); } catch (err) { logger.debug('storage unavailable', err); }
    }, []);
    return { chatMode, handleChatModeChange };
}

/**
 * Preview-iframe selection chip — set when the user highlights rendered
 * content in the preview. On send, the extra payload converts it into the
 * server's `webpageSelection: { text, file, action? }` contract. Single-shot:
 * cleared after the send.
 */
function useAttachedSelection() {
    const [attachedSelection, setAttachedSelection] = useState<AttachedSelection | null>(null);
    const handleSelectionAttach = useCallback((selection: Partial<AttachedSelection> | null) => {
        if (!selection || !selection.text) return;
        setAttachedSelection({
            text: selection.text,
            tagName: selection.tagName || null,
            className: selection.className || null,
            elementId: selection.elementId || null,
        });
    }, []);
    const handleSelectionClear = useCallback(() => setAttachedSelection(null), []);
    return { attachedSelection, setAttachedSelection, handleSelectionAttach, handleSelectionClear };
}

interface DocUpdateDeps {
    contentRef: RefObject<PrimaryContent>;
    setters: PrimarySetters;
    recordBefore: (file: string, before: string) => void;
    setChatMessagesRef: RefObject<SetMessages | null>;
}

/** The webpage_doc_update SSE: apply an AI edit, remember its undo state, add a diff card. */
function useDocUpdateHandler({ contentRef, setters, recordBefore, setChatMessagesRef }: DocUpdateDeps) {
    return useCallback((data: { file: unknown; content: unknown; title: unknown }) => {
        const { file, content, title } = (data || {}) as { file?: string; content?: string; title?: string };
        if (!file) return;
        const next = content || '';
        // Capture before-state from the live content ref so the diff is
        // computed against exactly what was on screen when the SSE arrived.
        const before = isPrimaryFile(file) ? contentRef.current[file] : '';
        const diff = computeWebpageDiff(before, next);
        if (diff.summary !== 'no change') recordBefore(file, before);
        if (isPrimaryFile(file)) setters[file](next);
        // Attach a diff entry to the most recent assistant message so the
        // chat panel can render a diff card below the AI's reply.
        const updateMessages = setChatMessagesRef.current;
        if (typeof updateMessages === 'function' && diff.summary !== 'no change') {
            updateMessages(prev => appendEditToLatestAssistant(prev, { file, title: title || file, diff }));
        }
    }, [contentRef, setters, recordBefore, setChatMessagesRef]);
}

/** Plan cards: approve (and build), reject, and mark executed once the build settles. */
function usePlanCards(setChatMessages: SetMessages, sendChatMessage: (text: string, attachments: ChatAttachment[]) => unknown,
    setPendingPlanExecution: (v: PlanExecution | null) => void, chatLoading: boolean) {
    const handlePlanApprove = useCallback((planId: string) => {
        if (!planId) return;
        setChatMessages(prev => setPlanStatus(prev, planId, 'approved'));
        // Stage the planExecution payload for the next chat send and trigger it.
        setPendingPlanExecution({ planId, action: 'execute' });
        // Defer to the next tick so React has flushed the pendingPlanExecution
        // state before getExtraPayload reads it.
        setTimeout(() => {
            sendChatMessage('Approved — please build the plan.', []);
            // Clear the staging state once the request has been kicked off; the
            // server has already received it, and it must not leak into the
            // next user turn.
            setTimeout(() => setPendingPlanExecution(null), 100);
        }, 0);
    }, [sendChatMessage, setChatMessages, setPendingPlanExecution]);

    const handlePlanReject = useCallback((planId: string) => {
        if (!planId) return;
        setChatMessages(prev => setPlanStatus(prev, planId, 'rejected'));
    }, [setChatMessages]);

    // After a build round-trip finishes (chat goes idle), flip any plan card
    // in "approved" state to "executed" so the user sees the check mark.
    useEffect(() => {
        if (chatLoading) return;
        setChatMessages(markApprovedPlansExecuted);
    }, [chatLoading, setChatMessages]);

    return { handlePlanApprove, handlePlanReject };
}

export interface UseWebpageChatArgs {
    pageId: string;
    selectedTier: string;
    content: PrimaryContent;
    contentRef: RefObject<PrimaryContent>;
    setters: PrimarySetters;
    markPrimaryDirty: (file: PrimaryFile) => void;
    initialMessages: ChatMessage[];
    extras: Pick<WebpageExtraFiles, 'onWebpageExtraUpdate' | 'onWebpageExtraDeleted'>;
    onSourceAdded: (source: unknown) => void;
}

/**
 * The webpage builder chat: the chat engine on the webpage stream endpoint,
 * its SSE edits applied to the editor, plan approval, per-turn undo, the
 * selection chip and the per-page chat history.
 */
export default function useWebpageChat({ pageId, selectedTier, content, contentRef, setters, markPrimaryDirty, initialMessages, extras, onSourceAdded }: UseWebpageChatArgs) {
    const { chatMode, handleChatModeChange } = useChatMode();
    // Ref bridge so the SSE callback (closed over once at hook init) can call
    // the latest setChatMessages without recreating the callback every render.
    const setChatMessagesRef = useRef<SetMessages | null>(null);
    // Set when the user clicks "Approve & build"; read by getExtraPayload so the
    // next send carries the planExecution authorisation.
    const [pendingPlanExecution, setPendingPlanExecution] = useState<PlanExecution | null>(null);
    const selection = useAttachedSelection();
    const { attachedSelection, setAttachedSelection } = selection;
    const undo = useWebpageTurnUndo(setters, markPrimaryDirty);
    const onWebpageDocUpdate = useDocUpdateHandler({ contentRef, setters, recordBefore: undo.recordBefore, setChatMessagesRef });
    const { html, css, js } = content;

    const directMode = useMemo(() => ({
        enabled: true,
        modelTier: selectedTier,
        customEndpoint: '/ai/chat/webpage/stream',
        getExtraPayload: () => ({
            webpageId: pageId, htmlContent: html, cssContent: css, jsContent: js, chatMode,
            ...(pendingPlanExecution ? { planExecution: pendingPlanExecution } : {}),
            // Preview-iframe selections come from rendered HTML, so the file is
            // 'html' and the AI finds the matching source there.
            ...(attachedSelection ? { webpageSelection: { text: attachedSelection.text, file: 'html' } } : {}),
        }),
    }), [selectedTier, pageId, html, css, js, chatMode, pendingPlanExecution, attachedSelection]);

    const engine = useChatEngine({
        selectedAgent: null,
        currentConversation: null,
        onConversationCreated: noop,
        getNotebookPayload: emptyNotebookPayload,
        onNotebookUpdate: noop,
        directMode,
        onDirectConversationCreated: noop,
        // Webpage-specific SSE events — useChatEngine forwards them via these callbacks.
        onWebpageDocUpdate,
        onWebpageSourceAdded: onSourceAdded,
        onWebpageExtraUpdate: extras.onWebpageExtraUpdate,
        onWebpageExtraDeleted: extras.onWebpageExtraDeleted,
    });
    const { messages: chatMessages, setMessages: setChatMessages, isLoading: chatLoading, sendMessage } = engine;
    useLayoutEffect(() => {
        setChatMessagesRef.current = setChatMessages;
    });
    useLatestAssistantRef(chatMessages, undo.latestAssistantIdRef);

    const { markSaved, clearOnServer } = useWebpageChatPersistence({ webpageId: pageId, chatMessages, chatLoading, api });
    // Restore the per-webpage chat history so the user keeps context across
    // refreshes. Marked "saved" first so the debounced effect sees no change.
    const restoreChat = useEffectEvent(() => {
        markSaved(initialMessages);
        setChatMessages(initialMessages);
    });
    useEffect(() => { restoreChat(); }, []);

    const plans = usePlanCards(setChatMessages, sendMessage, setPendingPlanExecution, chatLoading);
    // New Chat — clear local state + DELETE on the server.
    const handleNewChat = useCallback(async () => {
        setChatMessages([]);
        await clearOnServer();
    }, [setChatMessages, clearOnServer]);
    const sendFromChat = useCallback((text: string, attachments: ChatAttachment[]) => {
        sendMessage(text, attachments);
        // Single-shot: the next message does not carry the selection unless
        // the user picks a new one.
        if (attachedSelection) setAttachedSelection(null);
    }, [sendMessage, attachedSelection, setAttachedSelection]);

    return {
        engine, chatMode, handleChatModeChange, selection, undo, plans, handleNewChat, sendFromChat,
    };
}

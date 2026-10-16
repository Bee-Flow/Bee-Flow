import { useState, useRef, useCallback, useEffect } from 'react';
import { registerStream, releaseStream, detachStream } from './streamRegistry';
import type { ContentFlusher } from './useChatEngine/contentFlusher';
import type { ChatAttachment } from './useChatEngine/historyAttachment';
import { dispatchSSEEvent } from './useChatEngine/sseEvents';
import type { ChatSignalsTurnSurface } from './useChatEngine/turnEndpoint';
import { finishPermissionDenied, finishStreamEnd, finishWithError, type TurnEndDeps } from './useChatEngine/turnEnd';
import { buildTurnRequest } from './useChatEngine/turnRequest';
import { noteServerClock, openTurn, turnTarget } from './useChatEngine/turnStart';
import { readTurnStream } from './useChatEngine/turnStream';
import type { ChatMessage, SseDispatchIds, SseEventData } from './useChatEngine/types';
import useTranslation from './useTranslation';
import { authFetch } from '../utils/helpers';
import { readStoredMemoryFlags, type MemoryLock } from '../utils/memoryMode';

// Re-exported so the module's public surface is unchanged — the colocated unit
// tests (and any other consumer) keep importing these from './useChatEngine'.
export { createContentFlusher } from './useChatEngine/contentFlusher';
export { extractMdHeading, summarizeWorkItem } from './useChatEngine/workSummary';

/** The agent answering, as the page hands it over. */
export interface ChatAgent {
    id?: string;
    name?: string;
    avatar?: string;
    [key: string]: unknown;
}

/** Direct (agent-less) chat: which model, and where to send the turn. */
export interface DirectMode {
    enabled?: boolean;
    modelTier?: string;
    conversationId?: string;
    customEndpoint?: string;
    systemPrompt?: string;
    getExtraPayload?: () => Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * De TESTCHAT (A4). Eén object in plaats van twee losse vlaggen, omdat
 * `asGroup` zonder testchat een ander (bestaand) pad is en de twee niet per
 * ongeluk half aan mogen staan.
 */
export interface TestChatMode {
    enabled?: boolean;
    asGroup?: string;
    sessionId?: string;
    ephemeralConversationId?: string;
    [key: string]: unknown;
}

/** What the notebook panel contributes to a turn, when it is open. */
export interface NotebookPayload {
    notebookspaceContent?: string;
    notebookspaceSelection?: string;
    [key: string]: unknown;
}

export interface UseChatEngineOptions {
    selectedAgent?: ChatAgent | null;
    currentConversation?: { id?: string;[key: string]: unknown } | null;
    /** Called when the stream creates or updates a conversation. */
    onConversationCreated?: (conversationId: string) => void;
    getNotebookPayload?: () => NotebookPayload | null;
    onNotebookUpdate?: (content?: string) => void;
    directMode?: DirectMode | null;
    /** Called with { conversationId, title } for direct chats. */
    onDirectConversationCreated?: (info: unknown) => void;
    activeProject?: { id?: string;[key: string]: unknown } | null;
    onNotebookDocUpdate?: (content: unknown, title?: unknown, version?: unknown) => void;
    onNotebookSourceAdded?: (source: unknown) => void;
    /**
     * The server refused to persist the turn because the stored encrypted
     * history can't be opened with this session's key (SSE `history_locked`).
     * Lets the page lock the composer.
     */
    onHistoryLocked?: (data: unknown) => void;
    onNotebookThemeUpdate?: (theme: unknown) => void;
    onWebpageDocUpdate?: (doc: { file: unknown; content: unknown; title: unknown }) => void;
    onWebpageSourceAdded?: (source: unknown) => void;
    onWebpageExtraUpdate?: (extra: { path: unknown; meta: unknown }) => void;
    onWebpageExtraDeleted?: (extra: { path: unknown }) => void;
    /** Gamma generation/preview data from Gamma tool results. */
    onGammaPreview?: (preview: unknown) => void;
    activeSkillIds?: string[];
    onSessionSkillsChanged?: (payload: unknown) => void;
    /**
     * Refetch the persisted conversation so a dropped stream can auto-recover
     * the saved reply (the server persists the finished message even when the
     * SSE connection drops mid/post-stream). Omitted → the interrupted notice
     * is shown as before.
     */
    reloadConversation?: () => Promise<ChatMessage[] | null | undefined>;
    testChat?: TestChatMode | null;
    /**
     * Chat signals: the fields to add to a turn on a counted endpoint (the
     * notice marker, and the opt-out when the person chose it). Asked only
     * for the endpoint the turn really goes to; a host that shows no notice
     * passes nothing, so its turns carry no marker and are not counted.
     */
    getChatSignalsPayload?: (surface: ChatSignalsTurnSurface) => Record<string, unknown> | null;
    /**
     * Only the main chat passes this. It switches on the "Remembered" chip: a
     * finished turn that could save memories gets a `memoryWatch` the message
     * row polls on. It answers why the person's memory is locked (paused by
     * them, off for the organisation), in which case nothing is watched.
     */
    getMemoryLock?: () => MemoryLock;
}

/**
 * Custom hook that encapsulates the chat messaging engine.
 *
 * Owns: messages, isLoading, abortController, sendMessage, stopGenerating.
 * Receives agent/conversation context and workspace state via params.
 */
export default function useChatEngine({
    selectedAgent,
    currentConversation,
    onConversationCreated,
    getNotebookPayload,
    onNotebookUpdate,
    directMode,
    onDirectConversationCreated,
    activeProject,
    onNotebookDocUpdate,
    onNotebookSourceAdded,
    onHistoryLocked,
    onNotebookThemeUpdate,
    onWebpageDocUpdate,
    onWebpageSourceAdded,
    onWebpageExtraUpdate,
    onWebpageExtraDeleted,
    onGammaPreview,
    activeSkillIds,
    onSessionSkillsChanged,
    reloadConversation,
    testChat = null,
    getChatSignalsPayload,
    getMemoryLock,
}: UseChatEngineOptions) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    // Active stream controller. Ref instead of state so rapid double-send
    // can synchronously read+abort the previous controller in the same tick,
    // and so changes don't recreate `sendMessage`/`stopGenerating`.
    const abortControllerRef = useRef<AbortController | null>(null);
    // The current stream's content flusher (rAF coalescer). Held in a ref so
    // stopGenerating / unmount can cancel a pending frame from outside sendMessage.
    const activeFlusherRef = useRef<ContentFlusher | null>(null);
    // Key of the stream currently owned by this component, so unmount knows
    // which registry entry to detach.
    const streamKeyRef = useRef<string | null>(null);

    // Keep a ref in sync with messages so `sendMessage` can read the current
    // conversation without listing `messages` in its dep array. With `messages`
    // in the deps, `sendMessage` was recreated on every keystroke — that
    // cascaded to `retryMessage` and `editAndRegenerate` (which depend on
    // `sendMessage`), breaking memoization for every child that consumes them.
    const messagesRef = useRef(messages);
    useEffect(() => { messagesRef.current = messages; }, [messages]);

    // ── Testchat: de modus, en wat er op de kaarten geklikt is ──────────
    // De modus in een ref zodat hij `sendMessage` niet elke render opnieuw
    // maakt (zelfde reden als tRef hieronder).
    const testChatRef = useRef(testChat);
    useEffect(() => { testChatRef.current = testChat; }, [testChat]);
    // De sleutel van DEZE testsessie. Opaak, alleen bedoeld om de efemere
    // conversatie van de server over meerdere beurten dezelfde id te geven
    // (`testChat.ephemeralConversationId` hasht hem met gebruiker en agent).
    // Een aanroeper die zijn eigen id meegeeft (`testChat.sessionId`) wint —
    // dat is de haak waarmee "nieuw testgesprek" straks één regel is.
    const testSessionIdRef = useRef<string | null>(null);
    if (testSessionIdRef.current === null) {
        testSessionIdRef.current = `tc-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    }
    useEffect(() => {
        const given = testChat && typeof testChat.sessionId === 'string' ? testChat.sessionId.trim() : '';
        if (given.length >= 8) testSessionIdRef.current = given;
    }, [testChat]);
    // Beslissingen wachten op de VOLGENDE beurt: de vastgehouden call zat in
    // een beurt die al afgelopen is, dus "ja" betekent "doe het als je het zo
    // weer voorstelt".
    //
    // ── TWEE KAARTEN, WANT TWEE VERSCHILLENDE VRAGEN ────────────────────
    // Er stond er één, en dat was fout op de gevaarlijke manier. De server
    // VERBRUIKT een goedkeuring per request (`_toolDecisions.delete`), maar
    // bouwt zijn Map elke beurt opnieuw uit de body — dus zolang de client
    // dezelfde verzameling bleef meesturen, kocht één klik op "Approve and
    // run" élke latere beurt waarin het model diezelfde call met dezelfde
    // argumenten voorstelde. Zonder kaart, zonder klik.
    //
    //   OUTBOX (`toolDecisionsRef`)  wat er nog MEE moet met een volgend
    //     bericht, op `argsKey` — de sleutel die de server begrijpt. Wordt bij
    //     het versturen geleegd: één ja draait één actie, en een model dat de
    //     call herhaalt krijgt een verse kaart in plaats van een vrijbrief.
    //     Mislukt het versturen, dan is de beslissing weg en moet er opnieuw
    //     geklikt worden — dat is de kant waar niets gebeurt.
    //
    //   LEDGER (`toolDecisions`)  wat deze persoon geklikt HEEFT, op `callId`
    //     — die is per ronde nieuw, dus de aantekening kleurt precies de kaart
    //     waarop geklikt is en nooit een latere kaart voor dezelfde actie. Op
    //     `argsKey` bewaren zou een nieuwe kaart in beurt 5 laten zeggen "You
    //     declined this" op een beslissing van vijf beurten geleden, én de
    //     knoppen weghalen waarmee je dat had kunnen herzien.
    const [toolDecisions, setToolDecisions] = useState<Record<string, string>>({});
    const toolDecisionsLedgerRef = useRef<Record<string, string>>({});
    const toolDecisionsRef = useRef<Record<string, string>>({});
    const decideTool = useCallback((argsKey: string, decision: string, call: { callId?: string } | null = null) => {
        if (!argsKey || (decision !== 'approve' && decision !== 'decline')) return;
        const ledgerKey = (call && typeof call.callId === 'string' && call.callId) || argsKey;
        // Een tweede klik op DEZELFDE kaart is geen nieuwe toestemming — hier
        // én op de server. Een nieuwe kaart (nieuwe callId) mag wel opnieuw
        // beslist worden; anders blijft een "nee" de rest van de sessie plakken.
        if (toolDecisionsLedgerRef.current[ledgerKey]) return;
        if (toolDecisionsRef.current[argsKey]) return;
        toolDecisionsLedgerRef.current = { ...toolDecisionsLedgerRef.current, [ledgerKey]: decision };
        toolDecisionsRef.current = { ...toolDecisionsRef.current, [argsKey]: decision };
        setToolDecisions(toolDecisionsLedgerRef.current);
    }, []);

    // i18n access for SSE event handlers
    const { t } = useTranslation();
    const tRef = useRef(t);
    useEffect(() => { tRef.current = t; }, [t]);

    // Keep the recovery loader current without recreating sendMessage (it's read
    // in the interrupted catch-branch). Mirrors tRef/handleSSEEventRef.
    const reloadConversationRef = useRef(reloadConversation);
    useEffect(() => { reloadConversationRef.current = reloadConversation; }, [reloadConversation]);

    // Stable refs so SSE handlers always call the latest callback
    // (avoids stale closure when parent re-renders change the callback identity)
    const onNotebookDocUpdateRef = useRef(onNotebookDocUpdate);
    useEffect(() => { onNotebookDocUpdateRef.current = onNotebookDocUpdate; }, [onNotebookDocUpdate]);

    const onNotebookSourceAddedRef = useRef(onNotebookSourceAdded);
    useEffect(() => { onNotebookSourceAddedRef.current = onNotebookSourceAdded; }, [onNotebookSourceAdded]);

    const onHistoryLockedRef = useRef(onHistoryLocked);
    useEffect(() => { onHistoryLockedRef.current = onHistoryLocked; }, [onHistoryLocked]);

    const onNotebookThemeUpdateRef = useRef(onNotebookThemeUpdate);
    useEffect(() => { onNotebookThemeUpdateRef.current = onNotebookThemeUpdate; }, [onNotebookThemeUpdate]);

    const onWebpageDocUpdateRef = useRef(onWebpageDocUpdate);
    useEffect(() => { onWebpageDocUpdateRef.current = onWebpageDocUpdate; }, [onWebpageDocUpdate]);

    const onWebpageSourceAddedRef = useRef(onWebpageSourceAdded);
    useEffect(() => { onWebpageSourceAddedRef.current = onWebpageSourceAdded; }, [onWebpageSourceAdded]);

    const onWebpageExtraUpdateRef = useRef(onWebpageExtraUpdate);
    useEffect(() => { onWebpageExtraUpdateRef.current = onWebpageExtraUpdate; }, [onWebpageExtraUpdate]);

    const onWebpageExtraDeletedRef = useRef(onWebpageExtraDeleted);
    useEffect(() => { onWebpageExtraDeletedRef.current = onWebpageExtraDeleted; }, [onWebpageExtraDeleted]);

    const onGammaPreviewRef = useRef(onGammaPreview);
    useEffect(() => { onGammaPreviewRef.current = onGammaPreview; }, [onGammaPreview]);

    const getChatSignalsPayloadRef = useRef(getChatSignalsPayload);
    useEffect(() => { getChatSignalsPayloadRef.current = getChatSignalsPayload; }, [getChatSignalsPayload]);
    const getMemoryLockRef = useRef(getMemoryLock);
    // Server clock minus browser clock, learned from the `Date` header of the last turn.
    const serverSkewMsRef = useRef(0);
    useEffect(() => { getMemoryLockRef.current = getMemoryLock; }, [getMemoryLock]);

    // Cleanup abort controller on unmount. Mount-only effect — the ref
    // always points at the current controller, so we don't need to re-run.
    useEffect(() => {
        return () => {
            const c = abortControllerRef.current;
            if (c) {
                // Aborting here does not merely stop listening: the server tears
                // down its generation on res close, so it KILLS the answer. Any
                // navigation unmounts this component, which is how switching
                // threads mid-reply used to lose the reply outright — and in a
                // shared thread, lose it for everyone watching.
                //
                // A stream whose conversation is being persisted is detached
                // instead: the fetch drains in the background, the server
                // finishes and saves, and the returning user reads a complete
                // answer. An ephemeral stream has nowhere to land, so it is
                // still aborted.
                const key = streamKeyRef.current;
                const canDetach = Boolean(key) && !String(key).startsWith('pending:');
                const kept = key ? detachStream(key, { canDetach }) : false;
                if (!kept) c.abort();
                abortControllerRef.current = null;
            }
            // Cancel any scheduled content frame so it can't fire post-unmount.
            activeFlusherRef.current?.cancel();
            activeFlusherRef.current = null;
        };
    }, []);

    // --- SSE Event Handlers ---

    const handleSSEEvent = useCallback((event: string, data: SseEventData, ids: SseDispatchIds) => {
        // The SSE switch lives in ./useChatEngine/sseEvents.js (verbatim
        // extraction). All state setters/refs are threaded through `ctx`; the
        // dep array is unchanged, so exactly the same values are captured at
        // memoization time as before the extraction.
        dispatchSSEEvent({
            setMessages,
            onConversationCreated,
            onNotebookUpdate,
            onSessionSkillsChanged,
            tRef,
            onGammaPreviewRef,
            onNotebookDocUpdateRef,
            onNotebookSourceAddedRef,
            onHistoryLockedRef,
            onNotebookThemeUpdateRef,
            onWebpageDocUpdateRef,
            onWebpageSourceAddedRef,
            onWebpageExtraUpdateRef,
            onWebpageExtraDeletedRef,
        }, event, data, ids);
    }, [onConversationCreated, onNotebookUpdate]);

    // Ref wrapper so `sendMessage` can dispatch SSE events without listing
    // `handleSSEEvent` in its deps. Keeps `sendMessage`'s identity stable as
    // long as its real inputs (selectedAgent, directMode, …) don't change.
    const handleSSEEventRef = useRef(handleSSEEvent);
    useEffect(() => { handleSSEEventRef.current = handleSSEEvent; }, [handleSSEEvent]);

    // --- Core send ---
    // The phases live in ./useChatEngine/: turnStart (messages on screen),
    // turnRequest (URL and body), turnStream (read and dispatch the SSE),
    // turnEnd (completed, refused, interrupted, recovered).

    const sendMessage = useCallback(async (
        text: string,
        attachments: ChatAttachment[] = [],
        isHidden = false,
        historyOverride: ChatMessage[] | null = null,
        overrideTier: string | null = null,
    ) => {
        const isDirectMode = !!directMode?.enabled;
        if (!isDirectMode && !selectedAgent) return;
        if (isLoading) return;
        if (!text && attachments.length === 0) return;

        abortControllerRef.current?.abort();
        const controller = new AbortController();
        abortControllerRef.current = controller;
        const { streamKey, chatProjectId, conversationId } = turnTarget(currentConversation, directMode, activeProject);
        streamKeyRef.current = streamKey;
        registerStream(streamKey, controller);
        setIsLoading(true);

        const turn = openTurn({
            text, attachments, isHidden, isDirectMode,
            agent: selectedAgent,
            conversationId,
            serverSkewMs: serverSkewMsRef.current,
            setMessages,
        });
        activeFlusherRef.current = turn.flusher;
        const endDeps: TurnEndDeps = {
            setMessages,
            setIsLoading,
            t: () => tRef.current,
            messages: () => messagesRef.current,
            reloadConversation: () => reloadConversationRef.current,
        };

        try {
            const testChat = testChatRef.current?.enabled ? testChatRef.current : null;
            const { url, payload } = buildTurnRequest({
                text, attachments, isHidden, historyOverride, overrideTier, isDirectMode, directMode, chatProjectId, activeSkillIds,
                messages: messagesRef.current,
                agentId: selectedAgent?.id,
                conversationId: currentConversation?.id,
                getNotebookPayload,
                testChat: testChat && { asGroup: testChat.asGroup, sessionId: testSessionIdRef.current, toolDecisions: toolDecisionsRef.current },
                getChatSignalsPayload: getChatSignalsPayloadRef.current,
            });
            // The outbox is now in the body. Empty it: sent is consumed. The
            // LEDGER stays, so the card that was clicked keeps its colour.
            if (testChat && !isDirectMode) toolDecisionsRef.current = {};

            const response = await authFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            const skew = noteServerClock(response, turn);
            if (skew !== null) serverSkewMsRef.current = skew;

            if (response.status === 403 || response.status === 401) {
                finishPermissionDenied(turn, endDeps);
                return;
            }
            if (!response.ok) throw new Error('Failed to send message');

            await readTurnStream(response, controller.signal, turn, {
                dispatch: (event, data, ids) => handleSSEEventRef.current(event, data, ids),
                isDirectMode,
                onDirectConversation: onDirectConversationCreated,
            });
            finishStreamEnd(turn, endDeps, {
                getMemoryLock: getMemoryLockRef.current,
                isTestChat: !!testChatRef.current?.enabled,
                customEndpoint: directMode?.customEndpoint,
                memoryWriteEnabled: () => readStoredMemoryFlags().memoryWriteEnabled,
            });
        } catch (e) {
            finishWithError(e, turn, endDeps);
        } finally {
            // Release the controller once the stream is done (success, error, or
            // abort). Leaving it set means the next send would needlessly call
            // .abort() on an already-finished controller.
            if (abortControllerRef.current === controller) abortControllerRef.current = null;
            // The stream is over (success, error or abort), so it no longer
            // needs to survive an unmount.
            releaseStream(streamKey);
            // Drop the flusher reference (guard against a newer concurrent stream
            // having replaced it) so stopGenerating can't act on a dead stream.
            turn.flusher.cancel();
            if (activeFlusherRef.current === turn.flusher) activeFlusherRef.current = null;
        }
        // Deliberately NOT in deps: `messages` (read via messagesRef), `handleSSEEvent`
        // (invoked via handleSSEEventRef). Keeping them here would recreate
        // `sendMessage` on every streamed token and break child memoization.
    }, [selectedAgent, isLoading, currentConversation, getNotebookPayload, directMode, onDirectConversationCreated, activeProject, activeSkillIds, onSessionSkillsChanged]);

    const stopGenerating = useCallback(() => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        // An explicit stop is the one case that really should end the
        // generation, so drop it from the registry too — otherwise the
        // detach-on-unmount path would keep a stream the user just cancelled.
        if (streamKeyRef.current) {
            releaseStream(streamKeyRef.current);
            streamKeyRef.current = null;
        }
        // Cancel any pending content frame so a late flush can't resurrect
        // streaming text after the user stopped generation.
        activeFlusherRef.current?.cancel();
        setIsLoading(false);
        setMessages(prev => prev.map(m =>
            m.isStreaming ? { ...m, isStreaming: false } : m
        ));
    }, []);

    /**
     * Retry: regenerate the AI response at `messageIndex`.
     * Truncates that AI message and everything after it,
     * then re-sends the preceding user message.
     * @param {number} messageIndex - Index of the assistant message to retry
     * @param {string} [overrideTier] - Optional model tier override (e.g. 'fast', 'think')
     */
    const retryMessage = useCallback((messageIndex: number, overrideTier?: string) => {
        if (isLoading) return;

        // Compute truncation outside the state updater so the side-effect
        // (sendMessage) runs exactly once — React 19 StrictMode double-invokes
        // updater functions, which would otherwise fire sendMessage twice.
        const currentMessages = messagesRef.current;
        const visibleMessages = currentMessages.filter(m => !m.parentId);
        const assistantMsg = visibleMessages[messageIndex];
        if (!assistantMsg || assistantMsg.role !== 'assistant') return;

        let userMsgIndex = messageIndex - 1;
        while (userMsgIndex >= 0 && visibleMessages[userMsgIndex]?.role !== 'user') {
            userMsgIndex--;
        }
        const userMsg = visibleMessages[userMsgIndex];
        if (!userMsg) return;

        const userIdx = currentMessages.indexOf(userMsg);
        const truncated = currentMessages.slice(0, userIdx);

        setMessages(truncated);
        setTimeout(() => {
            sendMessage(userMsg.content ?? '', (userMsg.attachments as ChatAttachment[]) || [], false, truncated, overrideTier || null);
        }, 50);
    }, [isLoading, sendMessage, directMode]);

    /**
     * Edit a user message and regenerate the response.
     * Truncates from the user message onward, then sends newContent.
     * @param {number} messageIndex - Index of the user message to edit
     * @param {string} newContent - The edited message content
     */
    const editAndRegenerate = useCallback((messageIndex: number, newContent: string) => {
        if (isLoading) return;
        if (!newContent?.trim()) return;

        const currentMessages = messagesRef.current;
        const visibleMessages = currentMessages.filter(m => !m.parentId);
        const userMsg = visibleMessages[messageIndex];
        if (!userMsg || userMsg.role !== 'user') return;

        const userIdx = currentMessages.indexOf(userMsg);
        const truncated = currentMessages.slice(0, userIdx);

        setMessages(truncated);
        setTimeout(() => {
            sendMessage(newContent.trim(), (userMsg.attachments as ChatAttachment[]) || [], false, truncated);
        }, 50);
    }, [isLoading, sendMessage]);

    return {
        messages,
        setMessages,
        isLoading,
        sendMessage,
        stopGenerating,
        retryMessage,
        editAndRegenerate,
        // Testchat: wat er geklikt is, en de klik zelf.
        toolDecisions,
        decideTool,
    };
}

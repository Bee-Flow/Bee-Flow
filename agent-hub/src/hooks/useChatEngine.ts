import { useState, useRef, useCallback, useEffect } from 'react';
import { registerStream, releaseStream, detachStream } from './streamRegistry';
import { createContentFlusher, type ContentFlusher } from './useChatEngine/contentFlusher';
import { toHistoryAttachment } from './useChatEngine/historyAttachment';
import { dispatchSSEEvent } from './useChatEngine/sseEvents';
import { chatSignalsSurfaceFor, resolveTurnEndpoint, type ChatSignalsTurnSurface } from './useChatEngine/turnEndpoint';
import { WORK_EVENT_KINDS, extractMdHeading, summarizeWorkItem, type WorkItem } from './useChatEngine/workSummary';
import type { ChatAttachment } from './useChatEngine/historyAttachment';
import type { ChatMessage, SseDispatchIds, SseEventData } from './useChatEngine/types';
import useTranslation from './useTranslation';
import { API_BASE, generateMessageId, authFetch } from '../utils/helpers';
import scopedStorage from '../utils/scopedStorage';

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

    const sendMessage = useCallback(async (
        text: string,
        attachments: ChatAttachment[] = [],
        isHidden = false,
        historyOverride: ChatMessage[] | null = null,
        overrideTier: string | null = null,
    ) => {
        const isDirectMode = directMode?.enabled;
        if (!isDirectMode && !selectedAgent) return;
        if (isLoading) return;
        if (!text && attachments.length === 0) return;

        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        const controller = new AbortController();
        abortControllerRef.current = controller;
        // A chat that belongs to a project uses that project, however it was opened:
        // the project the person is in, else the one the conversation is filed in.
        const filed = currentConversation as { project_id?: string | null; projectId?: string | null } | null | undefined;
        const chatProjectId = activeProject?.id || filed?.project_id || filed?.projectId || null;
        // Track it so navigating away detaches instead of killing the answer —
        // see hooks/streamRegistry.js. Keyed by conversation so a remount finds
        // its own stream and a second send supersedes the first.
        const streamKey = currentConversation?.id || directMode?.conversationId || `pending:${generateMessageId()}`;
        streamKeyRef.current = streamKey;
        registerStream(streamKey, controller);
        setIsLoading(true);

        const msgId = generateMessageId();
        const newMessage = {
            id: msgId,
            role: 'user',
            content: text,
            attachments,
            timestamp: new Date().toISOString(),
            isHidden
        };

        setMessages(prev => [...prev, newMessage]);

        const assistantMsgId = generateMessageId();
        const placeholder = {
            id: assistantMsgId,
            role: 'assistant',
            content: '',
            isStreaming: true,
            respondingAgentId: isDirectMode ? 'direct' : selectedAgent?.id,
            respondingAgentName: isDirectMode ? null : selectedAgent?.name,
            respondingAgentAvatar: isDirectMode ? '💬' : selectedAgent?.avatar
        };
        setMessages(prev => [...prev, placeholder]);

        // Mutable refs for active agent tracking
        const activeIdRef = { current: assistantMsgId };
        const contentRef = { current: '' };
        // Per-stream rAF coalescer for 'content' tokens (see createContentFlusher).
        const flusher = createContentFlusher(setMessages, activeIdRef, contentRef);
        activeFlusherRef.current = flusher;
        // Tracks whether the stream produced any real work (content/tool/build
        // events) before it ended. Used so a stream that drops AFTER work was
        // already in flight (e.g. a long webpage/notebook build that tripped a
        // proxy idle-timeout) isn't misreported as a hard failure (BFSF-221).
        let producedWork = false;
        // The server sent its terminal `done` event: the turn completed and was
        // persisted. Anything that fails after this is teardown noise (a socket
        // the server never closed cleanly, a proxy reset) and must NOT be shown
        // as "interrupted" — the answer on screen is the whole answer.
        let sawDone = false;
        // Last work item ({ kind, title }) seen on this stream, so the
        // interrupted/error notices can say WHAT was produced (BFSF-221).
        const workRef: { current: WorkItem | null } = { current: null };

        // The stream ended without completing the turn — either it threw, or it
        // reached EOF with no terminal `done`. Both mean the same thing to the
        // user, so they get the same treatment. Shared by the reader's normal
        // exit and the catch below so a truncated stream can never be finalised
        // as if it had succeeded.
        const finishAbnormally = () => {
            // If the stream already produced content/tool/build activity, it
            // most likely dropped after the work was underway (e.g. a long
            // webpage/notebook build that tripped a proxy idle-timeout) — the
            // result may well have been saved. Surface a non-fatal "interrupted"
            // notice instead of masquerading it as a hard failure (BFSF-221).
            const interrupted = producedWork || !!contentRef.current?.trim();
            setMessages(prev => prev.map(m => {
                if (m.id !== assistantMsgId) return m;
                // An explicit terminal event already told the user what
                // happened — a server `error`, or a privacy-shield block. Those
                // carry a specific, actionable reason; replacing it with a
                // generic "interrupted"/"Error generating response." would be
                // strictly less true. Just close the message out.
                if (m.isError) return { ...m, isStreaming: false };
                if (interrupted) {
                    const prior = (m.content && m.content.trim()) ? m.content.trimEnd() + '\n\n' : '';
                    // When we know WHAT was produced, lead with an explicit
                    // success confirmation so users don't retry and duplicate.
                    const wi = workRef.current;
                    const summary = summarizeWorkItem(tRef.current, wi);
                    const notice = summary
                        ? tRef.current('chat.interrupted_with_work', { workSummary: summary })
                        : tRef.current('chat.interrupted_generic');
                    return {
                        ...m,
                        isStreaming: false,
                        isInterrupted: true,
                        workItem: wi || null,
                        content: prior + notice,
                    };
                }
                return { ...m, isStreaming: false, isError: true, content: 'Error generating response.' };
            }));
            setIsLoading(false);

            // Auto-recover: the server persists the finished reply even when
            // the SSE connection drops mid/post-stream (confirmed — the saved
            // message appears on a manual refresh). Poll the persisted
            // conversation and swap the real reply in so the user doesn't have
            // to refresh. Bounded (~60s); bails if the user moved on; the
            // interrupted notice stays if recovery never yields a saved reply.
            const _reload = reloadConversationRef.current;
            if (interrupted && typeof _reload === 'function') {
                (async () => {
                    const stillOurs = () => {
                        const c = messagesRef.current;
                        const l = c[c.length - 1];
                        return !!(l && l.id === assistantMsgId && l.isInterrupted);
                    };
                    // Quick first attempt, then every 4s up to ~60s total.
                    const delays = [1200, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000, 4000];
                    for (const d of delays) {
                        await new Promise(r => setTimeout(r, d));
                        if (!stillOurs()) return;
                        let reloaded;
                        try { reloaded = await _reload(); } catch { continue; }
                        if (!Array.isArray(reloaded) || reloaded.length === 0) continue;
                        const lastReload = reloaded[reloaded.length - 1];
                        if (lastReload && lastReload.role === 'assistant' && String(lastReload.content || '').trim()) {
                            if (stillOurs()) setMessages(reloaded);
                            return;
                        }
                    }
                })();
            }
        };

        try {
            // Thinking-effort override from composer (persisted in scopedStorage
            // so user A's choice doesn't follow user B after account switch).
            // Valid values: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'.
            // When unset, the server falls back to the tier default.
            const reasoningEffort = scopedStorage.getItem('reasoningEffort') || null;

            let payload;
            // One path for the request and for the chat-signals marker below.
            const turnPath = resolveTurnEndpoint({
                isDirectMode: !!isDirectMode,
                customEndpoint: directMode?.customEndpoint,
                agentId: selectedAgent?.id,
            });
            const url = `${API_BASE}${turnPath}`;

            if (isDirectMode) {
                // Direct chat mode — post to custom endpoint or /ai/chat/direct/stream
                // History rule:
                //   - Edit/retry flow: send `historyOverride` so the server can
                //     truncate the conversation to the edit point.
                //   - Brand-new conversation (no conversationId): send the
                //     current in-memory history so the very first turn has it.
                //   - Persisted conversation, no override: send NO history.
                //     The server loads from `conversation_messages` instead,
                //     which is the durable source of truth and avoids drift
                //     (stripped tool messages, page-reload gaps, etc).
                let history;
                if (historyOverride) {
                    history = historyOverride.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim()).map(m => ({
                        role: m.role,
                        content: m.content,
                        ...(m.attachments && m.attachments.length > 0 ? { attachments: (m.attachments as ChatAttachment[]).map(toHistoryAttachment) } : {})
                    }));
                } else if (!currentConversation?.id) {
                    history = messagesRef.current.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim()).map(m => ({
                        role: m.role,
                        content: m.content,
                        ...(m.attachments && m.attachments.length > 0 ? { attachments: (m.attachments as ChatAttachment[]).map(toHistoryAttachment) } : {})
                    }));
                } else {
                    history = undefined;
                }
                payload = {
                    message: text,
                    conversationId: currentConversation?.id,
                    modelTier: overrideTier || directMode.modelTier || 'fast',
                    attachments,
                    ...(history !== undefined ? { history } : {}),
                    ...getNotebookPayload?.(),
                    ...(directMode.systemPrompt ? { systemPrompt: directMode.systemPrompt } : {}),
                    imageGenSettings: scopedStorage.getJSON('imageGenSettings', {}),
                    nanoBananaSettings: scopedStorage.getJSON('nanoBananaSettings', {}),
                    disabledMedia: scopedStorage.getJSON('disabledMedia', {}),
                    webSearchEnabled: (() => {
                        const v = scopedStorage.getItem('webSearchEnabled');
                        return v === null ? true : v === 'true';
                    })(),
                    memoryWriteEnabled: (() => {
                        const v = scopedStorage.getItem('memoryWriteEnabled');
                        return v === null ? true : v === 'true';
                    })(),
                    ...(chatProjectId ? { projectId: chatProjectId } : {}),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    ...(typeof directMode.getExtraPayload === 'function' ? directMode.getExtraPayload() : {}),
                    ...(Array.isArray(activeSkillIds) && activeSkillIds.length > 0 ? { activeSkillIds } : {}),
                    ...(reasoningEffort ? { reasoningEffort } : {}),
                };
            } else {
                // Agent chat mode — post to /agents/:id/chat/stream
                const wsPayload = getNotebookPayload?.() || {};
                payload = {
                    message: text,
                    agentId: selectedAgent?.id,
                    conversationId: currentConversation?.id,
                    attachments,
                    isHidden,
                    stream: true,
                    memoryWriteEnabled: (() => {
                        const v = scopedStorage.getItem('memoryWriteEnabled');
                        return v === null ? true : v === 'true';
                    })(),
                    webSearchEnabled: (() => {
                        const v = scopedStorage.getItem('webSearchEnabled');
                        return v === null ? true : v === 'true';
                    })(),
                    ...wsPayload,
                    ...(chatProjectId ? { projectId: chatProjectId } : {}),
                    ...(overrideTier ? { modelTier: overrideTier } : {}),
                    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    // History rule, agent path:
                    //   - Edit/retry: send `historyOverride` so the server can
                    //     truncate the conversation to the edit point.
                    //   - TESTCHAT: send the in-memory history. Een testchat is
                    //     EFEMEER — de server schrijft geen rij en bouwt de
                    //     conversatie als `{ …, messages: [] }`, dus zonder deze
                    //     regel begint elke testbeurt vanaf nul: beurt 3 kan niet
                    //     naar beurt 1 verwijzen, een vastgehouden actie wordt
                    //     nooit opnieuw voorgesteld en de goedkeuring wordt dus
                    //     nooit verbruikt. EmbedChat — de andere efemere surface
                    //     — doet dit al om exact deze reden.
                    //   - Anders: geen history; de server leest de durable rij.
                    ...(historyOverride || testChatRef.current?.enabled ? {
                        history: (historyOverride || messagesRef.current)
                            .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
                            .map(m => ({
                                role: m.role,
                                content: m.content,
                                ...(m.attachments && m.attachments.length > 0 ? { attachments: (m.attachments as ChatAttachment[]).map(toHistoryAttachment) } : {})
                            }))
                    } : {}),
                    ...(reasoningEffort ? { reasoningEffort } : {}),
                    // ── Testchat (A4) ───────────────────────────────────
                    // `test: true` draait deze beurt op het CONCEPT en houdt
                    // hem uit de historie; `asGroup` is het bestaande A1c-pad
                    // en rijdt mee in dezelfde body.
                    //
                    // `testSessionId` is de sleutel waarmee de server zijn
                    // efemere conversatie-id STABIEL houdt over de beurten van
                    // één testgesprek. Zonder die sleutel mint hij per REQUEST
                    // een nieuwe id, en dan telt `COUNT(DISTINCT
                    // conversation_id)` beurten in plaats van gesprekken:
                    // "6 testgesprekken" voor één gesprek van zes berichten.
                    //
                    // De beslissingen gaan ÉÉN keer mee — hieronder wordt de
                    // outbox meteen geleegd, want de server verbruikt ze per
                    // actie en een client die ze blijft herhalen koopt met één
                    // klik elke volgende beurt.
                    ...(testChatRef.current?.enabled ? {
                        test: true,
                        testSessionId: testSessionIdRef.current,
                        ...(testChatRef.current.asGroup ? { asGroup: testChatRef.current.asGroup } : {}),
                        ...(Object.keys(toolDecisionsRef.current).length > 0 ? {
                            toolDecisions: Object.entries(toolDecisionsRef.current)
                                .map(([argsKey, decision]) => ({ argsKey, decision })),
                        } : {}),
                    } : {}),
                };
                // De outbox is nu in de body geschreven. Legen — verzonden is
                // verbruikt. De LEDGER blijft staan, zodat de kaart waarop
                // geklikt is zijn kleur houdt.
                if (testChatRef.current?.enabled) toolDecisionsRef.current = {};
            }

            // Chat signals: only a counted endpoint asks for the marker, and a
            // test chat is never counted, so it carries none.
            const signalsSurface = testChatRef.current?.enabled ? null : chatSignalsSurfaceFor(turnPath);
            const signalsExtra = signalsSurface ? getChatSignalsPayloadRef.current?.(signalsSurface) ?? null : null;
            if (signalsExtra) Object.assign(payload, signalsExtra);

            const response = await authFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (response.status === 403 || response.status === 401) {
                // Permissions were revoked while the user had the agent open.
                // Show a clear message rather than a generic error.
                setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId ? {
                        ...m,
                        isStreaming: false,
                        isError: true,
                        isPermissionDenied: true,
                        content: "⚠️ **Access denied** — you no longer have permission to use this agent. Please refresh the page."
                    } : m
                ));
                setIsLoading(false);
                return;
            }

            if (!response.ok) throw new Error('Failed to send message');

            const reader = response.body!.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let currentEvent = '';

            const processLine = (rawLine: string) => {
                // Per the SSE spec the space after the colon is OPTIONAL, and a
                // proxy may re-frame the stream with CRLF. Matching only the
                // literal 'event: '/'data: ' with LF meant a spec-legal
                // 'data:{…}' or a CR-terminated line parsed as zero events —
                // the same blank-bubble failure as a truncated stream, with no
                // error to explain it. Normalise before dispatching.
                const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                if (line.startsWith('event:')) {
                    currentEvent = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                    try {
                        const data = JSON.parse(line.slice(5).replace(/^ /, ''));

                        // Note any event that represents real progress, so a
                        // later stream drop can be reported as "interrupted"
                        // rather than a blanket failure (BFSF-221).
                        if ([
                            'content', 'content_replace', 'tool_start', 'tool_end',
                            'webpage_doc_update', 'webpage_doc_partial', 'webpage_extra_update',
                            'workspace_update', 'notebook_doc_update', 'slides_deck_update',
                            'sheet_update', 'image', 'calendar_draft', 'linkedin_draft',
                            'document_update',
                        ].includes(currentEvent)) {
                            producedWork = true;
                        }
                        if (currentEvent === 'done') sawDone = true;

                        // Capture WHAT was produced (kind + best-known title) so the
                        // interrupted/error notices can name it. Latest event wins; a
                        // titleless follow-up of the same kind keeps the earlier title.
                        const kind = WORK_EVENT_KINDS[currentEvent];
                        if (kind) {
                            const prev = workRef.current;
                            const title = data.title
                                || (currentEvent === 'workspace_update' ? extractMdHeading(data.content) : null)
                                || (prev?.kind === kind ? prev.title : null);
                            workRef.current = { kind, title };
                        }

                        // Handle direct-chat specific events
                        if (isDirectMode) {
                            if (currentEvent === 'conversation_created' && data.conversationId) {
                                onDirectConversationCreated?.({ conversationId: data.conversationId });
                            } else if (currentEvent === 'title' && data.title) {
                                onDirectConversationCreated?.({ conversationId: data.conversationId, title: data.title });
                            }
                        }

                        handleSSEEventRef.current(currentEvent, data, {
                            assistantMsgId,
                            userMsgId: msgId,
                            activeIdRef,
                            contentRef,
                            flusher,
                            workRef
                        });
                    } catch (e) {
                        console.debug('[useChatEngine] SSE event parse skipped', currentEvent, e);
                    }
                }
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) processLine(line);
            }

            // Drain the decoder and process any final event left in the buffer.
            // The server's terminal `done` event can arrive in the last chunk
            // without a trailing newline; breaking on `done` without flushing left
            // the message stuck in isStreaming:true so the notebook edit was never
            // applied and the chat never finalized (BFSF-177).
            buffer += decoder.decode();
            if (buffer) {
                for (const line of buffer.split('\n')) processLine(line);
            }

            // Commit any final buffered tokens if the stream ended without a
            // terminal 'done' event (it preserves m.content otherwise).
            flusher.flushNow();

            // A stream that ends without the server's terminal `done` was CUT,
            // not completed — and reader.read() cannot tell us that.
            //
            // The connector frames SSE responses with `Connection: close` and
            // no Content-Length (nextcloud-connector/src/proxy.js), because
            // Nextcloud's AppAPI proxy mangles chunked encoding. Close-framing
            // has no wire-level completeness signal, so a stream truncated at
            // byte 0 arrives here as a perfectly successful 200 with an empty
            // body. Finalising that silently is what left a blank assistant
            // bubble with the action row and no error anywhere on screen.
            //
            // `done` is the only end-of-turn marker we actually control, so
            // treat its absence as an abnormal end and run the same
            // interrupted/error handling a thrown stream gets — including the
            // recovery poll, since the server persists the finished reply even
            // when the connection dies.
            if (!sawDone) {
                console.warn('[useChatEngine] stream ended without a terminal `done` event — treating as interrupted');
                finishAbnormally();
            } else {
                setIsLoading(false);
                setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId ? { ...m, isStreaming: false } : m
                ));
            }

        } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            // Commit buffered tokens before the interrupt/error branch reads
            // m.content, so the prior content prepended to the notice is complete.
            flusher.flushNow();
            if (err.name !== 'AbortError' && sawDone) {
                // The turn already finished on the server. Close the message out
                // quietly rather than appending a notice to a complete answer.
                console.debug('[useChatEngine] stream teardown after done', err);
                setMessages(prev => prev.map(m =>
                    m.id === assistantMsgId ? { ...m, isStreaming: false } : m
                ));
                setIsLoading(false);
            } else if (err.name !== 'AbortError') {
                console.error("Chat error", err);
                finishAbnormally();
            }
        } finally {
            // Release the controller once the stream is done (success, error, or
            // abort). Leaving it set means the next send would needlessly call
            // .abort() on an already-finished controller.
            if (abortControllerRef.current === controller) {
                abortControllerRef.current = null;
            }
            // The stream is over (success, error or abort), so it no longer
            // needs to survive an unmount.
            releaseStream(streamKey);
            // Drop the flusher reference (guard against a newer concurrent stream
            // having replaced it) so stopGenerating can't act on a dead stream.
            flusher.cancel();
            if (activeFlusherRef.current === flusher) {
                activeFlusherRef.current = null;
            }
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

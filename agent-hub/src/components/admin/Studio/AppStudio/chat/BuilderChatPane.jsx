import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, History, ImagePlus, RotateCcw, Send, Sparkles, Square, Undo2, Wrench, X } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import AppBuilderActivity from './AppBuilderActivity';
import { planReveal } from '../editor/revealQueue';
import { useReducedMotion } from '../../../../../hooks/useReducedMotion';
import { IMAGE_ACCEPT_ATTR, MAX_IMAGES_PER_TURN, imageFilesFrom, prepareComposerImages } from './composerImages';
import { diffDefinitions } from './draftDiff';
import PlanCard from './PlanCard';
import QuickActions from './QuickActions';
import useAppBuilderStream from '../../../../../hooks/useAppBuilderStream';
import useModelTierSelection from '../../../../../hooks/useModelTierSelection';
import useTranslation from '../../../../../hooks/useTranslation';
import ModelTierSelector from '../../../../licensing/ModelTierSelector';
import BuilderWaitingCard from '../../../../shared/builder/BuilderWaitingCard';
import { modelKeyFor, recordTtft } from '../../../../shared/builder/timeToFirstToken';
import toast from '../../../../shared/Toast';
import MessageBubble from '../../../../automation/Builder/chat/MessageBubble';
import useStickToBottom from '../../../../../hooks/useStickToBottom';
import { useEditorChrome } from '../editor/EditorChromeContext';
import { useAppEditor } from '../state/AppEditorContext';
import { findNode, findScreen } from '../state/definitionOps';
import { describeAppToolCall } from './appToolCallDisplay';

/**
 * The table a node is bound to, if any — from a record/records source binding
 * or a relation input's tableId. Used to ground an AI turn on the selection.
 */
function boundTableIdFor(definition, nodeId) {
    if (!definition || !nodeId) return null;
    const found = findNode(definition, nodeId);
    const props = found?.node?.props;
    if (!props) return null;
    const src = props.source;
    if (src && typeof src === 'object' && (src.kind === 'records' || src.kind === 'record') && src.tableId) {
        return src.tableId;
    }
    return typeof props.tableId === 'string' ? props.tableId : null;
}

/**
 * App Studio — the AI builder chat pane (the editor shell's left `chatSlot`).
 *
 * Owns the conversational side of an AI turn and wires it into the editor's
 * single-authority data flow:
 *   - send        → set_stream_lock(true); the canvas goes read-only and the
 *                   shell pauses autosave + hotkeys for the whole turn.
 *   - draft (SSE) → transient set_definition (NO history commit) and pulse
 *                   the nodes THIS draft added via set_recent_ids (diffed
 *                   against the previous draft of the turn, so a cell pulses
 *                   once). Following the AI to the screen it is building is
 *                   the canvas's job (editor/useBuildFollow reads the build
 *                   cue), not this pane's.
 *   - done        → exactly ONE history commit for the whole turn
 *                   (chrome.commitTurn), then markSaved — the builder route
 *                   already persisted every draft, so autosave must not
 *                   re-save — then unlock.
 *   - error       → unlock but keep the last draft (it is persisted
 *                   server-side); toast + a chat error item.
 */

// React-query cache families that render the app's DATA side. When the AI
// mutates tables/rows/roles/datasets mid-stream (`data_model` SSE event),
// every family is invalidated so the canvas, TablesManager, QueryBuilder and
// RolesManager reflect the AI's work live. Keys must match:
//   bi/useAppTables.js         → ['studio-app-tables', appId]
//   bi/useDatasets.js          → ['studio-app-datasets', appId]
//   rbac/useAppRoles.js        → ['studio-app-schema', appId] + ['studio-app-members', appId]
//   runtime/useAppDataSource.js / AppDataScope → ['studio-app-data', appId]
const DATA_QUERY_KEY_FAMILIES = (appId) => [
    ['studio-app-tables', appId],
    ['studio-app-datasets', appId],
    ['studio-app-schema', appId],
    ['studio-app-members', appId],
    ['studio-app-data', appId],
];

// Wave 6c: map the builder route's SSE error-taxonomy `code` to product copy
// and a retry affordance. `canRetry` gates a "Try again" button on the error
// item (only for the codes where re-sending the same turn can plausibly work).
// Unknown/absent codes fall back to the raw server/drop message (existing
// behaviour) so nothing regresses.
// Keyed, not bare: every code's copy lives in both dictionaries so the pane
// answers in Dutch with the rest of the editor (i18nGuard check 8 hunts the
// bare-English table this used to be).
const ERROR_COPY = {
    subscription_limit: { key: 'app_studio.builder.chat.err_subscription_limit', en: "You've reached your plan's AI limit. Upgrade your plan to keep building with AI.", canRetry: false },
    rate_limited: { key: 'app_studio.builder.chat.err_rate_limited', en: "You're sending build requests too quickly. Wait a moment, then try again.", canRetry: true },
    model_unavailable: { key: 'app_studio.builder.chat.err_model_unavailable', en: 'The AI model is unavailable right now. Try again shortly, or pick a different model tier.', canRetry: true },
    transient_upstream: { key: 'app_studio.builder.chat.err_transient_upstream', en: 'The AI provider had a brief hiccup. Your progress is saved — try again in a moment.', canRetry: true },
    model_rejected: { key: 'app_studio.builder.chat.err_model_rejected', en: 'The AI model rejected the request. Your progress is saved — check the model or tier settings before trying again.', canRetry: false },
    model_truncated: { key: 'app_studio.builder.chat.err_model_truncated', en: 'The model ran out of room while reasoning and never got to building. Switch to a tier with thinking off, or shorten the request.', canRetry: false },
    model_empty_reply: { key: 'app_studio.builder.chat.err_model_empty_reply', en: 'The model stopped twice without calling a tool or saying anything — it wrote its next step as text instead of a call. Your draft is saved; send the message again, or switch to another tier.', canRetry: true },
    budget_exhausted: { key: 'app_studio.builder.chat.err_budget_exhausted', en: "I ran out of build turns for this request, but your progress is saved. Send another message and I'll keep going.", canRetry: true },
    validation_failed: { key: 'app_studio.builder.chat.err_validation_failed', en: "The app had validation errors the AI couldn't clear. Review the issues below and try again.", canRetry: false },
    save_conflict: { key: 'app_studio.builder.chat.err_save_conflict', en: 'The app changed in another tab while the AI was building. Reopen it and try again.', canRetry: false },
    internal: { key: 'app_studio.builder.chat.err_internal', en: 'The AI builder ran into an unexpected problem. Your progress is saved.', canRetry: false },
};

/** Every component on every screen — the number the build farewell reports. */
function countComponents(def) {
    let n = 0;
    const walk = (children) => { for (const c of children || []) { n += 1; if (Array.isArray(c.children)) walk(c.children); } };
    for (const scr of (def && def.screens) || []) for (const sec of scr.sections || []) walk(sec.children);
    return n;
}

/** Friendly copy + retry flag for a builder error `code`; falls back to `raw`. */
function friendlyBuilderError(code, raw, t = null) {
    const c = code && ERROR_COPY[code];
    if (c) return { message: t ? t(c.key, c.en) : c.en, canRetry: c.canRetry };
    return { message: raw || (t ? t('app_studio.builder.chat.err_generic', 'The AI builder ran into a problem.') : 'The AI builder ran into a problem.'), canRetry: false };
}

/**
 * Should a pane mounted with `autoSend` fire it? Once, at mount, on a pane
 * with no conversation yet and nothing in flight — the same rule as the
 * routine builder's canAutoSend. A host remounts the pane (React `key`) to
 * fire again. Pure.
 */
export function canAutoSendApp({ autoSend, messageCount, busy }) {
    return typeof autoSend === 'string' && autoSend.trim() !== '' && !busy && (messageCount || 0) === 0;
}

/**
 * @param {object} props
 * @param {string} props.appId
 * @param {string} [props.initialPrompt]  seeds the composer once (prefill; the user sends)
 * @param {string|null} [props.autoSend]  a brief this pane SENDS itself, once at mount,
 *   with planMode 'never' — the hook a page that drives the builder (Studio
 *   Playbooks) needs; `initialPrompt` only prefilled and no host could start a turn
 * @param {string|null} [props.forcedTier]  a tier pinned for every send of this mount;
 *   the picker shows it and cannot persist a change (Playbooks build on Fast)
 * @param {Function|null} [props.onTurnEnd]  ({ finalized, stopped, awaitingPlan, error, code })
 *   once per turn, from the stream's done or error
 * @param {Function|null} [props.onAppUpdated]  ({ id, name, description, icon }) whenever a draft
 *   changes the definition's meta — the AI's app_set_meta, or the finalize-time naming net.
 *   The editor header reads the app ROW's name (the manual rename path), so without this
 *   the title the AI chose only appears after a reload.
 */
export default function BuilderChatPane({ appId, initialPrompt = '', autoSend = null, forcedTier = null, onTurnEnd = null, onAppUpdated = null }) {
    const { t } = useTranslation();
    const { definition, screenId, selectedNodeId, selectedNodeIds, streamLock, dispatch } = useAppEditor();
    const chrome = useEditorChrome();
    const queryClient = useQueryClient();

    // Same tier machinery as the automations builder (shared hook + selector);
    // the choice persists per user and rides every turn incl. plan approvals.
    // taskType must NOT be 'direct_chat' — that list carries the chat-only
    // tiers (Flow, Swarm), which this builder can't run. 'automation' is the
    // builder task type: same non-chat filter, and it keeps the org's custom
    // tiers (they can only opt into the chat task types, so any other value
    // would strip them from the picker entirely).
    const { modelTiers, selectedTier, setSelectedTier } = useModelTierSelection({ storageKey: 'appBuilderTier', taskType: 'automation' });
    const tierForSend = forcedTier || selectedTier || 'auto';
    const onTurnEndRef = useRef(onTurnEnd);
    useEffect(() => { onTurnEndRef.current = onTurnEnd; });
    const onAppUpdatedRef = useRef(onAppUpdated);
    useEffect(() => { onAppUpdatedRef.current = onAppUpdated; });

    // Refs for the stream callbacks — SSE events fire between renders.
    const definitionRef = useRef(definition);
    const screenIdRef = useRef(screenId);
    const chromeRef = useRef(chrome);
    useEffect(() => {
        definitionRef.current = definition;
        screenIdRef.current = screenId;
        chromeRef.current = chrome;
    });

    const preTurnDefRef = useRef(null);  // baseline every draft diffs against
    const lastDraftRef = useRef(null);   // { definition, version } of the newest draft
    const lastTurnRef = useRef(null);    // { text, extraContext, sendOptions } for retry-after-error
    const doneInfoRef = useRef(null);    // how the last turn ended — the canvas banner's farewell reads it

    // The "What changed" summary for the just-finished turn: the diff between
    // the pre-turn baseline and the final draft, plus that final draft so a
    // clicked node can be resolved to its screen. Cleared when a new turn starts.
    const [lastChange, setLastChange] = useState(null);
    const [changeOpen, setChangeOpen] = useState(false);

    const reducedMotion = useReducedMotion();
    const reducedMotionRef = useRef(reducedMotion);
    useEffect(() => { reducedMotionRef.current = reducedMotion; }, [reducedMotion]);
    // What the canvas is dealing: the last plan and when it started, for the
    // camera and the banner (published as part of the build cue).
    const [reveal, setReveal] = useState(null);

    const handleDraft = useCallback((def, version, _appId, meta) => {
        if (!def) return;
        // PER-CALL reveal: this draft is diffed against the previous draft of
        // the turn, not the pre-turn baseline. The cumulative diff re-added
        // every id of the turn on every draft, so cells whose pulse had ended
        // pulsed again with each later batch (2026-09-13). The pre-turn
        // baseline still serves "What changed" in handleDone.
        const prev = lastDraftRef.current;
        lastDraftRef.current = { definition: def, version };
        const revealBaseline = prev ? prev.definition : (preTurnDefRef.current || definitionRef.current);

        // Transient apply — history records the whole turn once, on done.
        dispatch({ type: 'set_definition', definition: def });

        // The name/description/icon the AI set (or the server derived at
        // finalize) reach the editor chrome now, not on the next reload:
        // the header shows the app ROW's name, and syncCardMeta only updates
        // the row server-side.
        const metaBefore = (revealBaseline && revealBaseline.meta) || {};
        const metaAfter = def.meta || {};
        if (['name', 'description', 'icon'].some((k) => metaBefore[k] !== metaAfter[k])) {
            onAppUpdatedRef.current?.({ id: appId, name: metaAfter.name, description: metaAfter.description, icon: metaAfter.icon });
        }

        const diff = diffDefinitions(revealBaseline, def);
        // The film: what this draft added is dealt one card at a time, in the
        // order the model wrote it (the tool_call's `added`), each cell holding
        // its slot invisibly until its turn. New screens ring their tab pill.
        // Which screen the canvas shows is decided there (useBuildFollow) from
        // the same cue — this pane never switches screens mid-build.
        const hintIds = (meta && meta.lastCall && Array.isArray(meta.lastCall.added)) ? meta.lastCall.added.map((a) => a && a.id).filter(Boolean) : [];
        const plan = planReveal({ diff, definition: def, hintIds, reducedMotion: reducedMotionRef.current });
        if (plan.ids.length || plan.screens.length) {
            dispatch({ type: 'set_recent_ids', ids: [...plan.ids, ...plan.screens], delays: plan.animate ? plan.delays : null });
            setReveal({ plan, at: Date.now() });
        }
    }, [dispatch, appId]);

    const handleDone = useCallback((info = {}) => {
        // The farewell reads how the turn ended; cleared when the next turn starts.
        doneInfoRef.current = { finalized: !!info.finalized, stopped: !!info.stopped, at: Date.now() };
        onTurnEndRef.current?.({ finalized: !!info.finalized, stopped: !!info.stopped, awaitingPlan: !!info.awaitingPlan, error: null, code: null });
        const last = lastDraftRef.current;
        const baseline = preTurnDefRef.current;
        lastDraftRef.current = null;
        preTurnDefRef.current = null;
        // A plan proposal: the PlanCard takes over, so no history entry (there
        // is nothing to undo yet). A research pass may still have persisted a
        // draft though — adopt its version, or the next autosave sends a stale
        // baseVersion and the user hits a save conflict.
        if (info.awaitingPlan) {
            if (last) {
                chromeRef.current?.markSaved?.(last.definition, last.version);
                if (last.version != null) dispatch({ type: 'set_version', version: last.version });
            }
            dispatch({ type: 'set_stream_lock', streamLock: false });
            return;
        }
        if (last) {
            // ONE history entry for the whole AI turn (Cmd+Z undoes it all)…
            chromeRef.current?.commitTurn?.(last.definition);
            // …and the server already persisted every draft: adopt, don't re-save.
            chromeRef.current?.markSaved?.(last.definition, last.version);
            if (last.version != null) dispatch({ type: 'set_version', version: last.version });
            // Post-turn "What changed" summary — diff the pre-turn baseline
            // against the final draft (the same diff the per-draft pulse uses).
            const diff = diffDefinitions(baseline, last.definition);
            if (diff.addedIds.size || diff.changedIds.size) {
                setLastChange({ diff, finalDef: last.definition });
                setChangeOpen(false);
            }
        }
        dispatch({ type: 'set_stream_lock', streamLock: false });
    }, [dispatch]);

    const handleError = useCallback((message, code) => {
        const last = lastDraftRef.current;
        lastDraftRef.current = null;
        preTurnDefRef.current = null;
        if (last) {
            // A failed turn still applied a draft to the canvas — record it as
            // ONE history entry (exactly like a successful turn) so the first
            // Cmd+Z lands on the pre-turn state instead of jumping past it.
            // commitTurn also clears the shell's pre-turn snapshot.
            chromeRef.current?.commitTurn?.(last.definition);
            // Keep the last draft on the canvas — it is persisted server-side,
            // so make sure autosave doesn't write it again.
            chromeRef.current?.markSaved?.(last.definition, last.version);
            if (last.version != null) dispatch({ type: 'set_version', version: last.version });
        }
        dispatch({ type: 'set_stream_lock', streamLock: false });
        onTurnEndRef.current?.({ finalized: false, stopped: false, awaitingPlan: false, error: message || 'error', code: code || null });
        // The transcript's ErrorItem shows the friendly copy + retry; the toast
        // is the transient fallback — prefer the code's copy, else the raw text.
        toast.error(friendlyBuilderError(code, message, t).message);
    }, [dispatch, t]);

    // The AI created/changed tables, rows, roles or datasets — refresh every
    // cache family that renders them so the editor reflects it immediately.
    const handleDataModel = useCallback(() => {
        for (const queryKey of DATA_QUERY_KEY_FAMILIES(appId)) {
            queryClient.invalidateQueries({ queryKey });
        }
    }, [queryClient, appId]);

    const {
        messages, running, send, stop, lastValidation, pendingPlan, phases, checkpoints, continuation,
        turn, engine, toolDraft, todos,
    } = useAppBuilderStream({
        appId,
        onDraft: handleDraft,
        onDone: handleDone,
        onError: handleError,
        onDataModel: handleDataModel,
    });

    // ---- composer ------------------------------------------------------------
    // initialPrompt (e.g. a "Remix with AI" prefill) seeds the composer once so
    // the user can tweak and send, rather than firing a turn unprompted.
    const [input, setInput] = useState(initialPrompt || '');
    // Screenshots the user is showing the builder ("make it look like this"),
    // staged until send. Ctrl+V of a screenshot is the primary path; the attach
    // button is the discoverable one.
    const [images, setImages] = useState([]);
    // Read by the async staging path (which starts before the next render) so
    // back-to-back pastes count against the same budget.
    const imagesRef = useRef(images);
    useEffect(() => { imagesRef.current = images; }, [images]);
    // A turn is being prepared (the pre-turn flush is still saving). The canvas
    // isn't locked yet, so this is what keeps the UI closed until it is.
    const [starting, setStarting] = useState(false);
    const busy = running || streamLock || starting;

    // Refs so startTurn reads the LIVE selection without re-binding every chip.
    const selectionRef = useRef({ selectedNodeId, selectedNodeIds });
    useEffect(() => { selectionRef.current = { selectedNodeId, selectedNodeIds }; });

    // The editor's current focus (selection / screen / bound table), merged
    // with any `extraContext` override (e.g. a per-issue Fix targeting a node).
    const buildContext = useCallback((extraContext) => {
        const def = definitionRef.current;
        const { selectedNodeId: anchor, selectedNodeIds: ids } = selectionRef.current;
        const idList = ids instanceof Set ? [...ids] : [];
        return {
            screenId: screenIdRef.current,
            selectedNodeIds: idList,
            boundTableId: boundTableIdFor(def, anchor || idList[idList.length - 1] || null),
            ...(extraContext && typeof extraContext === 'object' ? extraContext : {}),
        };
    }, []);

    // Persist any pending local edit BEFORE the AI reads the app, then lock and
    // fire `run`. The builder reads the definition from the DB, and locking
    // pauses autosave, so an unsaved edit would be invisible to the AI and then
    // overwritten by the turn's markSaved. The lock therefore lands only AFTER
    // flush() resolves — locking first would strand the in-flight edit; until
    // then `starting` stands in for it so no second turn can begin.
    const lockAndRun = useCallback((run) => {
        preTurnDefRef.current = definitionRef.current;
        doneInfoRef.current = null;
        setLastChange(null);
        setStarting(true);
        const go = () => {
            dispatch({ type: 'set_stream_lock', streamLock: true });
            setStarting(false);
            run();
        };
        Promise.resolve(chromeRef.current?.flush?.()).then(go, go);
    }, [dispatch]);

    /**
     * Start one AI turn with `text`, threading editor focus as context.
     * `sendOptions` passes stream options through (e.g. quick actions force
     * `planMode:'never'`). Goes through the SAME streamLock/flush/commitTurn
     * flow as a typed message.
     */
    const startTurn = useCallback((text, extraContext, sendOptions) => {
        const message = typeof text === 'string' ? text.trim() : '';
        // An attached picture is a complete ask on its own ("build this"), so a
        // turn needs text OR images.
        const attached = Array.isArray(sendOptions?.images) ? sendOptions.images.filter(Boolean) : [];
        if ((!message && !attached.length) || busy) return;
        // Remember the turn so a retryable error (Wave 6c) can re-run it verbatim.
        lastTurnRef.current = { text: message, extraContext, sendOptions };
        const context = buildContext(extraContext);
        lockAndRun(() => send(message, { modelTier: tierForSend, context, ...(sendOptions || {}) }));
    }, [busy, send, buildContext, lockAndRun, tierForSend]);

    // A host's brief, sent once at mount (canAutoSendApp): the pane is fresh
    // (no messages, nothing in flight), so this is the first turn of a phase.
    // The ref survives re-renders and StrictMode's double effect; a new phase
    // is a new mount (the host's `key`). Rehydrated history that lands later
    // does not undo a send already made.
    const autoSentRef = useRef(false);
    const sendBrief = useEffectEvent(() => startTurn(autoSend, undefined, { planMode: 'never' }));
    useEffect(() => {
        if (autoSentRef.current) return;
        if (!canAutoSendApp({ autoSend, messageCount: messages.length, busy })) return;
        autoSentRef.current = true;
        sendBrief();
    }, [autoSend, busy, messages.length]);

    // "Try again" on a retryable error item: re-run the last turn verbatim.
    const retryLastTurn = useCallback(() => {
        const lt = lastTurnRef.current;
        if (!lt || busy) return;
        startTurn(lt.text, lt.extraContext, lt.sendOptions);
    }, [busy, startTurn]);

    /**
     * Approve the (possibly edited) plan from the PlanCard — the AI builds the
     * artifact the user confirmed. Same lock/flush/commit flow as a turn.
     */
    const approvePlan = useCallback((editedPlan) => {
        if (busy || !pendingPlan) return;
        const context = buildContext();
        lockAndRun(() => send({
            plan: { planId: pendingPlan.planId, action: 'approve', plan: editedPlan },
            modelTier: tierForSend,
            context,
        }));
    }, [busy, pendingPlan, send, buildContext, lockAndRun, tierForSend]);

    // Stage image files from a paste, a drop or the file picker. Errors are
    // per-file, so one unusable screenshot never swallows the rest.
    const stageImageFiles = useCallback(async (files) => {
        if (!files || !files.length) return;
        const staged = imagesRef.current;
        const { images: added, errors } = await prepareComposerImages(files, staged.length);
        if (added.length) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES_PER_TURN));
        for (const err of errors) toast.error(err);
    }, []);

    // Ctrl+V of a screenshot — the primary way a user shows the builder what
    // they want. Only swallow the paste when it actually carries an image, so
    // pasting text keeps working exactly as before.
    const onComposerPaste = useCallback((e) => {
        if (busy) return;
        const files = imageFilesFrom(e.clipboardData);
        if (!files.length) return;
        e.preventDefault();
        stageImageFiles(files);
    }, [busy, stageImageFiles]);

    const fileInputRef = useRef(null);
    const onPickFiles = useCallback((e) => {
        const files = e.target.files;
        stageImageFiles(files);
        // Reset so picking the SAME file twice still fires a change event.
        e.target.value = '';
    }, [stageImageFiles]);

    const removeImage = useCallback((id) => {
        setImages((prev) => prev.filter((img) => img.id !== id));
    }, []);

    const handleSend = useCallback(() => {
        const text = input.trim();
        const attached = images.map((img) => img.dataUrl);
        if ((!text && !attached.length) || busy) return;
        setInput('');
        setImages([]);
        startTurn(text, undefined, attached.length ? { images: attached } : undefined);
    }, [input, images, busy, startTurn]);

    // "Discuss" on the plan card just moves the user to the composer to talk it
    // over before building — the card stays put.
    const composerRef = useRef(null);
    const focusComposer = useCallback(() => {
        composerRef.current?.focus?.();
    }, []);

    // "What changed" click-to-select: jump to a node the turn touched. Resolve
    // its screen from the final draft so the canvas follows.
    const selectChangedNode = useCallback((nodeId) => {
        const def = lastChange?.finalDef;
        if (!def || !nodeId) return;
        const found = findNode(def, nodeId);
        if (found) {
            if (found.screen?.id) dispatch({ type: 'set_screen', screenId: found.screen.id });
            dispatch({ type: 'select_node', nodeId });
        } else if (findScreen(def, nodeId)) {
            // The id is a screen itself (a brand-new screen) — just go there.
            dispatch({ type: 'set_screen', screenId: nodeId });
        }
    }, [lastChange, dispatch]);

    // "Undo turn" is good for exactly one click: the turn's single history
    // entry. Once it is undone the summary describes state that no longer
    // exists, and a second undo would swallow the user's OWN previous edit —
    // so the summary (and with it the button) goes away.
    const undoTurn = useCallback(() => {
        chromeRef.current?.undoTurn?.();
        setLastChange(null);
    }, []);

    // "Revert to checkpoint": the version-history modal lives in EditorHeader
    // and isn't reachable from the chat pane, so point the user at it. (Noted
    // as a leftover — a chrome.openVersions handle would let us open it here.)
    const revertToCheckpoint = useCallback(() => {
        toast.info('Open “Version history” in the editor header to restore a checkpoint.');
    }, []);

    const onComposerKeyDown = useCallback((e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    // Follow the build — a new tool-call row, the plan card, markdown that
    // lands a beat late — but only while the reader is at the bottom. The old
    // hard `scrollTop = scrollHeight` on [messages, running] did neither: it
    // fired before the content was laid out, and it yanked anyone who had
    // scrolled up to re-read (owner, 2026-09-16).
    const listRef = useRef(null);
    const listBodyRef = useRef(null);
    const { onScroll, forceStick } = useStickToBottom({ containerRef: listRef, contentRef: listBodyRef });
    useEffect(() => { if (running) forceStick(); }, [running, forceStick]);

    const showEmptyState = messages.length === 0 && !running && !pendingPlan;
    const currentPhase = phases.length ? phases[phases.length - 1] : null;

    // ── The silence before the first token ───────────────────────────────
    // On a local model that silence is minutes: the model is reading a prompt
    // the size of a short book. The waiting card shows what HAS happened
    // (request sent, session opened, heartbeats, the real reading bar) and how
    // long this usually takes, instead of a bare "Thinking…" that read as a
    // hang. It drops as soon as anything streams in.
    const [buildStart, setBuildStart] = useState(() => ({ running: !!running, at: running ? Date.now() : null }));
    if (buildStart.running !== !!running) {
        setBuildStart({ running: !!running, at: running ? Date.now() : buildStart.at });
    }
    const tailAssistant = [...messages].reverse().find((m) => m && m.role === 'assistant' && !m.kind);
    const nothingStreamedYet = !(tailAssistant
        && ((tailAssistant.content && tailAssistant.content.length)
            || (tailAssistant.thinkingParts && tailAssistant.thinkingParts.length)
            || (tailAssistant.toolCalls && tailAssistant.toolCalls.length)));
    const waitingForFirstToken = !!running && !turn?.firstEventAt && nothingStreamedYet;
    // Its own TTFT bucket: the App Studio prompt is a different size than the
    // routine builder's, so a shared history would mis-estimate both.
    const waitModelKey = `app:${modelKeyFor(turn, tierForSend)}`;
    const ttftFiledForRef = useRef(null);
    useEffect(() => {
        if (!turn?.firstEventAt || !turn.sentAt || ttftFiledForRef.current === turn.sentAt) return;
        ttftFiledForRef.current = turn.sentAt;
        recordTtft(`app:${modelKeyFor(turn, tierForSend)}`, turn.firstEventAt - turn.sentAt);
    }, [turn, tierForSend]);
    // ── The build cue for the canvas (banner, ghost cell, camera) ────────
    // Built once per tool call / plan / turn milestone — keyed on the last
    // assistant message's toolCalls ARRAY, never its streaming text — so the
    // canvas does not re-render on every character. Published through the
    // shell (chrome.publishBuildCue) to BuildCueContext.
    const lastToolCalls = tailAssistant ? tailAssistant.toolCalls : null;
    const cue = useMemo(() => {
        if (!running && !doneInfoRef.current) return null;
        const calls = Array.isArray(lastToolCalls) ? lastToolCalls : [];
        const lastOk = [...calls].reverse().find((c) => c && c.ok !== false) || null;
        const lastAny = calls.length ? calls[calls.length - 1] : null;
        const described = lastOk ? describeAppToolCall(lastOk) : null;
        const def = definitionRef.current;
        const componentCount = countComponents(def);
        return {
            running: !!running,
            startedAt: buildStart.at,
            phase: lastOk && lastOk.name === 'app_finalize' ? 'finishing' : (lastOk && lastOk.name === 'app_dry_run' ? 'checking' : 'building'),
            lastCall: described ? { name: lastOk.name, title: described.title, detail: described.detail, added: described.added, ok: true } : null,
            skipped: lastAny && lastAny.ok === false && lastAny === calls[calls.length - 1] ? (lastAny.error || lastAny.summary || null) : null,
            todos,
            phaseInfo: currentPhase,
            engine,
            turn,
            toolDraft,
            reveal,
            finalized: !!(doneInfoRef.current && doneInfoRef.current.finalized),
            stopped: !!(doneInfoRef.current && doneInfoRef.current.stopped),
            componentCount,
            screenCount: ((def && def.screens) || []).length,
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the toolCalls array identity, the todos list and the turn milestones, not the streaming text
    }, [running, lastToolCalls, todos, currentPhase, engine, turn, toolDraft, reveal, buildStart.at]);
    useEffect(() => { chromeRef.current?.publishBuildCue?.(cue); }, [cue]);

    return (
        <div className="flex h-full min-h-0 flex-col" style={{ background: 'var(--bg-primary)' }}>
            {/* Header */}
            <div
                className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
                style={{ borderColor: 'var(--border-default)' }}
            >
                <span
                    className="flex h-7 w-7 items-center justify-center rounded-lg"
                    style={{
                        background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
                        color: 'var(--accent-primary)',
                    }}
                >
                    <Sparkles size={14} aria-hidden="true" />
                </span>
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {t('app_studio.builder.chat.title', 'AI builder')}
                </span>
            </div>

            {/* Messages */}
            <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 custom-scrollbar">
                {showEmptyState ? (
                    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
                        <span
                            className="flex h-10 w-10 items-center justify-center rounded-full"
                            style={{
                                background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)',
                                color: 'var(--accent-primary)',
                            }}
                        >
                            <Sparkles size={18} aria-hidden="true" />
                        </span>
                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t('app_studio.builder.chat.empty_title', 'Build with AI')}
                        </p>
                        <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
                            {t('app_studio.builder.chat.empty_hint', "Describe the app you want — I'll build it on the canvas")}
                        </p>
                    </div>
                ) : (
                    <div ref={listBodyRef} className="flex w-full flex-col gap-3">
                        {/* The model's own checklist (app_set_plan) is NOT here
                            (owner, 2026-09-16): it rides on the canvas, where
                            the build is, instead of scrolling away with the
                            conversation. The shell draws it from the build cue
                            this pane publishes (AppEditorShell). */}
                        {messages.map((item, i) => {
                            if (item?.kind === 'image') return <ScreenshotItem key={i} item={item} />;
                            if (item?.kind === 'error') {
                                // Only the newest error item gets the retry button —
                                // retrying re-runs the LAST turn, so an old item
                                // offering it would be misleading.
                                const isLatest = i === messages.length - 1;
                                return (
                                    <ErrorItem
                                        key={i}
                                        message={item.message}
                                        code={item.code}
                                        onRetry={isLatest ? retryLastTurn : null}
                                        disabled={busy}
                                    />
                                );
                            }
                            return (
                                <MessageBubble
                                    key={i}
                                    msg={item}
                                    activity={item.role === 'assistant'
                                        ? <AppBuilderActivity toolCalls={item.toolCalls} running={!!item.isStreaming && running} t={t} />
                                        : null}
                                />
                            );
                        })}

                        {/* The AI proposed an editable plan — approve or discuss it. */}
                        {pendingPlan ? (
                            <PlanCard
                                pendingPlan={pendingPlan}
                                onBuild={approvePlan}
                                onDiscuss={focusComposer}
                                disabled={busy}
                            />
                        ) : null}

                        {/* Phased-build progress. */}
                        {running && currentPhase ? (
                            <div className="self-start px-1 text-xs font-medium" style={{ color: 'var(--accent-primary)' }}>
                                {t('app_studio.builder.chat.phase_line', 'Building — phase {i}{total}{label}', { i: currentPhase.index, total: currentPhase.total ? `/${currentPhase.total}` : '', label: currentPhase.label ? `: ${currentPhase.label}` : '' })}
                            </div>
                        ) : null}

                        {/* Auto-continuation after a mid-plan budget exhaustion. */}
                        {continuation ? (
                            <div className="self-start px-1 text-xs italic" style={{ color: 'var(--text-tertiary)' }}>
                                {t('app_studio.builder.chat.continuing', 'Continuing{phase}…', { phase: continuation.phase ? ` (phase ${continuation.phase}${continuation.total ? `/${continuation.total}` : ''})` : '' })}
                            </div>
                        ) : null}

                        {/* Post-turn "What changed" summary. */}
                        {lastChange && !running ? (
                            <WhatChanged
                                change={lastChange}
                                open={changeOpen}
                                onToggle={() => setChangeOpen((o) => !o)}
                                onSelect={selectChangedNode}
                                onUndo={chrome?.undoTurn ? undoTurn : null}
                                onRevert={checkpoints.length ? revertToCheckpoint : null}
                            />
                        ) : null}

                        {waitingForFirstToken && (
                            <BuilderWaitingCard turn={turn} startedAt={buildStart.at} modelKey={waitModelKey} />
                        )}
                    </div>
                )}
            </div>

            <ValidationNotice
                validation={lastValidation}
                running={running}
                onFix={(message, nodeId) => startTurn(`Fix: ${message}`, nodeId ? { nodeId } : undefined)}
                disabled={busy}
            />

            <QuickActions
                onAction={(prompt, opts) => startTurn(prompt, undefined, opts)}
                disabled={busy}
                hasErrors={Array.isArray(lastValidation?.errors) && lastValidation.errors.length > 0}
            />

            {/* Composer */}
            <form
                className="shrink-0 border-t p-2"
                style={{ borderColor: 'var(--border-default)' }}
                onSubmit={(e) => { e.preventDefault(); handleSend(); }}
            >
                <div
                    className="flex flex-col gap-1.5 rounded-lg border px-2 py-1.5"
                    style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}
                >
                    {/* Staged screenshots, each with its own remove button. */}
                    <StagedImages images={images} onRemove={removeImage} disabled={busy} />

                    <div className="flex items-end gap-1.5">
                        <textarea
                            ref={composerRef}
                            rows={2}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={onComposerKeyDown}
                            onPaste={onComposerPaste}
                            disabled={busy}
                            data-app-ai-composer=""
                            placeholder={busy ? t('app_studio.builder.chat.placeholder_busy', 'The AI is building…') : t('app_studio.builder.chat.placeholder', 'Describe a change, or paste a screenshot…')}
                            aria-label={t('app_studio.builder.chat.composer_aria', 'Message the AI builder')}
                            className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none disabled:opacity-60"
                            style={{ color: 'var(--text-primary)' }}
                        />
                        {/* Attach: the discoverable twin of Ctrl+V. Hidden while a
                            build runs, like every other composer control. */}
                        {!busy ? (
                            <>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept={IMAGE_ACCEPT_ATTR}
                                    multiple
                                    onChange={onPickFiles}
                                    className="hidden"
                                    data-testid="app-builder-image-input"
                                    aria-hidden="true"
                                    tabIndex={-1}
                                />
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={images.length >= MAX_IMAGES_PER_TURN}
                                    aria-label={t('app_studio.builder.chat.attach', 'Attach an image')}
                                    title={images.length >= MAX_IMAGES_PER_TURN
                                        ? t('app_studio.builder.chat.attach_limit', 'You can attach up to {n} images', { n: MAX_IMAGES_PER_TURN })
                                        : t('app_studio.builder.chat.attach_title', 'Attach an image (or paste a screenshot)')}
                                    className="rounded-md p-1.5 transition-opacity disabled:opacity-40"
                                    style={{ color: 'var(--text-tertiary)' }}
                                >
                                    <ImagePlus size={16} aria-hidden="true" />
                                </button>
                            </>
                        ) : null}
                        {/* While a build runs every other control is disabled, so
                        Stop takes the Send slot — otherwise there is no way
                        out of a turn that is going the wrong way. */}
                        {busy ? (
                            <button
                                type="button"
                                onClick={stop}
                                aria-label={t('app_studio.builder.chat.stop', 'Stop')}
                                title={t('app_studio.builder.chat.stop_title', 'Stop building')}
                                className="rounded-md p-1.5 transition-opacity"
                                style={{ color: 'var(--accent-primary)' }}
                            >
                                <Square size={14} fill="currentColor" aria-hidden="true" />
                            </button>
                        ) : (
                            <button
                                type="submit"
                                disabled={!input.trim() && !images.length}
                                aria-label={t('app_studio.builder.chat.send', 'Send')}
                                title={t('app_studio.builder.chat.send_title', 'Send (Enter)')}
                                className="rounded-md p-1.5 transition-opacity disabled:opacity-40"
                                style={{ color: 'var(--accent-primary)' }}
                            >
                                <Send size={16} aria-hidden="true" />
                            </button>
                        )}
                    </div>
                </div>
                {Object.keys(modelTiers || {}).length > 0 && (
                    <div className="mt-1.5 flex items-center">
                        {/* portal: the composer sits at the pane's left edge, so an
                            absolute right-aligned panel would run off-screen. */}
                        <span
                            className={forcedTier ? 'pointer-events-none opacity-60' : undefined}
                            aria-disabled={forcedTier ? 'true' : undefined}
                            title={forcedTier ? t('app_studio.builder.chat.tier_pinned', 'The tier is set by the playbook') : undefined}
                        >
                            <ModelTierSelector
                                tiers={modelTiers}
                                value={tierForSend}
                                onChange={forcedTier ? () => {} : setSelectedTier}
                                variant="input"
                                portal
                            />
                        </span>
                    </div>
                )}
            </form>
        </div>
    );
}

/**
 * A picture in the transcript: one the AI took of the draft (SSE `image`
 * event) — kept so the user sees exactly what the AI judged, vision model or
 * not — or one the user attached (`fromUser`), which sits narrower and to the
 * right so the transcript still reads as a conversation.
 */
function ScreenshotItem({ item }) {
    const fromUser = !!item.fromUser;
    return (
        <figure
            className={`overflow-hidden rounded-lg border ${fromUser ? 'max-w-[70%] self-end' : 'w-full'}`}
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}
        >
            <img
                src={item.dataUrl}
                alt={item.caption || (fromUser ? 'Image you attached' : 'Screenshot of the app')}
                className="block w-full"
            />
            {item.caption ? (
                <figcaption className="px-2.5 py-1.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                    {item.caption}
                </figcaption>
            ) : null}
        </figure>
    );
}

/**
 * The composer's staged-image strip: a thumbnail per attached screenshot with
 * its own remove button. Cleared by the composer the moment the turn is sent.
 */
function StagedImages({ images, onRemove, disabled = false }) {
    if (!images.length) return null;
    return (
        <ul className="flex flex-wrap gap-1.5" data-staged-images="">
            {images.map((img) => (
                <li key={img.id} className="relative">
                    <img
                        src={img.dataUrl}
                        alt={img.name}
                        title={img.name}
                        className="h-14 w-14 rounded border object-cover"
                        style={{ borderColor: 'var(--border-default)' }}
                    />
                    <button
                        type="button"
                        onClick={() => onRemove(img.id)}
                        disabled={disabled}
                        aria-label={`Remove ${img.name}`}
                        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border shadow-sm transition-opacity disabled:opacity-40"
                        style={{
                            borderColor: 'var(--border-default)',
                            background: 'var(--bg-primary)',
                            color: 'var(--text-secondary)',
                        }}
                    >
                        <X size={10} aria-hidden="true" />
                    </button>
                </li>
            ))}
        </ul>
    );
}

/**
 * A failed turn — the toast is transient, this stays in the transcript. Maps
 * the server's error-taxonomy `code` (Wave 6c) to friendly copy and, for the
 * retryable codes, a "Try again" button that re-runs the last turn.
 */
function ErrorItem({ message, code, onRetry, disabled = false }) {
    const { t } = useTranslation();
    const { message: friendly, canRetry } = friendlyBuilderError(code, message, t);
    const showRetry = canRetry && typeof onRetry === 'function';
    return (
        <div
            className="flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-xs leading-relaxed"
            role="alert"
            style={{
                borderColor: 'rgba(239, 68, 68, 0.35)',
                background: 'color-mix(in srgb, var(--error) 8%, transparent)',
                color: 'var(--text-secondary)',
            }}
        >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--error)' }} aria-hidden="true" />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span>{friendly}</span>
                {showRetry ? (
                    <button
                        type="button"
                        onClick={() => onRetry()}
                        disabled={disabled}
                        className="inline-flex w-fit items-center gap-1 rounded border px-1.5 py-0.5 font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-40"
                        style={{ borderColor: 'color-mix(in srgb, var(--error) 40%, transparent)', color: 'var(--text-secondary)' }}
                    >
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        {t('app_studio.builder.chat.try_again', 'Try again')}
                    </button>
                ) : null}
            </div>
        </div>
    );
}

/**
 * Collapsible post-turn summary of what the AI touched: added/changed node
 * ids (click to jump to them), an "Undo turn" affordance (the shell's single
 * history.undo, exposed as chrome.undoTurn), and "Revert to checkpoint".
 */
function WhatChanged({ change, open, onToggle, onSelect, onUndo, onRevert }) {
    const { diff, finalDef } = change;
    const added = [...(diff.addedIds || [])];
    const changed = [...(diff.changedIds || [])].filter((id) => !diff.addedIds?.has(id));
    const total = added.length + changed.length;
    if (!total) return null;

    const rows = [
        ...added.map((id) => ({ id, kind: 'added' })),
        ...changed.map((id) => ({ id, kind: 'changed' })),
    ].slice(0, 12);
    const Chevron = open ? ChevronDown : ChevronRight;

    return (
        <div
            className="flex w-full flex-col rounded-lg border text-xs"
            data-what-changed=""
            style={{ borderColor: 'var(--border-default)', background: 'var(--bg-secondary)' }}
        >
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-left font-medium"
                style={{ color: 'var(--text-secondary)' }}
            >
                <Chevron size={13} className="shrink-0" aria-hidden="true" />
                What changed
                <span style={{ color: 'var(--text-tertiary)' }}>
                    {`· ${total} ${total === 1 ? 'update' : 'updates'}`}
                </span>
            </button>

            {open ? (
                <div className="flex flex-col gap-1.5 border-t px-2.5 py-2" style={{ borderColor: 'var(--border-default)' }}>
                    <ul className="flex flex-col gap-0.5">
                        {rows.map((row) => {
                            const type = findNode(finalDef, row.id)?.node?.type;
                            return (
                                <li key={`${row.kind}:${row.id}`}>
                                    <button
                                        type="button"
                                        onClick={() => onSelect?.(row.id)}
                                        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                                        style={{ color: 'var(--text-secondary)' }}
                                    >
                                        <span
                                            className="shrink-0 rounded px-1 text-[10px] font-medium"
                                            style={{
                                                background: row.kind === 'added'
                                                    ? 'color-mix(in srgb, var(--accent-primary) 18%, transparent)'
                                                    : 'rgba(148, 163, 184, 0.18)',
                                                color: row.kind === 'added' ? 'var(--accent-primary)' : 'var(--text-tertiary)',
                                            }}
                                        >
                                            {row.kind === 'added' ? 'new' : 'edit'}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate">{type || row.id}</span>
                                    </button>
                                </li>
                            );
                        })}
                        {total > rows.length ? (
                            <li className="px-1 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                                {`+${total - rows.length} more`}
                            </li>
                        ) : null}
                    </ul>
                    <div className="flex items-center gap-2 pt-0.5">
                        {onUndo ? (
                            <button
                                type="button"
                                onClick={() => onUndo()}
                                className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                            >
                                <Undo2 className="h-3 w-3" aria-hidden="true" />
                                Undo turn
                            </button>
                        ) : null}
                        {onRevert ? (
                            <button
                                type="button"
                                onClick={() => onRevert()}
                                className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium transition-colors hover:bg-[var(--bg-tertiary)]"
                                style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
                            >
                                <History className="h-3 w-3" aria-hidden="true" />
                                Revert to checkpoint
                            </button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

/**
 * What a validation record says to a person, and what it says to a developer.
 * The record's `hint` is the plain-English line ("Pick one the app owner has.")
 * while `message` is validator wording ('A filter value must be a literal…') —
 * so `hint` leads and `message` becomes the technical detail behind a
 * disclosure. A bare `code` is never a headline; it means nothing to the reader.
 */
function issueLines(rec) {
    if (typeof rec === 'string') return { text: rec, detail: '' };
    const hint = typeof rec?.hint === 'string' ? rec.hint : '';
    const message = typeof rec?.message === 'string' ? rec.message : '';
    if (hint) return { text: hint, detail: message };
    if (message) return { text: message, detail: '' };
    return { text: 'Something here needs attention', detail: typeof rec?.code === 'string' ? rec.code : '' };
}
function issueNodeId(rec) {
    if (!rec || typeof rec !== 'string') {
        return (rec && typeof rec.nodeId === 'string') ? rec.nodeId : null;
    }
    return null;
}

/**
 * Compact amber list of the latest validation records. While the stream is
 * running the AI is actively repairing them, so lead with that; otherwise each
 * issue gets a per-issue "Fix" button that asks the AI to repair just that one
 * (scoped to its node when the record carries a nodeId).
 */
/**
 * The records grouped by what they SAY. Four relation inputs on one missing
 * table are one line with ×4 (2026-09-13: the same sentence four times, then
 * "+20 more"), never four lines. The first record of a group is the one the
 * Fix button acts on.
 */
export function groupIssues(records) {
    const groups = new Map();
    for (const rec of Array.isArray(records) ? records : []) {
        const { text, detail } = issueLines(rec);
        const key = `${text}\u0000${detail}`;
        const g = groups.get(key);
        if (g) g.count += 1;
        else groups.set(key, { text, detail, count: 1, rec });
    }
    return [...groups.values()];
}

function ValidationNotice({ validation, running, onFix, disabled = false }) {
    const { t } = useTranslation();
    const errors = Array.isArray(validation?.errors) ? validation.errors : [];
    const warnings = Array.isArray(validation?.warnings) ? validation.warnings : [];
    if (!errors.length && !warnings.length) return null;

    const groups = groupIssues([...errors, ...warnings]);
    const shown = groups.slice(0, 4);
    const n = errors.length;

    return (
        <div className="shrink-0 border-t border-amber-500/30 bg-amber-500/10 px-3 py-2">
            {n > 0 && (
                <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
                    {running
                        ? (n === 1 ? t('app_studio.builder.validation.fixing_one', 'The AI is fixing 1 issue…') : t('app_studio.builder.validation.fixing', 'The AI is fixing {n} issues…', { n }))
                        : (n === 1 ? t('app_studio.builder.validation.to_review_one', '1 issue to review') : t('app_studio.builder.validation.to_review', '{n} issues to review', { n }))}
                </div>
            )}
            <ul className="mt-1 flex flex-col gap-0.5">
                {shown.map((g, i) => (
                    <li key={i} className="flex flex-col gap-0.5 text-[11px] text-amber-700/90 dark:text-amber-400/90">
                        <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate" title={g.text}>{g.text}</span>
                            {g.count > 1 && (
                                <span className="shrink-0 tabular-nums opacity-80" data-testid="app-issue-count" title={t('app_studio.builder.validation.times', '{n} places', { n: g.count })}>×{g.count}</span>
                            )}
                            {!running && onFix ? (
                                <button
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => onFix(g.detail || g.text, issueNodeId(g.rec))}
                                    className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/40 px-1.5 py-0.5 font-medium text-amber-700 hover:bg-amber-500/15 disabled:opacity-40 dark:text-amber-300"
                                >
                                    <Wrench className="h-3 w-3" aria-hidden="true" />
                                    {t('app_studio.builder.validation.fix', 'Fix')}
                                </button>
                            ) : null}
                        </div>
                        {g.detail ? (
                            <details>
                                <summary className="cursor-pointer text-[11px] opacity-70">{t('app_studio.builder.validation.technical_detail', 'Technical detail')}</summary>
                                <span className="text-[11px] opacity-80">{g.detail}</span>
                            </details>
                        ) : null}
                    </li>
                ))}
                {groups.length > shown.length && (
                    <li className="text-[11px] text-amber-700/70 dark:text-amber-400/70">
                        {t('app_studio.builder.validation.more', '+{n} more', { n: groups.length - shown.length })}
                    </li>
                )}
            </ul>
        </div>
    );
}

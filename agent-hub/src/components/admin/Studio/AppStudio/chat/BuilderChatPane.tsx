import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import BuilderComposer from './BuilderComposer';
import type { EditorChrome } from './builderPaneModel';
import BuilderTranscript, { TranscriptEmptyState } from './BuilderTranscript';
import QuickActions from './QuickActions';
import { useBuildCue } from './useBuildCue';
import { useBuilderTurn } from './useBuilderTurn';
import type { AppMetaUpdate, TurnEnd } from './useBuilderTurn';
import { useTurnControls } from './useTurnControls';
import ValidationNotice from './ValidationNotice';
import useModelTierSelection from '../../../../../hooks/useModelTierSelection';
import useStickToBottom from '../../../../../hooks/useStickToBottom';
import useTranslation from '../../../../../hooks/useTranslation';
import toast from '../../../../shared/Toast';
import type { BuildPhaseInfo } from '../editor/BuildCueContext';
import { useEditorChrome } from '../editor/EditorChromeContext';
import { useAppEditorState } from '../state/appEditorState';
import { findNode, findScreen } from '../state/definitionOps';

export { canAutoSendApp } from './builderPaneModel';
export { groupIssues } from './ValidationNotice';

/**
 * App Studio — the AI builder chat pane (the editor shell's left `chatSlot`).
 *
 * Owns the conversational side of an AI turn and wires it into the editor's
 * single-authority data flow (useBuilderTurn: send locks the canvas, drafts
 * apply transiently, done commits ONE history entry, an error unlocks and
 * keeps the last draft). useTurnControls starts turns; useBuildCue publishes
 * what the build is doing to the canvas; BuilderComposer is the composer.
 */
export interface BuilderChatPaneProps {
    appId: string;
    /** Seeds the composer once (prefill; the user sends). */
    initialPrompt?: string;
    /**
     * A brief this pane SENDS itself, once at mount, with planMode 'never' —
     * the hook a page that drives the builder (Studio Playbooks) needs;
     * `initialPrompt` only prefilled and no host could start a turn.
     */
    autoSend?: string | null;
    /** A tier pinned for every send of this mount; the picker shows it and cannot persist a change (Playbooks build on Fast). */
    forcedTier?: string | null;
    /** ({ finalized, stopped, awaitingPlan, error, code }) once per turn, from the stream's done or error. */
    onTurnEnd?: ((end: TurnEnd) => void) | null;
    /**
     * ({ id, name, description, icon }) whenever a draft changes the
     * definition's meta — the AI's app_set_meta, or the finalize-time naming
     * net. The editor header reads the app ROW's name (the manual rename
     * path), so without this the title the AI chose only appears after a
     * reload.
     */
    onAppUpdated?: ((update: AppMetaUpdate) => void) | null;
}

function PaneHeader() {
    const { t } = useTranslation();
    return (
        <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2 border-[var(--border-default)]">
            <span
                className="flex h-7 w-7 items-center justify-center rounded-lg"
                style={{
                    background: 'color-mix(in srgb, var(--accent-primary) 15%, transparent)',
                    color: 'var(--accent-primary)',
                }}
            >
                <Sparkles size={14} aria-hidden="true" />
            </span>
            <span className="text-sm font-semibold text-[var(--text-primary)]">
                {t('app_studio.builder.chat.title', 'AI builder')}
            </span>
        </div>
    );
}

export default function BuilderChatPane({ appId, initialPrompt = '', autoSend = null, forcedTier = null, onTurnEnd = null, onAppUpdated = null }: BuilderChatPaneProps) {
    const { t } = useTranslation();
    const { definition, screenId, selectedNodeId, selectedNodeIds, streamLock, dispatch } = useAppEditorState();
    const chrome = useEditorChrome() as EditorChrome | null;

    // Same tier machinery as the automations builder (shared hook + selector);
    // the choice persists per user and rides every turn incl. plan approvals.
    // taskType must NOT be 'direct_chat' — that list carries the chat-only
    // tiers (Flow, Swarm), which this builder can't run. 'automation' is the
    // builder task type: same non-chat filter, and it keeps the org's custom
    // tiers (they can only opt into the chat task types, so any other value
    // would strip them from the picker entirely).
    const { modelTiers, selectedTier, setSelectedTier } = useModelTierSelection({ storageKey: 'appBuilderTier', taskType: 'automation' });
    const tierForSend = forcedTier || selectedTier || 'auto';

    // Refs for the stream callbacks — SSE events fire between renders.
    const definitionRef = useRef(definition);
    const screenIdRef = useRef(screenId);
    const chromeRef = useRef(chrome);
    useEffect(() => {
        definitionRef.current = definition;
        screenIdRef.current = screenId;
        chromeRef.current = chrome;
    });

    const { stream, lastChange, setLastChange, changeOpen, setChangeOpen, reveal, doneInfoRef, beginTurn } = useBuilderTurn({ appId, t, dispatch, definitionRef, chromeRef, onTurnEnd, onAppUpdated });
    const { messages, running, send, stop, lastValidation, pendingPlan, phases, checkpoints, continuation, turn, engine, toolDraft, todos } = stream;

    // A turn is being prepared (the pre-turn flush is still saving). The canvas
    // isn't locked yet, so this is what keeps the UI closed until it is.
    const [starting, setStarting] = useState(false);
    const busy = running || streamLock || starting;
    const { startTurn, retryLastTurn, approvePlan } = useTurnControls({
        busy, send, tierForSend, autoSend, messageCount: messages.length, pendingPlan: pendingPlan as { planId?: unknown } | null,
        dispatch, setStarting, beginTurn, definitionRef, screenIdRef, chromeRef, selectedNodeId, selectedNodeIds,
    });

    // "Discuss" on the plan card just moves the user to the composer to talk it
    // over before building — the card stays put.
    const composerRef = useRef<HTMLTextAreaElement>(null);
    const focusComposer = useCallback(() => { composerRef.current?.focus?.(); }, []);

    // "What changed" click-to-select: jump to a node the turn touched. Resolve
    // its screen from the final draft so the canvas follows.
    const selectChangedNode = useCallback((nodeId: string) => {
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
    }, [setLastChange]);

    // "Revert to checkpoint": the version-history modal lives in EditorHeader
    // and isn't reachable from the chat pane, so point the user at it. (Noted
    // as a leftover — a chrome.openVersions handle would let us open it here.)
    const revertToCheckpoint = useCallback(() => {
        toast.info(t('studio_apps_edit.chat.revert_hint', 'Open “Version history” in the editor header to restore a checkpoint.'));
    }, [t]);

    // Follow the build — a new tool-call row, the plan card, markdown that
    // lands a beat late — but only while the reader is at the bottom. The old
    // hard `scrollTop = scrollHeight` on [messages, running] did neither: it
    // fired before the content was laid out, and it yanked anyone who had
    // scrolled up to re-read (owner, 2026-09-16).
    const listRef = useRef<HTMLDivElement>(null);
    const listBodyRef = useRef<HTMLDivElement>(null);
    const { onScroll, forceStick } = useStickToBottom({ containerRef: listRef, contentRef: listBodyRef });
    useEffect(() => { if (running) forceStick(); }, [running, forceStick]);

    const showEmptyState = messages.length === 0 && !running && !pendingPlan;
    const currentPhase = phases.length ? phases[phases.length - 1] as BuildPhaseInfo : null;
    const { waitingForFirstToken } = useBuildCue({ running, messages, turn, engine, toolDraft, todos, currentPhase, reveal, doneInfoRef, definitionRef, chromeRef });

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--bg-primary)]">
            <PaneHeader />

            {/* Messages */}
            <div ref={listRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 custom-scrollbar">
                {showEmptyState ? <TranscriptEmptyState /> : (
                    <div ref={listBodyRef} className="flex w-full flex-col gap-3">
                        <BuilderTranscript
                            messages={messages} running={running} busy={busy} pendingPlan={pendingPlan}
                            currentPhase={currentPhase} continuation={continuation}
                            lastChange={lastChange} changeOpen={changeOpen} onToggleChange={() => setChangeOpen((o) => !o)}
                            onSelectChanged={selectChangedNode} onUndoTurn={chrome?.undoTurn ? undoTurn : null}
                            onRevert={checkpoints.length ? revertToCheckpoint : null} onRetry={retryLastTurn}
                            onApprovePlan={approvePlan} onDiscussPlan={focusComposer} waitingForFirstToken={waitingForFirstToken}
                        />
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
                onAction={(prompt: string, opts: Record<string, unknown> | undefined) => startTurn(prompt, undefined, opts)}
                disabled={busy}
                hasErrors={Array.isArray(lastValidation?.errors) && lastValidation.errors.length > 0}
            />

            <BuilderComposer
                initialPrompt={initialPrompt}
                busy={busy}
                composerRef={composerRef}
                onSend={(text, attached) => startTurn(text, undefined, attached.length ? { images: attached } : undefined)}
                onStop={stop}
                modelTiers={modelTiers}
                tier={tierForSend}
                onTierChange={setSelectedTier}
                forcedTier={forcedTier}
            />
        </div>
    );
}

/**
 * The AI turn behind the builder chat pane, wired into the editor's
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
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject } from 'react';
import { DATA_QUERY_KEY_FAMILIES, friendlyBuilderError } from './builderPaneModel';
import type { EditorChrome } from './builderPaneModel';
import { diffDefinitions } from './draftDiff';
import type { DraftDiff, TurnChange } from './WhatChanged';
import useAppBuilderStream from '../../../../../hooks/useAppBuilderStream';
import type { AppBuilderDoneInfo } from '../../../../../hooks/useAppBuilderStream';
import { useReducedMotion } from '../../../../../hooks/useReducedMotion';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import toast from '../../../../shared/Toast';
import { planReveal as planRevealJs } from '../editor/revealQueue';
import type { AppDefinition, AppMeta } from '../inspector/appDefinition';
import type { AppEditorAction } from '../state/appEditorState';

/** How a turn ended, for the host (Playbooks) and the canvas farewell. */
export interface TurnEnd {
    finalized: boolean;
    stopped: boolean;
    awaitingPlan: boolean;
    error: string | null;
    code: string | null;
}

export interface AppMetaUpdate {
    id: string;
    name?: string;
    description?: string;
    icon?: string;
}

/** What the canvas is dealing: the last reveal plan and when it started. */
export interface RevealCue {
    plan: { ids: string[]; screens: string[]; animate?: boolean; delays?: Map<string, number> };
    at: number;
}

export interface DoneInfo {
    finalized: boolean;
    stopped: boolean;
    at: number;
}

interface BuilderTurnInputs {
    appId: string;
    t: TranslateFn;
    dispatch: Dispatch<AppEditorAction>;
    definitionRef: RefObject<AppDefinition | null>;
    chromeRef: RefObject<EditorChrome | null>;
    onTurnEnd: ((end: TurnEnd) => void) | null;
    onAppUpdated: ((update: AppMetaUpdate) => void) | null;
}

// revealQueue.js defaults hintIds to [], which would type it as never[].
const planReveal = planRevealJs as unknown as (input: {
    diff: unknown; definition: AppDefinition; hintIds: string[]; reducedMotion: boolean;
}) => RevealCue['plan'];

interface DraftMeta {
    lastCall?: { added?: Array<{ id?: string } | null> } | null;
}

/** Adopt the turn's last draft: the server already persisted it, so autosave must not re-save. */
function adoptDraft(chrome: EditorChrome | null, dispatch: Dispatch<AppEditorAction>, last: { definition: AppDefinition; version: unknown }) {
    chrome?.markSaved?.(last.definition, last.version);
    if (last.version != null) dispatch({ type: 'set_version', version: last.version as number | string });
}

export function useBuilderTurn({ appId, t, dispatch, definitionRef, chromeRef, onTurnEnd, onAppUpdated }: BuilderTurnInputs) {
    const queryClient = useQueryClient();
    const onTurnEndRef = useRef(onTurnEnd);
    useEffect(() => { onTurnEndRef.current = onTurnEnd; });
    const onAppUpdatedRef = useRef(onAppUpdated);
    useEffect(() => { onAppUpdatedRef.current = onAppUpdated; });

    const preTurnDefRef = useRef<AppDefinition | null>(null);  // baseline every draft diffs against
    const lastDraftRef = useRef<{ definition: AppDefinition; version: unknown } | null>(null);   // the newest draft
    const doneInfoRef = useRef<DoneInfo | null>(null);    // how the last turn ended — the canvas banner's farewell reads it

    // The "What changed" summary for the just-finished turn: the diff between
    // the pre-turn baseline and the final draft, plus that final draft so a
    // clicked node can be resolved to its screen. Cleared when a new turn starts.
    const [lastChange, setLastChange] = useState<TurnChange | null>(null);
    const [changeOpen, setChangeOpen] = useState(false);

    const reducedMotion = useReducedMotion();
    const reducedMotionRef = useRef(reducedMotion);
    useEffect(() => { reducedMotionRef.current = reducedMotion; }, [reducedMotion]);
    // What the canvas is dealing: the last plan and when it started, for the
    // camera and the banner (published as part of the build cue).
    const [reveal, setReveal] = useState<RevealCue | null>(null);

    const handleDraft = useCallback((rawDef: unknown, version: unknown, _appId: unknown, meta: DraftMeta | null) => {
        const def = rawDef as AppDefinition | null;
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
        const metaBefore: AppMeta = (revealBaseline && revealBaseline.meta) || {};
        const metaAfter: AppMeta = def.meta || {};
        if ((['name', 'description', 'icon'] as const).some((k) => metaBefore[k] !== metaAfter[k])) {
            onAppUpdatedRef.current?.({ id: appId, name: metaAfter.name, description: metaAfter.description, icon: metaAfter.icon });
        }

        const diff = diffDefinitions(revealBaseline, def);
        // The film: what this draft added is dealt one card at a time, in the
        // order the model wrote it (the tool_call's `added`), each cell holding
        // its slot invisibly until its turn. New screens ring their tab pill.
        // Which screen the canvas shows is decided there (useBuildFollow) from
        // the same cue — this pane never switches screens mid-build.
        const hintIds = (meta && meta.lastCall && Array.isArray(meta.lastCall.added)) ? meta.lastCall.added.map((a) => a && a.id).filter(Boolean) as string[] : [];
        const plan = planReveal({ diff, definition: def, hintIds, reducedMotion: reducedMotionRef.current });
        if (plan.ids.length || plan.screens.length) {
            dispatch({ type: 'set_recent_ids', ids: [...plan.ids, ...plan.screens], delays: plan.animate ? plan.delays : null });
            setReveal({ plan, at: Date.now() });
        }
    }, [dispatch, appId, definitionRef]);

    const handleDone = useCallback((info: AppBuilderDoneInfo = {}) => {
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
            if (last) adoptDraft(chromeRef.current, dispatch, last);
            dispatch({ type: 'set_stream_lock', streamLock: false });
            return;
        }
        if (last) {
            // ONE history entry for the whole AI turn (Cmd+Z undoes it all)…
            chromeRef.current?.commitTurn?.(last.definition);
            // …and the server already persisted every draft: adopt, don't re-save.
            adoptDraft(chromeRef.current, dispatch, last);
            // Post-turn "What changed" summary — diff the pre-turn baseline
            // against the final draft (the same diff the per-draft pulse uses).
            const diff = diffDefinitions(baseline, last.definition) as DraftDiff;
            if (diff.addedIds.size || diff.changedIds.size) {
                setLastChange({ diff, finalDef: last.definition });
                setChangeOpen(false);
            }
        }
        dispatch({ type: 'set_stream_lock', streamLock: false });
    }, [dispatch, chromeRef]);

    const handleError = useCallback((message: string, code?: string) => {
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
            adoptDraft(chromeRef.current, dispatch, last);
        }
        dispatch({ type: 'set_stream_lock', streamLock: false });
        onTurnEndRef.current?.({ finalized: false, stopped: false, awaitingPlan: false, error: message || 'error', code: code || null });
        // The transcript's ErrorItem shows the friendly copy + retry; the toast
        // is the transient fallback — prefer the code's copy, else the raw text.
        toast.error(friendlyBuilderError(code, message, t).message);
    }, [dispatch, t, chromeRef]);

    // The AI created/changed tables, rows, roles or datasets — refresh every
    // cache family that renders them so the editor reflects it immediately.
    const handleDataModel = useCallback(() => {
        for (const queryKey of DATA_QUERY_KEY_FAMILIES(appId)) {
            queryClient.invalidateQueries({ queryKey });
        }
    }, [queryClient, appId]);

    const stream = useAppBuilderStream({
        appId,
        onDraft: handleDraft as (definition: unknown, version: unknown, appId: unknown, meta: { lastCall: unknown }) => void,
        onDone: handleDone,
        onError: handleError,
        onDataModel: handleDataModel,
    });

    /** A new turn starts: the baseline is the canvas as it is now, the last summary goes. */
    const beginTurn = useCallback(() => {
        preTurnDefRef.current = definitionRef.current;
        doneInfoRef.current = null;
        setLastChange(null);
    }, [definitionRef]);

    return { stream, lastChange, setLastChange, changeOpen, setChangeOpen, reveal, doneInfoRef, beginTurn };
}

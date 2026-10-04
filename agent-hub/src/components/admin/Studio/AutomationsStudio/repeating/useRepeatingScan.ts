import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
    parseScanResult, parseSuggestion, parseSuggestions, repeatingApi, repeatingKeys, useLastScan, useScanSources,
} from '../../../../../api/queries/automation/repeating';
import type { RepeatingSuggestion, ScanMode, ScanResult } from '../../../../../api/queries/automation/repeating';
import type { AutomationApiError } from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { makeLabelFor, parseRetrySeconds } from './patternView';
import { readRepeatingPrefs, writeRepeatingPrefs } from './repeatingState';
import usePatternFeedback from './usePatternFeedback';

/* ── The live run, as a pure reducer over the SSE frames ─────────────── */

export type StepStatus = 'start' | 'done' | 'skipped';

/** One source the scan read (patterns: `source_step`; ideas: `scan_step`). */
export interface SourceStep {
    key: string;
    source: string | null;
    app: string;
    status: StepStatus;
    events: number | null;
    reason: string | null;
    piiCategories: string[];
}

export interface ScanStats { events: number; templates: number; candidates: number }

export interface RunState {
    scanning: boolean;
    mode: ScanMode;
    phase: string | null;
    steps: SourceStep[];
    stats: ScanStats | null;
    /** `suggestion` frames so far; `done` replaces them. */
    streamed: RepeatingSuggestion[];
    error: string | null;
    rateLimitedUntil: number | null;
    stopped: boolean;
}

export type RunAction =
    | { type: 'start'; mode: ScanMode }
    | { type: 'event'; event: string; data: unknown }
    | { type: 'end' }
    | { type: 'fail'; error: string }
    | { type: 'limit'; until: number }
    | { type: 'stop' };

export const IDLE_RUN: RunState = Object.freeze({
    scanning: false, mode: 'patterns', phase: null, steps: [], stats: null, streamed: [],
    error: null, rateLimitedUntil: null, stopped: false,
}) as RunState;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? v as Obj : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** A `source_step` or an ideas-mode `scan_step` frame as one SourceStep. */
export function toStep(event: string, data: unknown): SourceStep | null {
    const d = obj(data);
    if (event === 'source_step') {
        const app = str(d.app) || str(d.source);
        if (!app) return null;
        const status: StepStatus = d.status === 'done' || d.status === 'skipped' ? d.status : 'start';
        return {
            key: `${str(d.source) || ''}:${app}`, source: str(d.source), app, status,
            events: count(d.events), reason: str(d.reason), piiCategories: strs(d.piiCategories),
        };
    }
    const tool = str(d.tool);
    if (!tool) return null;
    const status: StepStatus = d.phase === 'done' ? (d.ok === false ? 'skipped' : 'done') : 'start';
    return {
        key: tool, source: null, app: str(d.integration) || tool, status, events: null,
        reason: str(d.reason) || str(d.blockedReason), piiCategories: strs(d.piiCategories),
    };
}

function upsertStep(steps: SourceStep[], step: SourceStep): SourceStep[] {
    const i = steps.findIndex(s => s.key === step.key);
    if (i < 0) return [...steps, step];
    const prev = steps[i];
    const next = steps.slice();
    next[i] = {
        ...prev, ...step,
        events: step.events ?? prev.events,
        reason: step.reason ?? prev.reason,
        piiCategories: step.piiCategories.length ? step.piiCategories : prev.piiCategories,
    };
    return next;
}

function reduceEvent(state: RunState, event: string, data: unknown): RunState {
    const d = obj(data);
    switch (event) {
        case 'phase': return { ...state, phase: str(d.phase) };
        case 'source_step':
        case 'scan_step': {
            const step = toStep(event, data);
            return step ? { ...state, steps: upsertStep(state.steps, step) } : state;
        }
        case 'error': return { ...state, error: str(d.error) };
        case 'stats':
            return { ...state, stats: { events: count(d.events) ?? 0, templates: count(d.templates) ?? 0, candidates: count(d.candidates) ?? 0 } };
        case 'suggestion': {
            // The contract wraps it as { suggestion }; a bare suggestion is accepted too.
            const s = parseSuggestion(d.suggestion ?? data, state.streamed.length);
            if (!s || state.streamed.some(x => x.id === s.id)) return state;
            return { ...state, streamed: [...state.streamed, s] };
        }
        default: return state;
    }
}

export function reduceRun(state: RunState, action: RunAction): RunState {
    switch (action.type) {
        case 'start': return { ...IDLE_RUN, scanning: true, mode: action.mode };
        case 'event': return reduceEvent(state, action.event, action.data);
        case 'end': return { ...state, scanning: false, phase: null };
        case 'fail': return { ...state, scanning: false, phase: null, error: action.error };
        case 'limit': return { ...state, scanning: false, phase: null, rateLimitedUntil: action.until };
        case 'stop': return { ...state, scanning: false, phase: null, stopped: true };
        default: return state;
    }
}

/* ── Small pieces of the hook ───────────────────────────────────────── */

/** Seconds left on a rate-limit cooldown, re-rendering once a second until it is over. */
function useCooldown(until: number | null): number {
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!until) return undefined;
        const id = setInterval(() => {
            setTick(n => n + 1);
            if (Date.now() >= until) clearInterval(id);
        }, 1000);
        return () => clearInterval(id);
    }, [until]);
    return until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
}

/** Which connected groups are switched on (all of them, minus what the viewer switched off). */
function useSourceSelection(connectedIds: string[]) {
    const [prefs, setPrefs] = useState(readRepeatingPrefs);
    const selected = useMemo(
        () => new Set(connectedIds.filter(id => !prefs.excludedSources.includes(id))),
        [connectedIds, prefs.excludedSources],
    );
    const toggleSource = useCallback((id: string) => {
        setPrefs(prev => {
            const off = prev.excludedSources.includes(id)
                ? prev.excludedSources.filter(x => x !== id)
                : [...prev.excludedSources, id];
            return writeRepeatingPrefs({ ...prev, excludedSources: off });
        });
    }, []);
    const setFocusOpen = useCallback((open: boolean) => setPrefs(prev => writeRepeatingPrefs({ ...prev, focusOpen: open })), []);
    return { selected, toggleSource, focusOpen: prefs.focusOpen, setFocusOpen };
}

const sameSet = (a: string[], b: ReadonlySet<string>) => a.length === b.size && a.every(x => b.has(x));

/** The browser's IANA zone, so a card's weekday and hours are the viewer's own; null when the browser will not say. */
export function viewerTimeZone(): string | null {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
        return null;
    }
}

const GENERIC_ERROR = 'Something went wrong. Try again in a moment.';

/** A refused scan: a calm cooldown for a 429 (or a "Retry in ~20s" message), else a failure. */
export function scanError(e: unknown, generic: string): RunAction {
    const err = (e || {}) as AutomationApiError;
    const retry = err.retryAfter || parseRetrySeconds(err.message);
    if (err.status === 429 || retry) return { type: 'limit', until: Date.now() + (retry || 30) * 1000 };
    return { type: 'fail', error: err.message || generic };
}

/**
 * The run's result: `done` is authoritative; the streamed `suggestion`
 * frames stand in when `done` carried none (or never came). Stamped with what
 * it was scanned with, for the "sources changed" hint.
 */
export function finalResult(
    done: unknown,
    streamed: RepeatingSuggestion[],
    body: { mode: ScanMode; sources: string[]; focus: string },
): ScanResult | null {
    const parsed = parseScanResult(done, body.mode);
    if (!parsed && !streamed.length) return null;
    const base: ScanResult = parsed ?? { suggestions: [], summary: null, reason: null, scannedAt: null, cached: false, mode: body.mode };
    return {
        ...base,
        suggestions: base.suggestions.length ? base.suggestions : streamed,
        mode: body.mode,
        scannedAt: base.scannedAt || new Date().toISOString(),
        sources: body.sources,
        focus: body.focus,
    };
}

/**
 * One scan at a time over the SSE stream: the live run state, Stop, and the
 * cooldown after a 429. `onResult` receives the finished result.
 */
function useScanRunner(selected: ReadonlySet<string>, focus: string, onResult: (mode: ScanMode, r: ScanResult) => Promise<void> | void) {
    const { t } = useTranslation();
    const [run, dispatch] = useReducer(reduceRun, IDLE_RUN);
    const abortRef = useRef<AbortController | null>(null);
    const cooldown = useCooldown(run.rateLimitedUntil);

    useEffect(() => () => { abortRef.current?.abort(); }, []);

    const start = useCallback(async (mode: ScanMode, force: boolean) => {
        if (run.scanning) return;
        const ac = new AbortController();
        abortRef.current = ac;
        const timezone = viewerTimeZone();
        const body = { mode, sources: [...selected], focus: focus.trim(), force, ...(timezone ? { timezone } : {}) };
        const streamed: unknown[] = [];
        let done: unknown = null;
        dispatch({ type: 'start', mode });
        try {
            await repeatingApi.streamPatternScan(body, (event, data) => {
                if (event === 'done') { done = data; return; }
                if (event === 'suggestion') streamed.push(obj(data).suggestion ?? data);
                const generic = event === 'error' && !str(obj(data).error);
                dispatch({ type: 'event', event, data: generic ? { error: t('automations.repeating.errorGeneric', GENERIC_ERROR) } : data });
            }, ac.signal);
            // Stopped (or unmounted): whatever streamed so far is not a result.
            if (ac.signal.aborted) return;
            const result = finalResult(done, parseSuggestions(streamed), body);
            if (result) await onResult(mode, result);
            dispatch({ type: 'end' });
        } catch (e) {
            if (!ac.signal.aborted) dispatch(scanError(e, t('automations.repeating.errorGeneric', GENERIC_ERROR)));
        }
    }, [focus, onResult, run.scanning, selected, t]);

    const cancel = useCallback(() => {
        abortRef.current?.abort();
        dispatch({ type: 'stop' });
    }, []);

    return { run, cooldown, start, cancel };
}

/* ── The hook ───────────────────────────────────────────────────────── */

/**
 * Everything "Find repeating work" knows: the source groups, the viewer's
 * selection and focus, the live scan, the last result and the ideas fallback.
 *
 * The last result is the server's (GET /suggest/last, through react-query),
 * so a remount paints it WITHOUT running a scan; a finished scan writes its
 * result into the same query. A re-scan keeps the old result on screen until
 * the new `done` replaces it, and a failed or rate-limited one never wipes it.
 */
export default function useRepeatingScan({ undoMs }: { undoMs?: number } = {}) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const sourcesQuery = useScanSources();
    const result = useLastScan().data ?? null;
    const feedback = usePatternFeedback({ undoMs });
    const { isHidden } = feedback;

    const groups = useMemo(() => sourcesQuery.data?.groups ?? [], [sourcesQuery.data]);
    const connectedIds = useMemo(() => groups.filter(g => g.connected).map(g => g.id), [groups]);
    const labelFor = useMemo(() => makeLabelFor(groups, t), [groups, t]);
    const selection = useSourceSelection(connectedIds);
    const [focus, setFocus] = useState('');
    const [ideas, setIdeas] = useState<ScanResult | null>(null);

    const onResult = useCallback(async (mode: ScanMode, r: ScanResult) => {
        if (mode === 'ideas') { setIdeas(r); return; }
        // A /suggest/last read still in flight must not land on top of this result.
        await qc.cancelQueries({ queryKey: repeatingKeys.last });
        qc.setQueryData(repeatingKeys.last, r);
    }, [qc]);
    const { run, cooldown, start, cancel } = useScanRunner(selection.selected, focus, onResult);
    const scan = useCallback((force = false) => start('patterns', force), [start]);
    const suggestIdeas = useCallback(() => start('ideas', false), [start]);

    const suggestions = useMemo(() => {
        // A first scan shows its patterns as they are named; a re-scan keeps
        // the previous result (dimmed by the section) until `done`.
        const base = !result && run.scanning && run.mode === 'patterns' ? run.streamed : (result?.suggestions ?? []);
        return base.filter(s => !isHidden(s));
    }, [isHidden, result, run.mode, run.scanning, run.streamed]);
    const visibleIdeas = useMemo(
        () => (ideas ? { ...ideas, suggestions: ideas.suggestions.filter(s => !isHidden(s)) } : null),
        [ideas, isHidden],
    );
    const stale = !!result?.sources && !run.scanning
        && (!sameSet(result.sources, selection.selected) || (result.focus ?? '') !== focus.trim());

    return {
        groups,
        windowDays: sourcesQuery.data?.windowDays ?? 90,
        sourcesLoaded: sourcesQuery.isSuccess,
        sourcesError: sourcesQuery.isError,
        reloadSources: sourcesQuery.refetch,
        ...selection,
        focus,
        setFocus,
        run,
        cooldown,
        result,
        suggestions,
        ideas: visibleIdeas,
        stale,
        scan,
        suggestIdeas,
        cancel,
        labelFor,
        feedback,
    };
}

export type RepeatingScan = ReturnType<typeof useRepeatingScan>;

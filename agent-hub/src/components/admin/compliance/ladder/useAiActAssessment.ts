/**
 * useAiActAssessment — the ladder's own data hook (Compliance Center
 * redesign, Sep 2026). Deliberately NOT the hub's data hook: the ladder is
 * mounted in the automation builder's Settings tab and the agent wizard's
 * Advanced drawer, outside the hub and its providers, so it talks to
 * `data/api.js` directly.
 *
 * Routes (BE-1b; PLAN.md §1):
 *   GET /api/compliance/ai-act/assessments/:kind/:id          → { signals, answers, outcome, attested_by, attested_at, expires_at, current }
 *   GET /api/compliance/ai-act/assessments/:kind/:id/signals  → signals (recomputed live)
 *   PUT /api/compliance/ai-act/assessments/:kind/:id          { answers } → the stored row
 *   PUT /api/compliance/settings                              { ai_content_marking_enabled: true }
 *
 * Degrades when the routes are not deployed yet (404): `absent` becomes true,
 * the signals fall back to `aiSignals.js` computed from the target's own
 * definition, and there is no saved assessment. Any OTHER failure is its own
 * state (`error`) — never an empty result pretending to be "not assessed".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API, fetchJson, jsonInit, asObject } from '../../../../api/complianceApi';
import { fallbackSignals, type AiActSignals } from './aiSignals';
import type { FilmDefinition } from '../../Studio/Playbooks/stages/runFilm';
import type { AnnexAnswer, Art5Answer, toAnswers } from './ladderOutcome';

/** The signals as the server (or the client fallback) describes the target; any member may be absent. */
export interface LadderSignals extends Partial<Omit<AiActSignals, 'surface' | 'source'>> {
    surface?: string | null;
    source?: string;
    annex_iii_questions?: Array<{ id: string; hint?: boolean }>;
}

/** The stored self-declaration, as far as the modal reads it. */
interface LadderAssessment {
    outcome?: string;
    current?: boolean;
    signals?: LadderSignals | null;
    answers?: { art5?: Art5Answer | null; annex_iii?: AnnexAnswer | null } | null;
    attested_at?: string;
    expires_at?: string;
    [key: string]: unknown;
}

/** The record a ladder is opened for: an automation or an agent. */
export interface LadderSubject {
    id?: string;
    name?: string;
    title?: string;
    definition?: FilmDefinition;
    is_published?: boolean;
}

/** The `answers` body of PUT /ai-act/assessments/:kind/:id. */
type LadderAnswers = ReturnType<typeof toAnswers>;

interface AssessmentState {
    loading: boolean;
    error: Error | null;
    absent: boolean;
    assessment: LadderAssessment | null;
    serverSignals: LadderSignals | null;
}

const ASSESSMENT_KINDS: readonly (string | undefined)[] = Object.freeze(['automation', 'agent']);

function assessmentUrl(kind: string | undefined, id: string | number | boolean) {
    return `${API}/ai-act/assessments/${encodeURIComponent(String(kind))}/${encodeURIComponent(id)}`;
}

function isNotFound(err: unknown) {
    return /^404\b/.test(String((err as Error | undefined)?.message || ''));
}

/** Server signals win; every field the server left out is filled from the client fallback. */
function mergeSignals(server: LadderSignals | null, fallback: LadderSignals | null) {
    if (!server) return fallback || null;
    if (!fallback) return server;
    const merged = { ...fallback, ...server, source: 'server' };
    // A server that did not list its steps must not hide the client's.
    if (!server.steps && fallback.steps) merged.steps = fallback.steps;
    return merged;
}

/**
 * @param {'automation'|'agent'} kind
 * @param {object} target   the automation or agent record (needs `id`)
 * @param {{ enabled?: boolean }} [opts]  `enabled:false` skips the network (block collapsed)
 */
export default function useAiActAssessment(kind: string | undefined, target: LadderSubject | null | undefined, opts: { enabled?: boolean } = {}) {
    const enabled = opts.enabled !== false;
    const id = target?.id ?? null;
    const [state, setState] = useState<AssessmentState>({ loading: false, error: null, absent: false, assessment: null, serverSignals: null });
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const fallback: LadderSignals | null = useMemo(() => fallbackSignals(kind as string, target), [kind, target]);

    const load = useCallback(async () => {
        if (!enabled || !id || !ASSESSMENT_KINDS.includes(kind)) return;
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const body = asObject(await fetchJson(assessmentUrl(kind, id))) as LadderAssessment | null;
            if (!alive.current) return;
            setState({
                loading: false,
                error: null,
                absent: false,
                // `current` false or no outcome → nothing is recorded yet.
                assessment: body && body.outcome ? body : null,
                serverSignals: asObject(body?.signals) as LadderSignals | null,
            });
        } catch (err) {
            if (!alive.current) return;
            if (isNotFound(err)) {
                setState({ loading: false, error: null, absent: true, assessment: null, serverSignals: null });
            } else {
                setState(s => ({ ...s, loading: false, error: err as Error }));
            }
        }
    }, [enabled, id, kind]);

    useEffect(() => { load(); }, [load]);

    /** Re-read the live signals (after "Enable marking"); a 404 keeps the fallback. */
    const refetchSignals = useCallback(async () => {
        if (!id || !ASSESSMENT_KINDS.includes(kind)) return null;
        try {
            const body = asObject(await fetchJson(`${assessmentUrl(kind, id)}/signals`)) as LadderAssessment | null;
            const sig = (asObject(body?.signals) || body) as LadderSignals | null;
            if (alive.current && sig) setState(s => ({ ...s, serverSignals: sig, absent: false }));
            return sig;
        } catch (err) {
            if (isNotFound(err)) return null;
            throw err;
        }
    }, [id, kind]);

    /** PUT the answers; the server recomputes the outcome and stamps who/when/expiry. */
    const save = useCallback(async (answers: LadderAnswers) => {
        if (!id) throw new Error('no target');
        const row = asObject(await fetchJson(assessmentUrl(kind, id), jsonInit('PUT', { answers }))) as LadderAssessment | null;
        if (alive.current && row) {
            setState(s => ({
                ...s,
                absent: false,
                assessment: row.outcome ? row : s.assessment,
                serverSignals: (asObject(row.signals) as LadderSignals | null) || s.serverSignals,
            }));
        }
        return row;
    }, [id, kind]);

    /** Flip the org-wide Art. 50(2) marking on, then refetch the signals so the sub-card turns green. */
    const enableMarking = useCallback(async () => {
        await fetchJson(`${API}/settings`, jsonInit('PUT', { ai_content_marking_enabled: true }));
        const sig = await refetchSignals();
        if (!sig && alive.current) {
            // Routes absent: reflect the flip locally so the card still answers.
            setState(s => ({ ...s, serverSignals: { ...(s.serverSignals || {}), marking_enabled: true } }));
        }
    }, [refetchSignals]);

    const signals = useMemo(() => mergeSignals(state.serverSignals, fallback), [state.serverSignals, fallback]);

    return {
        loading: state.loading,
        error: state.error,
        absent: state.absent,
        assessment: state.assessment,
        signals,
        signalsSource: state.serverSignals ? 'server' : (fallback ? 'client' : null),
        reload: load,
        refetchSignals,
        save,
        enableMarking,
    };
}

/** What the hook hands the modal. */
export type LadderData = ReturnType<typeof useAiActAssessment>;

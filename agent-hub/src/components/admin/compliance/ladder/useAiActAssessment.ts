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
import { API, fetchJson, jsonInit, asObject } from '../data/api';
import { fallbackSignals, type AiSignals } from './aiSignals';

export const ASSESSMENT_KINDS: readonly string[] = Object.freeze(['automation', 'agent']);

/** One of the ten Annex III questions as the server lists it, with whether the wording hints at it. */
export interface AnnexHint {
    id: string;
    hint?: boolean;
}

/** The signals a row or the live route carries; the server may leave fields out. */
export type SignalsView = Omit<Partial<AiSignals>, 'source'> & {
    source?: string;
    annex_iii_questions?: AnnexHint[] | null;
};

/** A saved assessment row (GET/PUT …/assessments/:kind/:id). */
export interface AiActAssessment {
    outcome?: string | null;
    attested_by?: unknown;
    attested_at?: string | null;
    expires_at?: string | null;
    current?: boolean;
    signals?: SignalsView | null;
    answers?: unknown;
    [key: string]: unknown;
}

/** The automation or agent record the ladder is about (`id` is what the routes key on). */
export interface AssessmentTarget {
    id?: string | number | null;
    [key: string]: unknown;
}

interface AssessmentState {
    loading: boolean;
    error: unknown;
    absent: boolean;
    assessment: AiActAssessment | null;
    serverSignals: SignalsView | null;
}

export function assessmentUrl(kind: string, id: string | number): string {
    return `${API}/ai-act/assessments/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

function isNotFound(err: unknown): boolean {
    const message = (err as { message?: unknown } | null | undefined)?.message;
    return /^404\b/.test(String(message || ''));
}

/** Server signals win; every field the server left out is filled from the client fallback. */
export function mergeSignals(server: SignalsView | null | undefined, fallback: AiSignals | null | undefined): SignalsView | null {
    if (!server) return fallback || null;
    if (!fallback) return server;
    const merged: SignalsView = { ...fallback, ...server, source: 'server' };
    // A server that did not list its steps must not hide the client's.
    if (!server.steps && fallback.steps) merged.steps = fallback.steps;
    return merged;
}

/**
 * @param kind    'automation'|'agent'
 * @param target  the automation or agent record (needs `id`)
 * @param opts    `enabled:false` skips the network (block collapsed)
 */
export default function useAiActAssessment(
    kind: string,
    target: AssessmentTarget | null | undefined,
    opts: { enabled?: boolean } = {},
) {
    const enabled = opts.enabled !== false;
    const id = target?.id ?? null;
    const [state, setState] = useState<AssessmentState>({ loading: false, error: null, absent: false, assessment: null, serverSignals: null });
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const fallback = useMemo(() => fallbackSignals(kind, target), [kind, target]);

    const load = useCallback(async () => {
        if (!enabled || !id || !ASSESSMENT_KINDS.includes(kind)) return;
        setState(s => ({ ...s, loading: true, error: null }));
        try {
            const body = asObject<AiActAssessment>(await fetchJson(assessmentUrl(kind, id)));
            if (!alive.current) return;
            setState({
                loading: false,
                error: null,
                absent: false,
                // `current` false or no outcome → nothing is recorded yet.
                assessment: body && body.outcome ? body : null,
                serverSignals: asObject<SignalsView>(body?.signals),
            });
        } catch (err) {
            if (!alive.current) return;
            if (isNotFound(err)) {
                setState({ loading: false, error: null, absent: true, assessment: null, serverSignals: null });
            } else {
                setState(s => ({ ...s, loading: false, error: err }));
            }
        }
    }, [enabled, id, kind]);

    useEffect(() => { load(); }, [load]);

    /** Re-read the live signals (after "Enable marking"); a 404 keeps the fallback. */
    const refetchSignals = useCallback(async (): Promise<SignalsView | null> => {
        if (!id || !ASSESSMENT_KINDS.includes(kind)) return null;
        try {
            const body = asObject<SignalsView & { signals?: SignalsView | null }>(await fetchJson(`${assessmentUrl(kind, id)}/signals`));
            const sig = asObject<SignalsView>(body?.signals) || body;
            if (alive.current && sig) setState(s => ({ ...s, serverSignals: sig, absent: false }));
            return sig;
        } catch (err) {
            if (isNotFound(err)) return null;
            throw err;
        }
    }, [id, kind]);

    /** PUT the answers; the server recomputes the outcome and stamps who/when/expiry. */
    const save = useCallback(async (answers: unknown) => {
        if (!id) throw new Error('no target');
        const row = asObject<AiActAssessment>(await fetchJson(assessmentUrl(kind, id), jsonInit('PUT', { answers })));
        if (alive.current && row) {
            setState(s => ({
                ...s,
                absent: false,
                assessment: row.outcome ? row : s.assessment,
                serverSignals: asObject<SignalsView>(row.signals) || s.serverSignals,
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

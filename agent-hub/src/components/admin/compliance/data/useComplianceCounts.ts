/**
 * useComplianceCounts — the rail's numbers and the settings badge, from ONE
 * cheap call: GET /api/compliance/counts. Same discipline as
 * hooks/useStudioCounts.js: a 30 s poll that skips while the tab is hidden
 * and catches up on visibilitychange, `poll: false` for a one-shot consumer
 * (the settings nav), and `failed` to tell "not in yet" from "could not read".
 *
 * `counts` is `null` until a real object arrives. The nav test mocks every
 * non-/overview url as `[]`, and the endpoint may not have shipped — both
 * parse to null, and every consumer renders NOTHING for a null count (the
 * rail shows no meta, the segmented control no badge), never a "0".
 *
 * Shape (PLAN.md §1.2): { attention_open, last_run:{at,interval_hours},
 * frameworks:{<id>:{score,tone}}, frameworks_summary:{active,candidates,
 * recently_in_force,locked}, dsr:{open,overdue,due_soon}, incidents:{open,
 * next_deadline_at,next_stage,hours_left,vulnerabilities_open}, ropa:{last_reviewed_at},
 * dpia:{todo}, risks:{total,high}, soa:{approved,total,todo}, policies:{total,
 * review_due}, audits:{planned}, training:{done,total}, connectors:{count,
 * next_sweep_at}, evidence:{rows,chain_ok,algorithm}, onboarded, setup_step }.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { API, fetchJson, asObject } from './api';

export const COMPLIANCE_COUNTS_POLL_MS = 30_000;

/** Tolerant parse: a plain object with at least one known key, else null. */
export function parseCounts(body: unknown) {
    const o = asObject(body);
    if (!o) return null;
    return o as Record<string, unknown>;
}

/** The counts the endpoint reports, by dotted path (the shape in the header comment). */
export interface CountPaths {
    attention_open: number;
    setup_step: number;
    'last_run.at': string;
    'last_run.interval_hours': number;
    frameworks: Record<string, { score?: number; tone?: string } | null | undefined>;
    'frameworks_summary.active': number;
    'frameworks_summary.candidates': number;
    'frameworks_summary.recently_in_force': number;
    'dsr.open': number;
    'dsr.overdue': number;
    'dsr.due_soon': number;
    'incidents.open': number;
    'incidents.next_deadline_at': string;
    'incidents.next_stage': string;
    'incidents.hours_left': number;
    'incidents.vulnerabilities_open': number;
    ropa: { last_reviewed_at?: string | null };
    'ropa.last_reviewed_at': string;
    'dpia.todo': number;
    'risks.total': number;
    'risks.high': number;
    'soa.approved': number;
    'soa.total': number;
    'soa.todo': number;
    'policies.review_due': number;
    'audits.planned': number;
    'training.done': number;
    'training.total': number;
    'connectors.count': number;
    'connectors.next_sweep_at': string;
    'evidence.rows': number;
    'evidence.chain_ok': boolean;
    'evidence.algorithm': string;
    'portability.gaps': number;
    [path: `evidence.by_framework.${string}`]: number;
}

/**
 * Read a nested count by dotted path ('dsr.open', 'frameworks.gdpr.score').
 * Returns `undefined` for a missing counts object, a missing branch or a
 * non-finite value — the caller renders nothing in that case. A real 0 is a
 * number and comes back as 0.
 */
export function countFor<P extends string>(counts: unknown, path: P): (P extends keyof CountPaths ? CountPaths[P] : unknown) | undefined;
export function countFor(counts: unknown, path: string): unknown {
    if (!counts || !path) return undefined;
    let cur: unknown = counts;
    for (const seg of String(path).split('.')) {
        if (cur == null || typeof cur !== 'object' || !(seg in cur)) return undefined;
        cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur === 'number') return Number.isFinite(cur) ? cur : undefined;
    return cur; // dates, strings, booleans, nested objects pass through
}

interface UseComplianceCountsArgs {
    enabled?: boolean;
    poll?: boolean;
    keys?: string[] | null;
}

export default function useComplianceCounts({ enabled = true, poll = true, keys = null }: UseComplianceCountsArgs = {}) {
    const [counts, setCounts] = useState<Record<string, unknown> | null>(null);
    const [failed, setFailed] = useState(false);
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

    const url = keys && keys.length ? `${API}/counts?keys=${encodeURIComponent(keys.join(','))}` : `${API}/counts`;

    const load = useCallback(async () => {
        try {
            const body = await fetchJson(url);
            if (!alive.current) return;
            setCounts(parseCounts(body));
            setFailed(false);
        } catch {
            if (alive.current) setFailed(true);
        }
    }, [url]);

    useEffect(() => {
        if (!enabled) return undefined;
        load();
        if (!poll) return undefined;
        let timer: NodeJS.Timeout | null = null;
        const tick = () => {
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            load();
        };
        timer = setInterval(tick, COMPLIANCE_COUNTS_POLL_MS);
        const onVisible = () => { if (document.visibilityState === 'visible') load(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            if (timer) clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [enabled, poll, load]);

    // Mutations call bump() so the rail catches up without waiting for the poll.
    const bump = useCallback(() => { if (enabled) load(); }, [enabled, load]);

    return { counts, failed, bump, refresh: load };
}

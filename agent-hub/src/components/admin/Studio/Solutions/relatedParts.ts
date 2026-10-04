import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';

/**
 * What else comes along when parts are added to a Solution.
 *
 * The server (POST /api/projects/:id/resources/related, projects/relatedParts.js)
 * walks what the chosen parts USE: the automation an app runs, the table an automation
 * writes, the knowledge base an agent is grounded on. This file asks it and
 * keeps the answer apart from the checklist. No React rendering in here.
 *
 * Three states are told apart on purpose, because the panel does something
 * different in each: still asking (adding waits, the list is not known yet),
 * could not ask (adding is still allowed, without the related parts, and the
 * notice says so), and answered (possibly with nothing to add).
 */

export type RelatedStatus = 'addable' | 'already_here' | 'in_other_solution' | 'not_yours' | 'not_found';

export interface RelatedVia { kind: string; id: string; name: string | null; relation: string | null }

export interface RelatedPart {
    kind: string;
    id: string;
    /** Null for a part the caller may not see (not yours, missing). */
    name: string | null;
    /** Why it is needed: a relation code the notice turns into a sentence. */
    relation: string | null;
    /** Who needs it. */
    via: RelatedVia[];
    status: RelatedStatus;
    /** Only for `in_other_solution`, and only when the caller may see that Solution. */
    solutionName?: string | null;
}

export interface RelatedResult {
    /** Dependencies first: a part is listed before whatever needs it. */
    related: RelatedPart[];
    truncated: boolean;
}

export interface RelatedRef { kind: string; id: string }

const STATUSES: RelatedStatus[] = ['addable', 'already_here', 'in_other_solution', 'not_yours', 'not_found'];
const asText = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function parseVia(raw: unknown): RelatedVia[] {
    if (!Array.isArray(raw)) return [];
    const out: RelatedVia[] = [];
    for (const v of raw) {
        if (!v || typeof v !== 'object') continue;
        const r = v as Record<string, unknown>;
        const kind = asText(r.kind);
        const id = asText(r.id);
        if (kind && id) out.push({ kind, id, name: asText(r.name), relation: asText(r.relation) });
    }
    return out;
}

/** The server's answer, or null when it is not one (a body that is not a related list is an error, never "nothing"). */
export function parseRelated(body: unknown): RelatedResult | null {
    if (!body || typeof body !== 'object') return null;
    const raw = (body as { related?: unknown }).related;
    if (!Array.isArray(raw)) return null;
    const related: RelatedPart[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const kind = asText(r.kind);
        const id = asText(r.id);
        if (!kind || !id) continue;
        // A status this client does not know is not one it may add.
        const status = STATUSES.find(s => s === r.status) ?? 'not_found';
        related.push({
            kind, id, name: asText(r.name), relation: asText(r.relation), via: parseVia(r.via), status,
            ...(r.solutionName !== undefined ? { solutionName: asText(r.solutionName) } : {}),
        });
    }
    return { related, truncated: (body as { truncated?: unknown }).truncated === true };
}

export async function fetchRelated(projectId: string, items: RelatedRef[]): Promise<RelatedResult | null> {
    try {
        const res = await authFetch(`${API_BASE}/api/projects/${encodeURIComponent(projectId)}/resources/related`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: items.map(({ kind, id }) => ({ kind, id })) }),
        });
        if (!res.ok) return null;
        return parseRelated(await res.json().catch(() => null));
    } catch {
        return null;
    }
}

export type RelatedState =
    | { status: 'idle' }
    | { status: 'loading' }
    | { status: 'error' }
    | { status: 'ok'; result: RelatedResult };

/** Wait this long after the last tick before asking, so ticking five boxes asks once. */
export const RELATED_DEBOUNCE_MS = 250;

/**
 * The related parts of the ticked items, asked a moment after the selection
 * settles. A selection that changed since the answer was asked is `loading`
 * again, so an old answer is never read against a new selection.
 */
export function useRelatedParts(projectId: string, items: RelatedRef[]): RelatedState & { retry: () => void } {
    const key = items.map(i => `${i.kind}:${i.id}`).sort().join('|');
    const itemsRef = useRef(items);
    itemsRef.current = items;
    const [answer, setAnswer] = useState<{ key: string; result: RelatedResult | null } | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!key) return undefined;
        let alive = true;
        const timer = setTimeout(() => {
            void fetchRelated(projectId, itemsRef.current).then(result => { if (alive) setAnswer({ key, result }); });
        }, RELATED_DEBOUNCE_MS);
        return () => { alive = false; clearTimeout(timer); };
    }, [key, projectId, attempt]);

    const retry = useCallback(() => { setAnswer(null); setAttempt(n => n + 1); }, []);

    if (!key) return { status: 'idle', retry };
    if (!answer || answer.key !== key) return { status: 'loading', retry };
    return answer.result ? { status: 'ok', result: answer.result, retry } : { status: 'error', retry };
}

/** The related parts that will be filed with the selection, dependencies first. */
export function comingAlong(state: RelatedState): RelatedPart[] {
    return state.status === 'ok' ? state.result.related.filter(p => p.status === 'addable') : [];
}

/** The related parts that cannot come along (and the release check will flag). */
export function cannotComeAlong(state: RelatedState): RelatedPart[] {
    return state.status === 'ok'
        ? state.result.related.filter(p => p.status === 'in_other_solution' || p.status === 'not_yours' || p.status === 'not_found')
        : [];
}

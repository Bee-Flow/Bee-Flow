import { API_BASE } from '../../utils/helpers';
import type { ActionCheck, CheckContext, CheckData, CheckVerdict, CriterionExpect, CriterionSpec } from './actionChecks.types';
import { request, RefusedError } from '../../api/mutate';

export async function getJson(path: string) {
    let res: Response;
    try {
        res = await request(`${API_BASE}${path}`);
    } catch (err) {
        if (!(err instanceof RefusedError)) throw err;
        throw new Error(`GET ${path} → ${err.status}`);
    }
    return res.json();
}

// allSettled helper: a failed leg contributes its fallback instead of throwing.
export async function settle<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
    try { return await promise; } catch (_) { return fallback; }
}

// The array a list endpoint answers with: the body itself, or the first
// array-valued property (common names first, then any array property).
export function rowsOf(body: unknown): Record<string, unknown>[] {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== 'object') return [];
    for (const k of ['items', 'rows', 'data', 'results', 'list']) if (Array.isArray((body as Record<string, unknown>)[k])) return (body as Record<string, Record<string, unknown>[]>)[k];
    const first = Object.values(body).find((v: unknown) => Array.isArray(v));
    return (first as Record<string, unknown>[] | undefined) || [];
}

const OWNER_FIELDS = ['ownerId', 'owner_id', 'userId', 'user_id', 'createdBy', 'created_by', 'authorId'];

// True when the row carries no owner field at all (the endpoint is already
// scoped to the caller, e.g. /ai/direct/conversations), or one that names this
// user. A row that DOES name an owner while we don't know who the learner is
// proves nothing: the lesson host can render before the user object is
// populated, and org-wide lists (/agents, /api/webpages) would otherwise credit
// the learner with a colleague's work. An unknown owner never satisfies an
// ownership test.
export function rowOwnedBy(row: Record<string, unknown> | null | undefined, userId: string | null | undefined): boolean {
    if (!row || typeof row !== 'object') return false;
    const field = OWNER_FIELDS.find((f: string) => row[f] !== undefined && row[f] !== null);
    if (!field) return true;
    if (!userId) return false;
    return String(row[field]) === String(userId);
}

// A criterion's endpoint may carry :orgId / :org / :orgid / :id — the learner's
// own organisation. The first version of this factory fetched the path VERBATIM,
// so every placeholder 404'd or 403'd and the criterion could never pass.
export function resolveEndpoint(endpoint: string | undefined, ctx: CheckContext | null | undefined): string | null | undefined {
    const orgId = ctx?.user?.organizationId ?? ctx?.user?.orgId ?? null;
    if (!endpoint) return endpoint;
    if (!/:(orgId|orgid|org|id)\b/i.test(endpoint)) return endpoint; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- an alternation of literals: linear
    if (!orgId) return null;                       // no org → the check cannot run
    return endpoint.replace(/:(orgId|orgid|org|id)\b/gi, encodeURIComponent(orgId));
}

/** Read a dotted path out of a response body ('shield.enabled'). */
export function fieldAt(body: unknown, path: string | undefined): unknown {
    if (!path) return undefined;
    return String(path).split('.').reduce((v: unknown, k: string) => (v == null ? undefined : (v as Record<string, unknown>)[k]), body);
}

/**
 * Not every "did the learner do it" question is "does a list have rows". An
 * admin lesson about switching a setting ON asks whether a CONFIG FIELD is set,
 * and those endpoints answer with an object, not an array. A criterion says what
 * it expects with `expect`:
 *   { kind: 'rows', field? }               at least one row the learner owns
 *   { kind: 'truthy', field: 'a.b' }       that field is true / non-zero / non-empty
 *   { kind: 'nonEmpty', field: 'a.b' }     that field is a non-empty array or string
 *   { kind: 'equals', field: 'a.b', value: x }
 *
 * There is deliberately NO default. A criterion asserts something specific —
 * "a conversation of yours ran on a depth you picked", "one of your chats holds
 * an attachment" — and an `expect` that is missing (or names a kind this
 * evaluator does not implement) means the runtime cannot check that claim. Such
 * a criterion is UNVERIFIABLE: it never passes, so the step falls back to the
 * honor path instead of crediting the learner off the first row of a generic
 * list endpoint they merely opened once.
 */
const VERIFIABLE_EXPECT_KINDS = new Set(['rows', 'truthy', 'nonEmpty', 'equals']);

/** Does this criterion declare something this runtime can actually verify? */
export function isVerifiable(criterion: CriterionSpec | null | undefined): boolean {
    const kind = criterion?.expect?.kind;
    return typeof kind === 'string' && VERIFIABLE_EXPECT_KINDS.has(kind);
}

export function evaluateCriterion(criterion: CriterionSpec, body: unknown, userId: string | null | undefined): boolean {
    if (!isVerifiable(criterion)) return false;
    if (body == null) return false;
    const expect = criterion.expect as CriterionExpect;
    const v = expect.field ? fieldAt(body, expect.field) : body;
    switch (expect.kind) {
        case 'truthy':
            return Array.isArray(v) ? v.length > 0 : Boolean(v);
        case 'nonEmpty':
            return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0;
        case 'equals':
            return v === expect.value;
        case 'rows': {
            const rows = rowsOf(v);
            return rows.some((r) => rowOwnedBy(r, userId));
        }
        default:
            return false;
    }
}

export function listCheckFromSpec(spec: { criteria?: CriterionSpec[] }): ActionCheck {
    const specCriteria = spec.criteria || [];
    const criteria = specCriteria.map((c: CriterionSpec) => ({
        id: c.id, labelFallback: c.labelFallback, labelKey: c.labelKey,
        hintFallback: c.hintFallback, hintKey: c.hintKey, gate: c.gate,
        unverifiable: !isVerifiable(c),
    }));
    return {
        criteria,
        async fetchState(ctx: CheckContext) {
            // Only criteria that declare a checkable expectation are worth a
            // request; the rest cannot be judged from any response.
            const checkable = specCriteria.filter(isVerifiable);
            if (!checkable.length) throw new Error('unverifiable');
            const paths = checkable.map((c: CriterionSpec) => resolveEndpoint(c.endpoint, ctx));
            const legs = await Promise.all(paths.map((p: string | null | undefined) => (p ? settle(getJson(p), null) : Promise.resolve(null))));
            if (legs.every((l) => l === null)) throw new Error('fetch_failed');
            const data: CheckData = { __bodies: {}, userId: ctx?.user?.id || null };
            checkable.forEach((c: CriterionSpec, i: number) => { (data.__bodies as Record<string, unknown>)[c.id] = legs[i]; });
            return data;
        },
        evaluate(data: CheckData) {
            const out: CheckVerdict = {};
            for (const c of specCriteria) out[c.id] = evaluateCriterion(c, data?.__bodies?.[c.id], data?.userId);
            return out;
        },
    };
}

import { fromError } from '../utils/managedPart';
import { type AutomationListFilter, type RunQuery, type FacetQuery, type ErrorBody, type ValidatorDetail } from './useAutomationApi.types2';

/**
 * One failed response, read ONCE.
 *
 * A response body can only be consumed once, so "give me the text" and "give
 * me the code" cannot be two passes. This is the single read; safeText is the
 * text half of it and keeps its old signature for the dozen callers that only
 * ever wanted a message.
 */
export async function errorBody(r: Response): Promise<ErrorBody> {
    try {
        const j = await r.json();
        const code = typeof j?.code === 'string' ? j.code : null;
        // The stage's refusals carry `details` as an object ({ solutionId, stage }),
        // which the validator-records branch below would never read.
        const managed = fromError(j);
        // Surface validator details so the user can see WHY the definition is
        // rejected. `details` is an array of structured records
        // ({code, message, hint, ...}) — render their human messages, not the
        // raw objects (which would stringify to "[object Object]").
        if (j.error && Array.isArray(j.details) && j.details.length) {
            const msgs = j.details.map(detailText).filter(Boolean);
            return { message: msgs.length ? `${j.error}: ${msgs.join('; ')}` : j.error, code, details: j.details, managed };
        }
        return { message: j.error || JSON.stringify(j), code, details: null, managed };
    } catch { return { message: r.statusText, code: null, details: null, managed: null }; }
}

export async function safeText(r: Response): Promise<string> {
    return (await errorBody(r)).message;
}

/**
 * One validator detail as a sentence — INCLUDING its hint (BFSF-348).
 *
 * Every record the server rejects a definition with carries both a `message`
 * ("Step step_7: a form step needs the automation to start with a form trigger")
 * and a `hint` ("Switch the trigger to Form, or remove this step") — the
 * message says what is wrong, the hint says what to do about it. We used to
 * drop the hint on the floor, which left the user staring at a rule with no
 * way out of it: the one actionable half of the error was fetched, parsed and
 * then discarded.
 *
 * The hint is skipped when the message already contains it, so a server that
 * spells both into `message` doesn't produce a stutter.
 */
function detailText(d: string | ValidatorDetail | null | undefined): string {
    if (typeof d === 'string') return d;
    if (!d) return '';
    const message = d.message || d.code || '';
    const hint = typeof d.hint === 'string' ? d.hint.trim() : '';
    if (!hint || message.includes(hint)) return message;
    return message ? `${message} — ${hint}` : hint;
}

// Build the executions list query string. Arrays (status/trigger/mode) are
// sent comma-separated; the server parses them back into ANY(...) filters.
export function buildRunQuery(opts: RunQuery = {}): string {
    const p = new URLSearchParams();
    const csv = (v?: string | string[]) => (Array.isArray(v) ? v.filter(Boolean).join(',') : v);
    if (opts.limit != null) p.set('limit', String(opts.limit));
    if (opts.cursor) p.set('cursor', opts.cursor);
    if (opts.automationId) p.set('automationId', opts.automationId);
    if (opts.kind) p.set('kind', opts.kind);
    const status = csv(opts.status); if (status) p.set('status', status);
    const trigger = csv(opts.trigger || opts.triggerKind); if (trigger) p.set('triggerKind', trigger);
    const mode = csv(opts.mode); if (mode) p.set('mode', mode);
    if (opts.since) p.set('since', opts.since);
    if (opts.until) p.set('until', opts.until);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
}

// The automations list query. Only the two app-event narrowing parameters
// exist server-side; anything else is dropped here rather than sent, so a
// caller cannot invent a filter the route would ignore.
export function buildAutomationListQuery(filter?: AutomationListFilter): string {
    const p = new URLSearchParams();
    if (filter?.triggerProvider) p.set('triggerProvider', filter.triggerProvider);
    if (filter?.triggerEvent) p.set('triggerEvent', filter.triggerEvent);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
}

export function buildFacetQuery(opts: FacetQuery = {}): string {
    const p = new URLSearchParams();
    if (opts.range != null) p.set('range', String(opts.range));
    if (opts.automationId) p.set('automationId', opts.automationId);
    if (opts.kind) p.set('kind', opts.kind);
    const mode = Array.isArray(opts.mode) ? opts.mode.filter(Boolean).join(',') : opts.mode;
    if (mode) p.set('mode', mode);
    const qs = p.toString();
    return qs ? `?${qs}` : '';
}

/**
 * The cross-cutting step options the inspector round-trips on several step
 * types: "run once per item" (forEach), "try again" (retry), "ask this app
 * only once" (askOnce), "remember answers in a table" (cacheInto) and the
 * collection ops' input cap (maxItems). Each has an allow-list of the types
 * that carry it, a normaliser, and one shared persist rule for buildPatch.
 */
import { clamp } from './primitives';
import type { FormRecord, JsonValue } from './types';

/**
 * Step types whose "run once per item" (forEach) config the inspector edits.
 * Mirrors the runtime/validator allow-list (validate.js FOREACH_ALLOWED) —
 * the runner honoured forEach on all five, but the form only round-tripped
 * it for integration_action, silently dropping it everywhere else (C12/C16/
 * C18). http_request joined them once the validator stopped disagreeing with
 * the runtime about it: "one API call per row" is the shape the response
 * cache exists for.
 */
export const FOREACH_FORM_TYPES = new Set<string>([
    'integration_action', 'ai_step', 'code', 'notification', 'set', 'http_request',
    // The two steps whose effect outlives the run. Both editors already
    // RENDERED the Iteration toggle and neither round-tripped it, so turning it
    // on looked like it worked and was gone on the next open — the same C12
    // bug this list was written to close, reopened by two later step types.
    'datatable', 'knowledge_write',
    // Fan-out over a list of documents ("one invoice per file") is the
    // extraction step's most common shape, so it round-trips from day one.
    'data_extraction',
]);

/** The well-formed `{ itemVar, overRef }` entries of a forEach's `parents`. */
function forEachParents(parents: unknown): FormRecord[] {
    if (!Array.isArray(parents)) return [];
    return parents
        .filter(p => p && typeof p.itemVar === 'string' && p.itemVar && typeof p.overRef === 'string' && p.overRef)
        .map(p => ({ itemVar: p.itemVar, overRef: p.overRef }));
}

/**
 * "Items at the same time" (an AI step without tools, data extraction). Kept as
 * the author wrote it, NOT clamped: the validator's foreach.concurrency_range
 * is how a wrong number is found out. Empty means the server default, and is
 * written as no key at all.
 */
function forEachConcurrency(value: JsonValue): { concurrency?: number } {
    if (value === undefined || value === null || value === '') return {};
    const n = Number(value);
    return Number.isFinite(n) ? { concurrency: Math.round(n) } : {};
}

/**
 * One shared forEach persist rule: normalize when enabled, explicit null to
 * clear an existing one when the user toggles it off.
 */
export function applyForEachPatch(patch: FormRecord, step: FormRecord, draft: FormRecord): void {
    if (draft.forEach) {
        // `parents`: the outer lists a step over a list inside a list keeps
        // (mapping/deepenForEach.ts; the runner binds each item's outer item
        // under that name). Dropping them here unbound every field that still
        // reads the outer item, the moment the form saved.
        const parents = forEachParents(draft.forEach.parents);
        patch.forEach = {
            overRef: draft.forEach.overRef || '',
            itemVar: draft.forEach.itemVar || 'item',
            maxIterations: clamp(Number(draft.forEach.maxIterations) || 100, 1, 1000),
            ...(parents.length ? { parents } : {}),
            ...forEachConcurrency(draft.forEach.concurrency),
        };
    } else if (step.forEach) {
        patch.forEach = null;
    }
}

/**
 * Step types whose "try again if this step fails" row the inspector edits.
 *
 * The SAME list is read in both directions — extractFormState puts `retry`
 * in the draft for these types and buildPatch persists it for these types —
 * because the two halves disagreeing is exactly the bug this file keeps
 * having to close (C12, C16, C18, the askOnce tick).
 *
 * `retry` is dispatched type-agnostically by execution.js, so the runner
 * honours it on ANY step. The list is narrower than that on purpose: it is
 * the steps that can fail for a reason a second attempt might not hit —
 * something over a network, or something an LLM provider is briefly too busy
 * to do. Types left out are left out for a reason rather than by omission:
 *   • `set` computes values from data already in hand, so try 2 produces
 *     exactly what try 1 produced. Same for the route and privacy types,
 *     which decide a path from that same data. It is FOREACH_FORM_TYPES
 *     minus `set` plus `slide` for that reason, not an oversight.
 *   • `trigger` never fails as a step — there is nothing to try again.
 *   • `loop`, `parallel` and the approval / wait steps own their own
 *     restart semantics; a retry wrapped around them would re-run bodies
 *     that already succeeded, which is the mistake §WS2.5 documents.
 */
export const RETRY_FORM_TYPES = new Set<string>([
    'integration_action', 'ai_step', 'code', 'notification', 'http_request',
    'datatable', 'knowledge_write', 'data_extraction', 'slide',
]);

/**
 * `retry` in the one shape the runner reads: `{ max, backoffMs }`, where
 * `max` counts the attempts AFTER the first (execution.js loops
 * `for (i = 1; i <= retry.max; i++)` once the first attempt has failed).
 *
 * NOT CLAMPED, on purpose. The editor offers closed lists, so nothing it
 * writes can be out of range; a value outside them came from an AI-built or
 * hand-edited step, and snapping it here would rewrite an author's step on
 * the first unrelated save — the same rule PathField follows. `retry` has no
 * validator to appeal to either (grep automation/validate.js), so a silent
 * clamp would be the only record that the number changed.
 *
 * `backoffMs` is always emitted, 0 included, because the editor always writes
 * both keys: with two spellings for "no wait" (absent and 0) an unrelated
 * edit would keep flipping the step between them.
 *
 * `max <= 0` is the runner's own "do not retry" (`retry.max > 0` gates the
 * whole loop) and normalises to `undefined` — the one canonical off, which
 * drops out of the JSON after the patch merge.
 */
export function normalizeRetry(value: JsonValue): { max: number; backoffMs: number } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const max = Math.round(Number(value.max));
    if (!Number.isFinite(max) || max <= 0) return undefined;
    const backoff = Math.round(Number(value.backoffMs));
    return { max, backoffMs: Number.isFinite(backoff) && backoff > 0 ? backoff : 0 };
}

/**
 * Same shape as applyAskOncePatch, and the clear is `undefined` for the same
 * reason: off must have ONE spelling or unticking builds a patch deepEqual to
 * the ticked one and flushNow never calls the server.
 *
 * The clear is guarded on an EFFECTIVE retry, not merely on the key being
 * there. A step that stores `{ max: 0 }` is already off; clearing it would
 * put a key the author never touched into the patch, and the run history
 * would show a definition change that changed nothing.
 */
export function applyRetryPatch(patch: FormRecord, step: FormRecord, draft: FormRecord): void {
    const next = normalizeRetry(draft.retry);
    if (next !== undefined) patch.retry = next;
    else if (step.retry && Number(step.retry.max) > 0) patch.retry = undefined;
}

/**
 * Step types whose "ask this app only once per run" tick the inspector
 * round-trips. Mirrors the runtime's readers — execIntegrationAction today,
 * execOutbound next — so the form never carries a field the engine ignores.
 */
export const ASK_ONCE_FORM_TYPES = new Set<string>(['integration_action', 'http_request', 'ai_step']);

/**
 * `askOnce` in exactly the shapes the runtime reads, mirroring
 * server/automation/builderTools/stepEditing.js normalizeAskOnce so a
 * hand-ticked step and an AI-built one are the same object.
 *
 * `true` is the plain tick; `{ acrossRuns?, ttlSeconds? }` is that plus the
 * wider promise. An object with nothing recognised in it still means "ask
 * once" — the runner reads `!!step.askOnce`, so collapsing `{}` to off here
 * would silently switch a shipped setting off on an unrelated save. Anything
 * falsy normalises to `undefined`, the one canonical "off": with two spellings
 * for off, unticking would build a patch deepEqual to the ticked one and
 * flushNow would never call onPatch.
 *
 * ttlSeconds is NOT clamped, for the same reason the builder tool does not
 * clamp it: the validator's ask_once_ttl_range error is how the author finds
 * out, and a silent clamp teaches them nothing.
 */
export function normalizeAskOnce(value: JsonValue): true | { acrossRuns?: true; ttlSeconds?: number } | undefined {
    if (value === true) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: { acrossRuns?: true; ttlSeconds?: number } = {};
    if (value.acrossRuns === true) out.acrossRuns = true;
    const ttl = Number(value.ttlSeconds);
    if (Number.isFinite(ttl)) out.ttlSeconds = Math.round(ttl);
    return Object.keys(out).length ? out : true;
}

/**
 * One shared askOnce persist rule, same shape as applyForEachPatch above with
 * one difference: the clear is `undefined`, never `null`.
 *
 * A persisted `null` reads as off everywhere today, but it leaves the key in
 * the definition — a fourth spelling of off beside absent, `false` and `{}`,
 * and the previous validator guard (`!== undefined && !== false`) walked one
 * straight into the write check and errored a step whose setting did nothing.
 * `undefined` survives the patch-merge and then drops out of the JSON, so off
 * has one shape: absent. Same key-removal idiom `set`/`datetime` use for
 * `arrayRef`.
 *
 * The `step.askOnce` guard keeps an already-off step byte-identical: merely
 * opening a node that stores `askOnce: false` must not rewrite the definition.
 */
export function applyAskOncePatch(patch: FormRecord, step: FormRecord, draft: FormRecord): void {
    const next = normalizeAskOnce(draft.askOnce);
    if (next !== undefined) patch.askOnce = next;
    else if (step.askOnce) patch.askOnce = undefined;
}

/**
 * `cacheInto` in the one shape the runtime reads, mirroring
 * server/automation/builderTools/stepBuilders.js normalizeCacheInto so a
 * hand-ticked step and an AI-built one are the same object.
 *
 * No table means OFF, full stop. A window with nothing to keep it in is a
 * setting that reads as configured and does nothing — which is the exact
 * failure the whole askOnce/cacheInto validator block exists to prevent.
 */
export function normalizeCacheInto(value: JsonValue): { datatableId: string; maxAgeDays?: number } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const datatableId = typeof value.datatableId === 'string' ? value.datatableId.trim() : '';
    if (!datatableId) return undefined;
    const days = Number(value.maxAgeDays);
    return {
        datatableId,
        // NOT clamped, for the same reason ttlSeconds is not: the validator's
        // cache_into_max_age_range error is how the author finds out.
        ...(Number.isFinite(days) ? { maxAgeDays: Math.round(days) } : {}),
    };
}

/** Same shape as applyAskOncePatch, and the clear is `undefined` for the same reason. */
export function applyCacheIntoPatch(patch: FormRecord, step: FormRecord, draft: FormRecord): void {
    const next = normalizeCacheInto(draft.cacheInto);
    if (next !== undefined) patch.cacheInto = next;
    else if (step.cacheInto) patch.cacheInto = undefined;
}

/**
 * Optional collection-op input cap (C19). '' / invalid clears the key —
 * `undefined` drops out of the persisted step after the patch-merge + JSON
 * serialisation, same pattern as dedupe's keyField.
 */
export function applyMaxItemsPatch(patch: FormRecord, draft: FormRecord): void {
    const n = Number(draft.maxItems);
    patch.maxItems = Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

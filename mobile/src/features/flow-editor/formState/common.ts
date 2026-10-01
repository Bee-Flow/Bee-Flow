/**
 * The cross-cutting half of agent-hub `Builder/flow/settings/formState.js`:
 * the rules several step types share (forEach, retry, askOnce, cacheInto, the
 * collection cap) and the binding-map sanitisers. Each list here is read in
 * BOTH directions — the extractor and the patcher disagreeing is the bug this
 * file keeps closing (C12, C16, C18). Pinned by formState.lockstep.test.ts.
 */

import { clamp, get } from './read';
import type { FormDraft, Step, StepPatch } from './types';
import { defaultTriggerLabel } from '../model/triggerLabels';

/** Carry the previous binding's value into the new kind, so toggling loses nothing. */
export function convertValue(binding: unknown, fromKind: unknown, toKind: unknown): Record<string, unknown> {
    if (!binding || fromKind === toKind) return {};
    const carry = get(binding, 'value') ?? get(binding, 'path') ?? '';
    const asText = typeof carry === 'string' ? carry : '';
    if (toKind === 'literal') return { value: typeof carry === 'string' ? carry : String(carry), path: undefined };
    if (toKind === 'ref') return { path: asText, value: undefined };
    if (toKind === 'template' || toKind === 'expr') return { value: asText, path: undefined };
    return {};
}

export function defaultLabelPlaceholder(step: Partial<Step>): string {
    if (step.type === 'integration_action') return (step.tool || step.type) as string;
    if (step.type === 'trigger') return defaultTriggerLabel(step.kind || 'manual');
    return step.type as string;
}

function emptyInput(v: Record<string, unknown>): boolean {
    if (v.kind === 'literal') return v.value === '' || v.value == null;
    if (v.kind === 'ref') return !v.path;
    return (v.kind === 'template' || v.kind === 'expr') && !v.value;
}

/** Tool PARAMS: a binding with nothing in it means "omit the param". */
export function sanitizeInputs(inputs: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((inputs as object) || {})) {
        if (!v || typeof v !== 'object' || emptyInput(v as Record<string, unknown>)) continue;
        out[k] = v;
    }
    return out;
}

/**
 * The user's OWN named fields (Set / layer output): an empty value survives the
 * save, a bare literal is wrapped (C15); only blank keys and nullish drop.
 */
export function sanitizeFieldMap(fields: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((fields as object) || {})) {
        if (!k || !k.trim() || v == null) continue;
        out[k] = typeof v === 'object' ? v : { kind: 'literal', value: v };
    }
    return out;
}

/** An app-event filter without its blank entries. */
export function stripUndefined(obj: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((obj as object) || {})) {
        if (v !== undefined && v !== null && v !== '') out[k] = v;
    }
    return out;
}

/** Step types whose "run once per item" the editor round-trips (validate.js FOREACH_ALLOWED). */
export const FOREACH_FORM_TYPES: ReadonlySet<string> = new Set([
    'integration_action', 'ai_step', 'code', 'notification', 'set', 'http_request',
    'datatable', 'knowledge_write', 'data_extraction',
]);

/**
 * Normalise when on; an explicit null clears an existing one when switched
 * off. The older `forEach` and the `repeat` alike.
 */
export function applyForEachPatch(patch: StepPatch, step: Step, draft: FormDraft): void {
    const fe = draft.forEach as Record<string, unknown> | null | undefined;
    if (fe) {
        patch.forEach = {
            overRef: fe.overRef || '',
            itemVar: fe.itemVar || 'item',
            maxIterations: clamp(Number(fe.maxIterations) || 100, 1, 1000),
        };
    } else if (step.forEach) {
        patch.forEach = null;
    }
    const rep = draft.repeat as Record<string, unknown> | null | undefined;
    if (rep && rep.over) {
        patch.repeat = { over: rep.over, max: clamp(Number(rep.max) || 100, 1, 1000) };
    } else if (step.repeat) {
        patch.repeat = null;
    }
}

/** Step types whose "try again if this step fails" row the editor edits. */
export const RETRY_FORM_TYPES: ReadonlySet<string> = new Set([
    'integration_action', 'ai_step', 'code', 'notification', 'http_request',
    'datatable', 'knowledge_write', 'data_extraction', 'slide',
]);

/** `{ max, backoffMs }`, not clamped; `max <= 0` is the one canonical off (undefined). */
export function normalizeRetry(value: unknown): { max: number; backoffMs: number } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const max = Math.round(Number(get(value, 'max')));
    if (!Number.isFinite(max) || max <= 0) return undefined;
    const backoff = Math.round(Number(get(value, 'backoffMs')));
    return { max, backoffMs: Number.isFinite(backoff) && backoff > 0 ? backoff : 0 };
}

/** The clear is guarded on an EFFECTIVE retry, so an off step stays byte-identical. */
export function applyRetryPatch(patch: StepPatch, step: Step, draft: FormDraft): void {
    const next = normalizeRetry(draft.retry);
    if (next !== undefined) patch.retry = next;
    else if (step.retry && Number(get(step.retry, 'max')) > 0) patch.retry = undefined;
}

/** Step types whose "ask this app only once per run" tick round-trips. */
export const ASK_ONCE_FORM_TYPES: ReadonlySet<string> = new Set(['integration_action', 'http_request']);

/** `true`, or `{ acrossRuns?, ttlSeconds? }`; anything falsy is the one off: undefined. */
export function normalizeAskOnce(value: unknown): true | Record<string, unknown> | undefined {
    if (value === true) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const out: Record<string, unknown> = {};
    if (get(value, 'acrossRuns') === true) out.acrossRuns = true;
    const ttl = Number(get(value, 'ttlSeconds'));
    if (Number.isFinite(ttl)) out.ttlSeconds = Math.round(ttl);
    return Object.keys(out).length ? out : true;
}

export function applyAskOncePatch(patch: StepPatch, step: Step, draft: FormDraft): void {
    const next = normalizeAskOnce(draft.askOnce);
    if (next !== undefined) patch.askOnce = next;
    else if (step.askOnce) patch.askOnce = undefined;
}

/** No table means OFF; the window is not clamped (the validator says so). */
export function normalizeCacheInto(value: unknown): { datatableId: string; maxAgeDays?: number } | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const id = get(value, 'datatableId');
    const datatableId = typeof id === 'string' ? id.trim() : '';
    if (!datatableId) return undefined;
    const days = Number(get(value, 'maxAgeDays'));
    return { datatableId, ...(Number.isFinite(days) ? { maxAgeDays: Math.round(days) } : {}) };
}

export function applyCacheIntoPatch(patch: StepPatch, step: Step, draft: FormDraft): void {
    const next = normalizeCacheInto(draft.cacheInto);
    if (next !== undefined) patch.cacheInto = next;
    else if (step.cacheInto) patch.cacheInto = undefined;
}

/** The optional collection-op input cap (C19): '' / invalid clears the key. */
export function applyMaxItemsPatch(patch: StepPatch, draft: FormDraft): void {
    const n = Number(draft.maxItems);
    patch.maxItems = Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

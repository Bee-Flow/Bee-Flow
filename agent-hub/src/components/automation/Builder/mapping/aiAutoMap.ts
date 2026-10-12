/**
 * Auto-map's AI fallback, from the editor's side.
 *
 * The Auto-map wand maps deterministically first (autoMapInputs.js and
 * schemaMatch.ts: names, synonyms, value kinds). Deep or oddly named JSON —
 * a Graph mail's `value[0].from.emailAddress.address`, a header that lives at
 * `payload.headers[name="Subject"].value`, an HTTP body that is JSON text —
 * often leaves required inputs empty, and the author then has to dig through
 * the tree by hand. This module asks the server (POST
 * /builder/suggest-mappings) for those inputs only, and keeps only what
 * renders as pills.
 *
 * Rules it keeps:
 *   - ONLY on the explicit wand click, never on connect-time auto-map (that
 *     runs on every drag), and only when a required input is still empty —
 *     or nothing at all is mapped.
 *   - Never overwrites a value: an input that is not empty when the answer
 *     arrives keeps what it has.
 *   - Silent when the AI is not there: switched off for the organisation,
 *     offline, rate-limited. The deterministic result stands, and after a
 *     refusal the module stops asking for a while instead of failing on
 *     every click.
 *   - What lands must render as pills: the server already verified each
 *     binding against the samples; `parseValue` (valueParts.js, the
 *     editor's own reader) is the final word on whether it draws as a field
 *     pill (+ one transform chip) or as text with pills.
 *
 * Samples go out bounded (boundSample): lists and long texts cut, JSON text
 * kept as JSON text so paths into it still resolve. The server shortens and
 * masks again before anything reaches a model.
 */
import { parsePath, parseJsonText, scanTemplate } from '@shared/expr/path.mjs';
import { isSecretLikeKey } from './autoMapInputs';
import { isEmptyBinding, partitionInputs } from './partitionInputs';
import { parseValue } from './valueParts';

export interface Binding {
    kind: 'literal' | 'ref' | 'template' | 'expr';
    path?: string;
    value?: unknown;
}

export type Inputs = Record<string, Binding | unknown>;

/** One input the AI may fill: what the server needs to judge a value. */
export interface AiParam {
    key: string;
    type?: string | string[] | null;
    format?: string | null;
    title?: string | null;
    description?: string | null;
    required?: boolean;
    enum?: Array<string | number | boolean | null> | null;
    itemsType?: string | null;
}

/** The part of an upstream group (upstream/groups.js) this module reads. */
export interface GroupLike {
    label?: string;
    basePath?: string;
    sample?: unknown;
    hasRealData?: boolean;
}

export interface SuggestSource { root: string; label?: string; real?: boolean; sample: unknown }

export interface SuggestMappingsRequest {
    step?: { label?: string; tool?: string };
    params: AiParam[];
    mapped: Array<{ key: string; kind: Binding['kind']; paths?: string[] }>;
    sources: SuggestSource[];
}

export interface SuggestMappingsApi {
    suggestMappings: (body: SuggestMappingsRequest) => Promise<unknown>;
}

export interface AiAutoMapResult {
    /** Verified, pill-shaped bindings for inputs that were empty. */
    patch: Record<string, Binding>;
    keys: string[];
    /** One line per filled input: where the value comes from. */
    reasons: Record<string, string>;
    /** 'skipped' = nothing to ask; 'unavailable' = the AI did not answer. */
    status: 'ok' | 'skipped' | 'unavailable';
}

const MAX_PARAMS = 40;
const MAX_SOURCES = 12;
const SOURCE_BUDGET_CHARS = 150_000;
// All sources together; the server refuses more than 600 000.
const TOTAL_BUDGET_CHARS = 550_000;
const MAX_DEPTH = 16;
// Tried in order until a sample fits SOURCE_BUDGET_CHARS. Generous first: a
// name/value list (mail headers) is only matched by name when its entry is
// still in the sample.
const BOUNDS = [
    { list: 60, text: 2000, keys: 120 },
    { list: 20, text: 500, keys: 80 },
    { list: 5, text: 160, keys: 40 },
];

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

// ── Which inputs ────────────────────────────────────────────────────────────

interface SchemaProp {
    type?: string | string[];
    format?: string;
    title?: string;
    description?: string;
    enum?: unknown[];
    items?: { type?: string };
}

// The request stays inside what the server's schema accepts (suggestMappings.js):
// one refusal would pause the asking for every editor on the page.
const scalarEnum = (e: unknown): AiParam['enum'] => (Array.isArray(e) && e.length
    && e.every(x => x === null || ['number', 'boolean'].includes(typeof x) || (typeof x === 'string' && x.length <= 300))
    ? (e as AiParam['enum'])!.slice(0, 40)
    : null);
const shortWord = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 ? v : null);

/** A tool's JSON-schema inputs as AI params. */
export function paramsFromSchema(schema: { properties?: Record<string, SchemaProp>; required?: string[] } | null | undefined): AiParam[] {
    const props = schema?.properties || {};
    const required = new Set(schema?.required || []);
    return Object.keys(props).map((key) => {
        const p = props[key] || {};
        return {
            key,
            type: Array.isArray(p.type) ? p.type.filter(x => typeof x === 'string' && x.length <= 40).slice(0, 6) : shortWord(p.type),
            format: shortWord(p.format),
            title: typeof p.title === 'string' ? p.title.slice(0, 200) : null,
            description: typeof p.description === 'string' ? p.description.slice(0, 600) : null,
            required: required.has(key),
            enum: scalarEnum(p.enum),
            itemsType: shortWord(p.items?.type),
        };
    });
}

/** A flowlet / Step contract ([{ name, type, required, description }]) as AI params. */
export function paramsFromContract(contract: Array<{ name: string; type?: string; required?: boolean; description?: string }> | null | undefined): AiParam[] {
    return (contract || []).filter(p => p && p.name).map(p => ({
        key: p.name,
        type: shortWord(p.type),
        description: typeof p.description === 'string' ? p.description.slice(0, 600) : null,
        required: !!p.required,
    }));
}

/**
 * The inputs worth asking the AI about — or none, when it should not be
 * asked at all. It is asked only while a REQUIRED input is still empty, or
 * nothing is mapped yet. Optional inputs come along only when the form shows
 * them by default (`essential`): an optional setting tucked behind "Show
 * more" is not something to fill behind the author's back.
 */
export function aiTargets(params: AiParam[], inputs: Inputs, essential: ((key: string) => boolean) | null = null): AiParam[] {
    const empty = (params || []).filter(p => isEmptyBinding(inputs?.[p.key]) && !isSecretLikeKey(p.key) && p.key.length <= 200);
    const requiredEmpty = empty.some(p => p.required);
    const nothingMapped = (params || []).every(p => isEmptyBinding(inputs?.[p.key]));
    if (!empty.length || (!requiredEmpty && !nothingMapped)) return [];
    return empty.filter(p => p.required || !essential || essential(p.key)).slice(0, MAX_PARAMS);
}

/** "Shown by default" for a tool's schema — the same split the form draws. */
export function essentialFromSchema(schema: { properties?: Record<string, unknown>; required?: string[] } | null | undefined, inputs: Inputs): (key: string) => boolean {
    const { essentialKeys } = partitionInputs(schema?.properties || {}, new Set(schema?.required || []), inputs || {});
    const set = new Set<string>(essentialKeys);
    return (key) => set.has(key);
}

// ── Samples ─────────────────────────────────────────────────────────────────

type Bounds = typeof BOUNDS[number];

function boundValue(v: unknown, b: Bounds, depth: number): unknown {
    if (depth > MAX_DEPTH) return null;
    if (typeof v === 'string') {
        // JSON text stays JSON text (the runtime reads paths through it), just smaller.
        const parsed = v.length > 1 ? parseJsonText(v) : undefined;
        if (parsed !== undefined) return JSON.stringify(boundValue(parsed, b, depth + 1));
        return v.length > b.text ? `${v.slice(0, b.text)}…` : v;
    }
    if (Array.isArray(v)) return v.slice(0, b.list).map(x => boundValue(x, b, depth + 1));
    if (isObject(v)) {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v).slice(0, b.keys)) out[k] = boundValue(v[k], b, depth + 1);
        return out;
    }
    return typeof v === 'number' || typeof v === 'boolean' || v === null ? v : null;
}

/** A sample small enough to send, or undefined when even the tightest bound is too big. */
export function boundSample(sample: unknown): unknown {
    for (const b of BOUNDS) {
        const out = boundValue(sample, b, 0);
        let size = Infinity;
        try { size = JSON.stringify(out).length; } catch { /* not serialisable */ }
        if (size <= SOURCE_BUDGET_CHARS) return out;
    }
    return undefined;
}

/** A root the server accepts: steps.<id>.output, trigger.output or loop.<name>. */
function isSourceRoot(root: string): boolean {
    if (root.length > 300) return false;
    const t = parsePath(root) as Array<{ type: string; key: unknown }> | null;
    if (!t || t.some(x => x.type !== 'prop' || typeof x.key !== 'string')) return false;
    const head = t[0].key;
    return (head === 'steps' && t.length === 3 && t[2].key === 'output')
        || (head === 'trigger' && t.length === 2 && t[1].key === 'output')
        || (head === 'loop' && t.length === 2);
}

/** A group's sample is worth sending: there, not the server's truncation sentinel, not `{}`. */
const hasSample = (raw: unknown): boolean => raw !== undefined
    && !(isObject(raw) && (raw.__truncated__ === true || !Object.keys(raw).length));

/**
 * The upstream groups as sources, nearest last (the groups' own order).
 * Groups already carry the real run/pinned output where there is one
 * (computeUpstreamGroups' overlay); `real` tells the model which.
 */
export function sourcesFromGroups(groups: GroupLike[] | null | undefined): SuggestSource[] {
    const byRoot = new Map<string, SuggestSource>();
    for (const g of groups || []) {
        const root = String(g?.basePath || '').trim();
        if (!isSourceRoot(root) || !hasSample(g.sample)) continue;
        const raw = g.sample;
        // Several triggers share trigger.output: the one with real data wins.
        const prev = byRoot.get(root);
        if (prev && (prev.real || !g.hasRealData)) continue;
        const sample = boundSample(raw);
        if (sample === undefined) continue;
        byRoot.set(root, { root, label: String(g.label || '').slice(0, 120), real: !!g.hasRealData, sample });
    }
    return withinBudget([...byRoot.values()]);
}

/** Nearest first into the budget: a far step is the one to leave out. */
function withinBudget(sources: SuggestSource[]): SuggestSource[] {
    const kept: SuggestSource[] = [];
    let total = 0;
    for (const src of sources.slice().reverse()) {
        if (kept.length >= MAX_SOURCES) break;
        const size = JSON.stringify(src.sample).length;
        if (total + size > TOTAL_BUDGET_CHARS) continue;
        total += size;
        kept.unshift(src);
    }
    return kept;
}

/** What the inputs that already have a value read — paths only, never a typed value. */
export function mappedContext(inputs: Inputs, skip: Set<string>): SuggestMappingsRequest['mapped'] {
    const out: SuggestMappingsRequest['mapped'] = [];
    for (const [key, b] of Object.entries(inputs || {})) {
        if (skip.has(key) || isEmptyBinding(b)) continue;
        const binding = (isObject(b) && typeof b.kind === 'string' ? b : { kind: 'literal' }) as unknown as Binding;
        if (!['literal', 'ref', 'template', 'expr'].includes(binding.kind)) continue;
        let paths: string[] = [];
        if (binding.kind === 'ref' && typeof binding.path === 'string') paths = [binding.path];
        if (binding.kind === 'template' && typeof binding.value === 'string') {
            paths = scanTemplate(binding.value).filter(p => p.type === 'ref' && parsePath(p.inner)).map(p => (p as { inner: string }).inner);
        }
        out.push({ key: key.slice(0, 200), kind: binding.kind, paths: paths.slice(0, 10).map(p => p.slice(0, 1000)) });
    }
    return out.slice(0, 80);
}

/** The request body, or null when there is nothing to ask or nothing to map from. */
export function buildSuggestRequest({ params, inputs, groups, step = null }: {
    params: AiParam[]; inputs: Inputs; groups: GroupLike[]; step?: { label?: string; tool?: string } | null;
}): SuggestMappingsRequest | null {
    if (!params.length) return null;
    const sources = sourcesFromGroups(groups);
    if (!sources.length) return null;
    const body: SuggestMappingsRequest = {
        params: params.map(p => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null && v !== undefined && v !== '')) as unknown as AiParam),
        mapped: mappedContext(inputs, new Set(params.map(p => p.key))),
        sources,
    };
    const label = String(step?.label || '').trim().slice(0, 200);
    const tool = String(step?.tool || '').trim().slice(0, 200);
    if (label || tool) body.step = { ...(label ? { label } : {}), ...(tool ? { tool } : {}) };
    return body;
}

// ── The answer ──────────────────────────────────────────────────────────────

/** A binding as the server sent it, or null when it is not one. */
function readBinding(b: unknown): Binding | null {
    if (!isObject(b)) return null;
    if (b.kind === 'ref') return typeof b.path === 'string' && b.path.trim() ? { kind: 'ref', path: b.path.trim() } : null;
    if (b.kind === 'template' || b.kind === 'expr') return typeof b.value === 'string' && b.value.trim() ? { kind: b.kind, value: b.value } : null;
    return null;
}

/**
 * The server's suggestions, reduced to bindings that fill an input that is
 * still empty AND draw as pills in this editor.
 */
export function acceptSuggestions(response: unknown, { params, inputs }: { params: AiParam[]; inputs: Inputs }) {
    const asked = new Set(params.map(p => p.key));
    const patch: Record<string, Binding> = {};
    const reasons: Record<string, string> = {};
    const list = isObject(response) && Array.isArray(response.suggestions) ? response.suggestions : [];
    for (const s of list) {
        const key = isObject(s) && typeof s.key === 'string' ? s.key : '';
        if (!asked.has(key) || patch[key] || !isEmptyBinding(inputs?.[key])) continue;
        const binding = readBinding((s as Record<string, unknown>).binding);
        // The editor's own reader decides: a field pill, a pill + one chip,
        // or text with pills. Anything it would show as raw formula text is
        // not what the author asked Auto-map for.
        if (!binding || !parseValue(binding).supported) continue;
        patch[key] = binding;
        const reason = (s as Record<string, unknown>).reason;
        if (typeof reason === 'string' && reason.trim()) reasons[key] = reason.trim().slice(0, 160);
    }
    return { patch, keys: Object.keys(patch), reasons };
}

/** Only the keys still empty in `current` — a value the author set meanwhile wins. */
export function fillEmpty(current: Inputs, patch: Record<string, Binding>): { next: Inputs; keys: string[] } {
    const keys = Object.keys(patch).filter(k => isEmptyBinding(current?.[k]));
    if (!keys.length) return { next: current, keys };
    const next: Inputs = { ...(current || {}) };
    for (const k of keys) next[k] = patch[k];
    return { next, keys };
}

// ── Availability ────────────────────────────────────────────────────────────

// After a refusal the wand stops asking for a while: off for the
// organisation (403) or a server without this route (404) for the session;
// rate-limited or unreachable for a short pause. Module state on purpose:
// every editor on the page shares the one answer.
let pausedUntil = 0;
const OFF = Number.POSITIVE_INFINITY;

function pauseFor(e: unknown): void {
    const err = e as { status?: number; retryAfter?: number } | null;
    const status = err?.status;
    if (status === 403 || status === 404) pausedUntil = OFF;
    else if (status === 429) pausedUntil = Date.now() + Math.max(15, Number(err?.retryAfter) || 60) * 1000;
    else pausedUntil = Date.now() + 30_000;
}

/** Tests only: forget a previous refusal. */
export function resetAiAutoMapAvailability(): void {
    pausedUntil = 0;
}

/**
 * Ask the AI for `params` (already narrowed by aiTargets). Never throws:
 * whatever goes wrong comes back as `status: 'unavailable'` with an empty
 * patch, so the caller's deterministic result simply stands.
 */
export async function aiAutoMap({ api, params, inputs, groups, step = null }: {
    api: SuggestMappingsApi | null | undefined;
    params: AiParam[];
    inputs: Inputs;
    groups: GroupLike[];
    step?: { label?: string; tool?: string } | null;
}): Promise<AiAutoMapResult> {
    const none = (status: AiAutoMapResult['status']): AiAutoMapResult => ({ patch: {}, keys: [], reasons: {}, status });
    if (!api || typeof api.suggestMappings !== 'function') return none('unavailable');
    if (Date.now() < pausedUntil) return none('unavailable');
    const body = buildSuggestRequest({ params, inputs, groups, step });
    if (!body) return none('skipped');
    let response: unknown;
    try {
        response = await api.suggestMappings(body);
    } catch (e) {
        pauseFor(e);
        return none('unavailable');
    }
    return { ...acceptSuggestions(response, { params, inputs }), status: 'ok' };
}

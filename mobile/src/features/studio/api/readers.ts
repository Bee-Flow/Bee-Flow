/**
 * Contract readers for the /api/studio aggregates
 * (server/routes/studio/{counts,attention,search,aiRoute}.js).
 *
 * All three share one rule, and the readers keep it: an ABSENT key means
 * "not yours" (gated) and is left absent — never defaulted to 0 or to an
 * empty list, which would turn "you may not see this" into "there is none".
 */

import { asCount, field, pick, shapeListOf, shapeOf } from '@/core/api/contract';
import { KIND_KEYS, type KindKey } from '@/shared/ui';

import type {
    AttentionRow,
    DescribeItAnswer,
    DescribeItCompanion,
    StudioAttention,
    StudioCounts,
    StudioHit,
    StudioSearch,
} from '../model/api';

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `{ counts: { automations: 3, … }, makers? }` — only the numeric keys survive. */
export function readStudioCounts(raw: unknown): StudioCounts {
    const counts: Record<string, number> = {};
    const source = pick(raw, 'counts');
    if (isObject(source)) {
        for (const [key, value] of Object.entries(source)) {
            const n = asCount(value);
            if (n !== null) counts[key] = n;
        }
    }
    return { counts, makers: asCount(pick(raw, 'makers')) };
}

const readAttentionRows: (raw: unknown) => AttentionRow[] = shapeListOf({
    source: field.str(''),
    code: field.str(''),
    severity: field.oneOf(['error', 'warning', 'info'] as const, 'info'),
    kind: field.strOrNull,
    targetId: field.strOrNull,
    message: field.str(''),
    remediation: field.strOrNull,
    deepLink: field.strOrNull,
});

const readAttentionBody = shapeOf({
    rows: readAttentionRows,
    total: field.num(0),
    unavailable: field.strArray,
    capped: field.strArray,
    gated: field.strArray,
    // The ONE field that licenses "nothing needs attention"; a body without it
    // is not a clean bill of health.
    complete: field.bool(false),
});

export function readStudioAttention(raw: unknown): StudioAttention {
    return readAttentionBody(raw);
}

const readHits: (raw: unknown) => StudioHit[] = shapeListOf({ id: field.str(''), name: field.str('') });

/**
 * `{ query, tooShort, results: { <kind>: [{ id, name }] }, errors: [<kind>] }`.
 * A kind searched with no match is an EMPTY array; a kind not searched (gated
 * or failed) is absent — and `errors` says which of the two.
 */
export function readStudioSearch(raw: unknown): StudioSearch {
    const results: Record<string, StudioHit[]> = {};
    const source = pick(raw, 'results');
    if (isObject(source)) {
        for (const [kind, rows] of Object.entries(source)) {
            if (Array.isArray(rows)) results[kind] = readHits(rows).filter((hit) => hit.id);
        }
    }
    return {
        query: field.str('')(pick(raw, 'query')),
        tooShort: field.bool(false)(pick(raw, 'tooShort')),
        results,
        errors: field.strArray(pick(raw, 'errors')),
    };
}

// ── "Describe it" (POST /api/studio/ai/route) ──────────────────────────────
//
// The web's studioAi/routeApi.js, line for line: a model's answer is
// untrusted even after the server clamped it. A kind must be one the kit
// knows (KIND_KEYS, the list the tiles and colours read), a broken companion
// is DROPPED rather than repaired, and an unknown kind is null — never a guess.

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function asKind(value: unknown): KindKey | null {
    const key = asText(value);
    return (KIND_KEYS as readonly string[]).includes(key) ? (key as KindKey) : null;
}

/** Known kinds, each once; null when there was no list at all ("unknown", not "none"). */
function asKindList(value: unknown): KindKey[] | null {
    if (!Array.isArray(value)) return null;
    const out: KindKey[] = [];
    for (const entry of value) {
        const kind = asKind(entry);
        if (kind && !out.includes(kind)) out.push(kind);
    }
    return out;
}

/** The main kind is the card's title, so it is not listed again; a kind counts once. */
function asCompanions(value: unknown, main: KindKey | null): DescribeItCompanion[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<KindKey>(main ? [main] : []);
    const out: DescribeItCompanion[] = [];
    for (const entry of value) {
        const bare = typeof entry === 'string';
        const kind = asKind(bare ? entry : pick(entry, 'kind'));
        if (!kind || seen.has(kind)) continue;
        seen.add(kind);
        out.push({ kind, name: bare ? '' : asText(pick(entry, 'name')) });
    }
    return out;
}

/**
 * `{ kind, name, seed, companions, available, undecided }`. Null when the
 * body is not an object: a 200 we could not read is "could not read that",
 * which must never turn into "the AI chose nothing" (`kind: null`).
 */
export function readDescribeIt(raw: unknown): DescribeItAnswer | null {
    if (!isObject(raw)) return null;
    const kind = asKind(raw.kind);
    return {
        kind,
        name: asText(raw.name),
        seed: asText(raw.seed),
        companions: asCompanions(raw.companions, kind),
        available: asKindList(raw.available),
        undecided: asKindList(raw.undecided) ?? [],
    };
}

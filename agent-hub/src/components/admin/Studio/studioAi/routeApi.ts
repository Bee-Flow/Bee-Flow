import { API_BASE, authFetch } from '../../../../utils/helpers';
import { KIND_KEYS } from '../../../shared/kindColors';
import { isAbortError } from '../../../../utils/caughtError';
import { logger } from '../../../../utils/logger';

/** The answer of the endpoint: untrusted input, so every field is still `unknown`. */
interface PayloadBody {
    code?: unknown;
    kind?: unknown;
    name?: unknown;
    seed?: unknown;
    companions?: unknown;
    available?: unknown;
    undecided?: unknown;
}

/** What the router returns: a successful answer (also without a chosen kind), or the reason there was none. */
export type RouteResult =
    | {
        ok: true;
        kind: string | null;
        name: string;
        seed: string;
        companions: { kind: string; name: string }[];
        available: string[] | null;
        undecided: string[];
    }
    | { ok: false; code: string };

/**
 * The client of POST /api/studio/ai/route — "describe it, the AI picks the
 * building block" (Track H4, v1: CLASSIFY and HAND OVER).
 *
 * The answer of a model is UNTRUSTED INPUT, also after the server has already
 * clamped it once. That is why nothing passes through here unread: every `kind`
 * is checked against KIND_KEYS (the same list that feeds the colours and the
 * icons), every companion that is not in it is DROPPED instead of repaired, and
 * a `kind` we do not know leads to `undecided: true` — never to a guess.
 *
 * ── The distinction this file must guard ──────────────────────────────────
 *
 * "Nothing found" and "could not read" are two different answers:
 *
 *   { ok: true,  kind: null }      the router HAS answered and chose no building
 *                                  block (why is in `available` and `undecided`
 *                                  below)
 *   { ok: false, code: 'failed' }  there is no answer at all
 *
 * A failed fetch therefore NEVER gives `kind: null` inside a successful result:
 * then the screen would say "the AI chose nothing" while the network fell over,
 * and that is exactly the kind of silent degradation this programme keeps
 * stumbling over.
 *
 * `available` and `undecided` are LISTS OF KINDS, exactly as
 * server/routes/studio/aiRoute.js sends them, and they are there for the same
 * reason (house rule 12: unknown narrows): `available` is what this reader may
 * build, `undecided` the kinds whose gate could not be read. An EMPTY `available`
 * with an EMPTY `undecided` means "you may build nothing here"; an empty
 * `available` with a FILLED `undecided` means "we could not work it out" — two
 * different sentences on the screen, and that difference must not be lost here.
 * If the server says nothing about it, `available` is `null`: that is not "may do
 * everything" but "unknown", and the UI then falls back on its own second brake
 * (the gated `sections`).
 *
 * Aborting is not a failure: an AbortError is PASSED THROUGH, so the caller does
 * not have to render "I cancelled" as "it failed".
 */

/** The five codes this endpoint knows. Everything else becomes `failed`. */
export const ROUTE_ERROR_CODES = Object.freeze(['no_text', 'no_model', 'ai_unusable', 'rate_limited', 'failed']);

// The status convention of the endpoint, one-to-one with server/routes/skills/ai.js:
// empty input 400, no model 503, model gave unusable structure 502, too many in a
// row 429.
const CODE_BY_STATUS: Readonly<Record<number, string>> = Object.freeze({
    400: 'no_text',
    429: 'rate_limited',
    502: 'ai_unusable',
    503: 'no_model',
});

const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A kind we know, or null. Unknown is never passed on. */
const asKind = (value: unknown): string | null => {
    const key = asText(value);
    return (KIND_KEYS as readonly string[]).includes(key) ? key : null;
};

/** A list of kinds we know, or null if there was no list. */
const asKindList = (value: unknown): string[] | null => {
    if (!Array.isArray(value)) return null;
    const out: string[] = [];
    for (const entry of value) {
        const kind = asKind(entry);
        if (kind && !out.includes(kind)) out.push(kind);
    }
    return out;
};

/**
 * The companions as rows `{ kind, name }`.
 *
 * H4b (after K8) turns these into linked empty shells; in v1 they are purely
 * informative. Broken entries disappear, the main kind is not listed again (it is
 * the header of the card), and duplicate kinds count once.
 */
const asCompanions = (value: unknown, mainKind: string | null): { kind: string; name: string }[] => {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>(mainKind ? [mainKind] : []);
    const out: { kind: string; name: string }[] = [];
    for (const entry of value) {
        const kind = asKind(typeof entry === 'string' ? entry : entry?.kind);
        if (!kind || seen.has(kind)) continue;
        seen.add(kind);
        out.push({ kind, name: asText(typeof entry === 'string' ? '' : entry?.name) });
    }
    return out;
};

const errorFrom = (status: number, body: PayloadBody | null): { ok: false; code: string } => {
    const claimed = asText(body?.code);
    if (ROUTE_ERROR_CODES.includes(claimed)) return { ok: false, code: claimed };
    return { ok: false, code: CODE_BY_STATUS[status] || 'failed' };
};

/**
 * Vraag de router welke bouwsteen bij deze beschrijving hoort.
 *
 * `text` is de brief van de gebruiker.
 */
export async function routeDescription(text: string, { signal }: { signal?: AbortSignal } = {}): Promise<RouteResult> {
    const body = asText(text);
    // No network call for an empty brief: the server answers `no_text` here with 400,
    // and we already know that answer before we bother it.
    if (!body) return { ok: false, code: 'no_text' };

    let res: Response;
    try {
        res = await authFetch(`${API_BASE}/api/studio/ai/route`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: body }),
            signal,
        });
    } catch (err) {
        // Cancelling is a choice of the user, not a fault.
        if (isAbortError(err)) throw err;
        return { ok: false, code: 'failed' };
    }

    if (!res || !res.ok) {
        let payload: PayloadBody | null = null;
        try { payload = await res.json(); } catch (err) { logger.debug('geen JSON — status beslist', err); }
        return errorFrom(res?.status, payload);
    }

    let payload: PayloadBody | null = null;
    try { payload = await res.json(); } catch { payload = null; }
    // 200 with an unreadable body is not "nothing found": we could not read the answer.
    if (!payload || typeof payload !== 'object') return { ok: false, code: 'failed' };

    const kind = asKind(payload.kind);
    return {
        ok: true,
        kind,
        name: asText(payload.name),
        seed: asText(payload.seed),
        companions: asCompanions(payload.companions, kind),
        available: asKindList(payload.available),
        undecided: asKindList(payload.undecided) || [],
    };
}


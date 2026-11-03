/**
 * app_get_action: read-only, the FULL stored definition of actions by id.
 *
 * app_get_draft lists actions compactly. A caller that must edit one (app_set_action
 * replaces it) needs every nested step, prompt, schema, binding, contextSource and
 * switch case first; this is that read. It reads the same draft app_set_action writes
 * (def.actions), as a copy.
 *
 * No secret leaves through here. The action vocabulary has no secret-bearing field (a
 * connector or automation is referenced by id, its credentials never sit in the
 * definition), but an author can still paste a token into a literal or a URL. So the
 * copy is redacted as defence in depth: a key that names a secret has its value
 * replaced, and a URL loses its userinfo and its secret-named query parameters.
 */

type Action = Record<string, unknown>;
type Draft = { def?: { actions?: Record<string, Action> } };
type Args = { ids?: unknown };
type Result = Record<string, unknown>;

export const MAX_GET_ACTIONS = 20;
export const REDACTED = '[redacted]';

// Keys whose value is a secret by name. "key" alone is NOT here (a record field key, a
// keyField and a cacheKey are plain names); only the compound forms are.
const SECRET_KEY_RX = /(secret|password|passwd|passphrase|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization|credential|bearer)/i;
const SECRET_QUERY_RX = /^(access_token|id_token|refresh_token|token|api[_-]?key|apikey|key|secret|sig|signature|password|authorization)$/i;
const MAX_DEPTH = 40;

function redactUrl(text: string): string {
    return text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (raw) => {
        try {
            const url = new URL(raw);
            let changed = false;
            if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
            for (const name of [...url.searchParams.keys()]) {
                if (SECRET_QUERY_RX.test(name)) { url.searchParams.set(name, REDACTED); changed = true; }
            }
            return changed ? url.toString() : raw;
        } catch {
            return raw;
        }
    });
}

/** A deep copy of `value` with secret-named keys and URL credentials replaced. Counts the hits. */
export function redactSecrets(value: unknown, hits: { n: number } = { n: 0 }, depth = 0): unknown {
    if (depth > MAX_DEPTH) return REDACTED;
    if (typeof value === 'string') {
        const out = redactUrl(value);
        if (out !== value) hits.n += 1;
        return out;
    }
    if (Array.isArray(value)) return value.map((v) => redactSecrets(v, hits, depth + 1));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (SECRET_KEY_RX.test(k) && v !== null && v !== undefined && v !== '' && v !== false) {
                out[k] = REDACTED;
                hits.n += 1;
            } else {
                out[k] = redactSecrets(v, hits, depth + 1);
            }
        }
        return out;
    }
    return value;
}

export function applyGetAction(draftWrap: Draft, args: Args = {}): Result {
    const raw = Array.isArray(args?.ids) ? args.ids : (typeof args?.ids === 'string' ? [args.ids] : []);
    const ids = [...new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))];
    if (!ids.length) {
        return {
            error: 'ids is required: the act_… ids of the actions to read.',
            _fixHint: `e.g. { ids: ["act_abc123"] }, 1 to ${MAX_GET_ACTIONS} per call. Ids come from app_get_draft (the actions section).`,
        };
    }
    if (ids.length > MAX_GET_ACTIONS) {
        return {
            error: `ids: at most ${MAX_GET_ACTIONS} actions per call (got ${ids.length}).`,
            _fixHint: 'Split the ids over more calls.',
        };
    }
    const actions = draftWrap?.def?.actions && typeof draftWrap.def.actions === 'object' ? draftWrap.def.actions : {};
    const found: Record<string, unknown> = {};
    const unknownIds: string[] = [];
    const hits = { n: 0 };
    for (const id of ids) {
        if (!Object.hasOwn(actions, id)) { unknownIds.push(id); continue; }
        found[id] = redactSecrets(structuredClone(actions[id]), hits);
    }
    return {
        actions: found,
        ...(unknownIds.length ? { unknownIds, note: 'These ids are not actions of this app; app_get_draft lists the real ones.' } : {}),
        ...(hits.n ? { redacted: hits.n, redactedNote: 'Values that looked like secrets (secret-named keys, URL credentials) were replaced with "[redacted]". Do not write the placeholder back with app_set_action.' } : {}),
    };
}

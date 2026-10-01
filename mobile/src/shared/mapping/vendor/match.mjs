/**
 * Which earlier value goes into which empty input: THE one rule for it.
 *
 * Two writers ask this question. The web builder's auto-map fills a step's
 * empty inputs when it is connected (agent-hub autoMapInputs.ts), and the AI
 * builder binds a required input the model left out (server
 * builderTools/stepBuilders/inputBindings.js). They used to answer it with
 * two rule sets, so the same flow came out bound by hand and refused by the
 * AI. Both now hand their candidates to matchInputs.
 *
 * A candidate is any value a caller can bind, by its last key: a field of an
 * earlier step, a field of the item a repeat reads. matchInputs only matches
 * names; it never decides to repeat a step, and it never builds a binding.
 * The caller turns a match into whatever it writes.
 *
 * Per input, required ones first, the first tier that has a candidate wins:
 *   exact       the same key
 *   normalized  the same key without case and separators (message_id ~ messageId)
 *   id          `<entity>Id` takes an item's own `id`: only with
 *               `idAffinity` (the candidates are the fields of one list
 *               item), and only once
 * Within a tier, the candidate nearest the step wins (highest `near`), then
 * the shallowest (`depth`: a field of the item before a field of an object
 * inside it, so an item's own `id` beats `from.id`), then the earliest
 * (`order`). A type the input's schema rules out never matches. A
 * secret-like input name is left alone when the caller asks (`skipSecrets`).
 */

/** The key compared in the normalized tier: lower case, letters and digits only. */
export function normalizeKey(name) {
    return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The JSON type of a sample value: null, array, string, number, boolean or object. */
export function sampleType(value) {
    if (value === null || value === undefined) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

const SECRET_RE = /(password|passwd|secret|token|apikey|api[_-]?key|credential|client[_-]?secret|private[_-]?key)/i;

/** An input name that holds a credential; never filled by a guess. */
export function isSecretLikeKey(key) {
    return SECRET_RE.test(String(key ?? ''));
}

/**
 * Whether a value of `candType` may go into an input of JSON-schema type
 * `propType`. Permissive when either is unknown, or the sample was empty.
 * A text input takes a number or a yes/no as well.
 * @param {string|string[]|undefined} propType
 * @param {string|undefined} candType — sampleType
 */
export function typeFits(propType, candType) {
    if (!propType || !candType || candType === 'null') return true;
    let pt = propType;
    if (Array.isArray(pt)) pt = pt.find(t => t !== 'null') || pt[0];
    if (pt === 'integer') pt = 'number';
    if (pt === 'string') return candType === 'string' || candType === 'number' || candType === 'boolean';
    return pt === candType;
}

/** `messageId` / `message_id` → 'message'; null when the key does not end in id. */
export function idAffinityBase(key) {
    const m = /^(.+?)_?id$/i.exec(String(key ?? ''));
    return m && m[1] ? m[1] : null;
}

/** Does candidate `a` rank before `b`: nearer, then shallower, then earlier? */
function ranksBefore(a, b) {
    if (a.near !== b.near) return a.near > b.near;
    if (a.depth !== b.depth) return a.depth < b.depth;
    return a.order < b.order;
}

function best(pool) {
    let top = null;
    for (const c of pool) if (!top || ranksBefore(c, top)) top = c;
    return top;
}

/**
 * Match empty inputs to candidates by name.
 *
 * @param {Array<{ key: string, type?: string|string[], required?: boolean }>} inputs
 *   the inputs to fill: only the empty ones (the caller knows what empty is)
 * @param {Array<{ key: string, path: string, type?: string, near?: number, depth?: number }>} candidates
 *   `path` is the caller's; it comes back unchanged. `near`: higher is
 *   closer to the step (default 0). `depth`: how many objects down the
 *   candidate sits in what it comes from (default 0, a top-level field).
 * @param {{ idAffinity?: boolean, unique?: boolean, ambiguous?: boolean, skipSecrets?: boolean, max?: number }} [opts]
 *   idAffinity  the candidates are the fields of one list item (see above)
 *   unique      a candidate is bound once at most; without it a used one is
 *               taken again only when no unused one is left in the tier
 *   ambiguous   two candidates tied in the winning tier (same key, same
 *               `near`, same `depth`) bind nothing and are reported instead
 *   skipSecrets a secret-like input (isSecretLikeKey) is never filled: a
 *               guess the author did not see must not route a credential
 *   max         stop after this many matches
 * @returns {{
 *   matches: Array<{ key: string, path: string, how: 'exact'|'normalized'|'id' }>,
 *   ambiguous: Array<{ key: string, paths: string[] }>,
 * }}
 */
export function matchInputs(inputs, candidates, { idAffinity = false, unique = false, ambiguous = false, skipSecrets = false, max = Infinity } = {}) {
    const matches = [];
    const tied = [];
    const pool = (Array.isArray(candidates) ? candidates : [])
        .filter(c => c && typeof c.key === 'string' && typeof c.path === 'string')
        .map((c, order) => ({
            ...c,
            near: Number.isFinite(c.near) ? c.near : 0,
            depth: Number.isFinite(c.depth) ? c.depth : 0,
            order,
            nkey: normalizeKey(c.key),
        }));
    if (!pool.length) return { matches, ambiguous: tied };
    // Required first, so the most important input wins the nearest
    // candidate (and the item's id); the sort keeps the given order otherwise.
    const wanted = (Array.isArray(inputs) ? inputs : [])
        .filter(i => i && typeof i.key === 'string' && i.key)
        .map((i, n) => ({ ...i, n }))
        .sort((a, b) => (Number(!!b.required) - Number(!!a.required)) || (a.n - b.n));
    const used = new Set();
    let idTaken = false;
    const idField = idAffinity ? best(pool.filter(c => c.key === 'id')) : null;

    for (const input of wanted) {
        if (matches.length >= max) break;
        if (skipSecrets && isSecretLikeKey(input.key)) continue;
        const fits = c => typeFits(input.type, c.type);
        const nkey = normalizeKey(input.key);
        const tiers = [
            ['exact', pool.filter(c => c.key === input.key && fits(c))],
            ['normalized', pool.filter(c => c.nkey === nkey && fits(c))],
        ];
        if (idField && !idTaken && idAffinityBase(input.key)) {
            tiers.push(['id', pool.filter(c => c.key === 'id' && fits(c))]);
        }
        for (const [how, all] of tiers) {
            const unused = all.filter(c => !used.has(c.path));
            const choices = unique ? unused : (unused.length ? unused : all);
            const top = best(choices);
            if (!top) continue;
            if (ambiguous) {
                const peers = choices.filter(c => c.near === top.near && c.depth === top.depth);
                if (peers.length > 1) {
                    tied.push({ key: input.key, paths: peers.map(c => c.path) });
                    break;
                }
            }
            matches.push({ key: input.key, path: top.path, how });
            used.add(top.path);
            if (how === 'id') idTaken = true;
            break;
        }
    }
    return { matches, ambiguous: tied };
}

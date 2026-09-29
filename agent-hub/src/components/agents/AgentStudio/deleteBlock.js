/**
 * What a 409 from DELETE /agents/:id actually says.
 *
 * The server refuses to delete an agent that something still uses, and it
 * refuses just as firmly when it could not FIND OUT whether something uses it.
 * Both come back as one 409, and the difference between them is the whole
 * point: "three routines use this" and "I could not check the routines" lead
 * to the same button but not to the same sentence, and a dialog that merges
 * them tells the person a scan succeeded when it did not.
 *
 * So this reader keeps three things apart:
 *   used        — consumers that were found, per kind, with a count;
 *   unchecked   — kinds whose scan did not answer (K5-style: unknown is not
 *                 "none", and it must never be shown as an empty list);
 *   chat        — how many OTHER people have history with this agent, with
 *                 `null` meaning the count itself was unreadable.
 *
 * The narrow reading wins everywhere. A body that is not an object, a `rows`
 * that is not an array, an `unchecked` that is not an array — each of those is
 * "I know nothing", which reports EVERY kind as unchecked rather than none.
 * That is deliberately the loudest possible answer: the failure mode this
 * guards against is a dialog that quietly reads a broken response as "nothing
 * uses this agent, go ahead".
 *
 * Pure and rendering-free on purpose — the words live in the component, where
 * the i18n guard can see the keys.
 */

// The kinds the server scans, in the order a person reads them. Mirrors
// stores/agent/agentUsage.js KINDS; a kind the server adds later that this
// list does not know still arrives through `rows`/`counts` and is reported
// under its own name rather than dropped.
export const USAGE_KINDS = ['task', 'cowork', 'support', 'automation', 'app', 'webpage'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {unknown} body the parsed 409 body, or anything at all
 * @returns {{
 *   readable: boolean,
 *   used: Array<{kind: string, count: number, foreignOnly: boolean}>,
 *   unchecked: string[],
 *   othersChats: number|null,
 *   chatUnknown: boolean,
 * }}
 */
export function summariseDeleteBlock(body) {
    if (!isObj(body)) {
        // Not "nothing uses it" — nothing was learned. Every kind is unchecked.
        return { readable: false, used: [], unchecked: [...USAGE_KINDS], othersChats: null, chatUnknown: true };
    }

    const rows = Array.isArray(body.rows) ? body.rows : null;
    const counts = isObj(body.counts) ? body.counts : null;

    // A kind counts as USED when either source says so. Counts is the cheaper
    // and more complete of the two (rows can be capped); rows carry whether
    // every hit belonged to somebody else, which decides the wording.
    const perKind = new Map();
    for (const r of rows || []) {
        if (!isObj(r) || typeof r.kind !== 'string' || !r.kind) continue;
        const e = perKind.get(r.kind) || { kind: r.kind, count: 0, foreignOnly: true };
        e.count += 1;
        if (!r.foreign) e.foreignOnly = false;
        perKind.set(r.kind, e);
    }
    for (const [kind, n] of Object.entries(counts || {})) {
        if (!Number.isFinite(n) || n <= 0) continue;
        const e = perKind.get(kind) || { kind, count: 0, foreignOnly: true };
        // Trust the count over the row tally: rows may be truncated.
        e.count = Math.max(e.count, n);
        perKind.set(kind, e);
    }

    // `unchecked` that is not an array is itself an unreadable answer, and the
    // narrow reading of that is "none of it was checked".
    const unchecked = Array.isArray(body.unchecked)
        ? body.unchecked.filter((k) => typeof k === 'string' && k)
        : [...USAGE_KINDS];

    // `chat: null` is the server's own spelling for "the count could not be
    // read". An object without the field is the same thing, not zero.
    const chat = isObj(body.chat) ? body.chat : null;
    const raw = chat ? chat.othersConversationCount : null;
    const chatUnknown = !chat || !Number.isFinite(raw);

    const order = (k) => {
        const i = USAGE_KINDS.indexOf(k);
        return i === -1 ? USAGE_KINDS.length : i;
    };

    return {
        readable: rows !== null || counts !== null,
        used: [...perKind.values()].sort((a, b) => order(a.kind) - order(b.kind) || a.kind.localeCompare(b.kind)),
        unchecked: unchecked.slice().sort((a, b) => order(a) - order(b) || a.localeCompare(b)),
        othersChats: chatUnknown ? null : raw,
        chatUnknown,
    };
}

/**
 * Does this 409 leave anything for the person to weigh, or was it purely a
 * "could not check" refusal? Used to pick the heading — not to decide whether
 * the override is offered. The override is always offered, because the server
 * has already decided this needs a human and hiding the button would leave no
 * path at all.
 */
export function blockHasFindings(summary) {
    return !!summary && (summary.used.length > 0 || (summary.othersChats || 0) > 0);
}

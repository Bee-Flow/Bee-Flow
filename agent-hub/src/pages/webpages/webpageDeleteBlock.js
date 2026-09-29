/**
 * What a 409 from DELETE /api/webpages/:id actually says.
 *
 * The server refuses to delete a page that something still holds, and it
 * refuses just as firmly when it could not FIND OUT whether something holds
 * it. Both come back as one 409, and the difference between them is the whole
 * point: "a Solution contains this page" and "I could not check the agents"
 * lead to the same button but not to the same sentence, and a dialog that
 * merges them tells the person a scan succeeded when it did not.
 *
 * So this reader keeps three things apart:
 *   usage      — what was FOUND, in the row contract shared/UsedByTab renders;
 *   unchecked  — the kinds whose scan did not answer. Unknown is not "none",
 *                and it must never reach the screen as an empty list;
 *   readable   — whether the payload answered at all.
 *
 * The narrow reading wins everywhere. A body that is not an object, a `usage`
 * that is not an array, an `unchecked` that is not an array — each of those is
 * "I know nothing", which reports EVERY kind as unchecked rather than none.
 * That is deliberately the loudest possible answer: the failure this guards
 * against is a dialog quietly reading a broken response as "nothing uses this
 * page, go ahead".
 *
 * Pure and rendering-free on purpose — the words live in the component, where
 * the i18n guard can see the keys. Same split as
 * `components/agents/AgentStudio/deleteBlock.js`, which reads the agent
 * guard's 409; this one reads `usage`, the field name
 * `shared/DangerZone.inUsePayload` knows, rather than that reader's `rows`.
 */

/**
 * The kinds the webpage guard scans, in the order the tab shows them. Mirrors
 * `KINDS` in server/core/webpages/webpageUsage.js. A kind the server adds
 * later still arrives through `unchecked` under its own name; this list is
 * only what an UNREADABLE answer falls back to.
 */
export const DELETE_BLOCK_KINDS = Object.freeze(['solution', 'automation', 'chat', 'agent']);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The `in_use` body out of whatever the caller got: the payload itself, an
 * error wrapping it (`.body`), or a bare 409. Null when this is not the
 * guard speaking — a 500, a network failure, an ordinary success.
 *
 * A 409 whose body is missing or unparseable still counts as the guard: it
 * refused, and refusing with nothing readable is exactly the case that must
 * not be mistaken for a clean list. `inUsePayload` in DangerZone stops at
 * `Array.isArray(usage)` because it only needs rows to render; here the
 * absence of that array is itself the finding.
 */
function blockPayload(x) {
    if (!isObj(x)) return null;
    const refused = x.status === 409
        || x.code === 'in_use'
        || (isObj(x.body) && x.body.code === 'in_use');
    if (!refused) return null;
    // The api client hangs the parsed body on the error and copies `code` up
    // beside it, so the body is the authority whenever there is one; a payload
    // that was resolved rather than thrown IS the body.
    if (isObj(x.body)) return x.body;
    // A 409 whose body would not parse: refused, with nothing readable in it.
    if (x.status === 409) return {};
    return x;
}

/**
 * @param {unknown} x the 409 payload, an error carrying it, or anything at all
 * @returns {{
 *   blocked: boolean,
 *   usage: Array,
 *   unchecked: string[],
 *   readable: boolean,
 * }}
 */
export function readDeleteBlock(x) {
    const body = blockPayload(x);
    // Not the guard: nothing is claimed in either direction. `blocked:false`
    // says only "this response was not a refusal", never "nothing uses it" —
    // the list on screen keeps answering that question.
    if (!body) return { blocked: false, usage: [], unchecked: [], readable: true };

    const usage = Array.isArray(body.usage) ? body.usage.filter(isObj) : null;
    // `unchecked` that is not an array is itself an unreadable answer, and the
    // narrow reading of that is "none of it was checked".
    const unchecked = Array.isArray(body.unchecked)
        ? body.unchecked.filter((k) => typeof k === 'string' && k)
        : [...DELETE_BLOCK_KINDS];

    return {
        blocked: true,
        usage: usage || [],
        unchecked,
        readable: usage !== null,
    };
}

/**
 * Does this refusal leave anything for the person to weigh, or was it purely a
 * "could not check"? Picks the heading — never whether the delete may proceed.
 * That stays the server's call, and the confirmed second press stays offered:
 * the guard has already decided this needs a human, and hiding the button
 * would leave no path at all.
 */
export function blockHasFindings(block) {
    return !!block && block.usage.length > 0;
}

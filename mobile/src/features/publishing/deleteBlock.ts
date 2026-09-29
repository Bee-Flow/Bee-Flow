/**
 * What a 409 from `DELETE /api/webpages/:id` actually says — the Android half.
 *
 * The server refuses to delete a page that something still holds, and it
 * refuses just as firmly when it could not FIND OUT whether something holds it.
 * Both come back as one 409, and the difference is the whole point: "a Solution
 * contains this page" and "I could not check the agents" lead to the same
 * button but not to the same sentence.
 *
 * Today the second case is the NORMAL one. Two of the server's kinds are
 * structurally unanswerable (`chat`, `agent` — see
 * server/core/webpages/webpageUsage.js), so `complete` is never true and the
 * first, unconfirmed DELETE always refuses. A client that only ever sent the
 * bare request could therefore never delete a page at all; a client that always
 * sent `?confirm=1` would skip the check entirely and lose the very guard the
 * refusal exists to provide. Hence the two steps: ask, show the answer, then
 * confirm.
 *
 * The narrow reading wins everywhere. A body that is not an object, a `usage`
 * that is not an array, an `unchecked` that is not an array — each of those is
 * "I know nothing", which reports EVERY kind as unchecked rather than none.
 *
 * Pure and rendering-free on purpose: the words live in the screen. Mirrors
 * `agent-hub/src/pages/webpages/webpageDeleteBlock.js`, so the two clients
 * cannot come to different conclusions about the same refusal.
 */

/**
 * The kinds the webpage guard scans, in the order the web tab shows them.
 * Mirrors `KINDS` in server/core/webpages/webpageUsage.js. A kind the server
 * adds later still arrives through `unchecked` under its own name; this list is
 * only what an UNREADABLE answer falls back to.
 */
export const DELETE_BLOCK_KINDS = ['solution', 'automation', 'chat', 'agent'] as const;

/** One row of the shared used-by contract, as far as this screen reads it. */
export type DeleteBlockRow = {
    kind?: string;
    id?: string;
    title?: string | null;
    role?: string;
};

export type WebpageDeleteBlock = {
    /** Was this a refusal by the guard at all? */
    blocked: boolean;
    /** What was FOUND. Empty is not the same as "nothing uses this". */
    usage: DeleteBlockRow[];
    /** The kinds whose scan did not answer. Never empty on an unreadable body. */
    unchecked: string[];
    /** Did the payload answer at all? */
    readable: boolean;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The `in_use` body out of whatever the caller got: an ApiError carrying it
 * (`.body`), the payload itself, or a bare 409. Null when this is not the guard
 * speaking — a 500, a network failure, an ordinary success.
 *
 * A 409 whose body is missing or unparseable still counts as the guard: it
 * refused, and refusing with nothing readable is exactly the case that must not
 * be mistaken for a clean list.
 */
function blockPayload(x: unknown): Record<string, unknown> | null {
    if (!isObj(x)) return null;
    const refused =
        x.status === 409 ||
        x.code === 'in_use' ||
        (isObj(x.body) && x.body.code === 'in_use');
    if (!refused) return null;
    if (isObj(x.body)) return x.body;
    if (x.status === 409) return {};
    return x;
}

export function readDeleteBlock(x: unknown): WebpageDeleteBlock {
    const body = blockPayload(x);
    // Not the guard: nothing is claimed in either direction.
    if (!body) return { blocked: false, usage: [], unchecked: [], readable: true };

    const usage = Array.isArray(body.usage) ? (body.usage as unknown[]).filter(isObj) : null;
    const unchecked = Array.isArray(body.unchecked)
        ? (body.unchecked as unknown[]).filter((k): k is string => typeof k === 'string' && !!k)
        : [...DELETE_BLOCK_KINDS];

    return {
        blocked: true,
        usage: (usage as DeleteBlockRow[]) || [],
        unchecked,
        readable: usage !== null,
    };
}

/** Plural-aware English noun per kind, for the sentence on the sheet. */
const KIND_NOUNS: Record<string, [string, string]> = {
    solution: ['solution', 'solutions'],
    automation: ['routine', 'routines'],
    chat: ['chat', 'chats'],
    agent: ['agent', 'agents'],
    webpage: ['webpage', 'webpages'],
    datatable: ['table', 'tables'],
    kb: ['knowledge base', 'knowledge bases'],
};

/**
 * An unknown kind keeps its OWN name rather than becoming "items": the server's
 * list is open, and "Could not be checked: items" reads as "something
 * unnameable" instead of naming the thing.
 */
export function kindNoun(kind: string, n = 1): string {
    const pair = KIND_NOUNS[kind];
    if (!pair) return kind;
    return n === 1 ? pair[0] : pair[1];
}

/**
 * The sentence under the second sheet's title: what was found, what could not
 * be checked, and — when neither answered — that the check itself did not run.
 *
 * Deliberately says "not announced and not undone" the way the web dialog does:
 * whoever is about to press a red button is owed it.
 */
export function describeDeleteBlock(block: WebpageDeleteBlock): string {
    const parts: string[] = [];
    if (block.usage.length > 0) {
        const named = block.usage
            .map((r) => r.title || kindNoun(String(r.kind || 'other')))
            .slice(0, 5);
        parts.push(
            block.usage.length === 1
                ? `One thing uses this page and will start failing: ${named[0]}.`
                : `${block.usage.length} things use this page and will start failing: ${named.join(', ')}${block.usage.length > named.length ? ', …' : ''}.`,
        );
    } else if (block.readable) {
        parts.push('Nothing was found that uses this page.');
    } else {
        parts.push('The check did not answer at all, so nothing here is a complete list.');
    }
    if (block.unchecked.length > 0) {
        parts.push(
            `Could not be checked: ${block.unchecked.map((k) => kindNoun(k, 2)).join(', ')}. Treat this as incomplete, not as “nothing uses this page”.`,
        );
    }
    parts.push('Deleting is not announced and not undone.');
    return parts.join(' ');
}

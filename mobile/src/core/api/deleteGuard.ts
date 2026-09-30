/**
 * The server's "still in use" delete guard, read once for every resource.
 *
 * Four DELETE routes now refuse the first, unconfirmed request with the same
 * `409 {error, code: 'in_use', usage, unchecked}` body:
 *
 *   webpages        server/routes/webpages/lifecycle.js
 *   recordings      server/routes/transcriptions/noteActions.js
 *   knowledge bases server/routes/knowledgeBases/detail.js
 *   skills          server/routes/skills.js
 *
 * `usage` is what the scan FOUND; `unchecked` names the kinds it could not
 * answer for. Recordings and knowledge bases refuse on `unchecked` alone, and
 * for recordings that is every request today: the notebook scan needs a column
 * that is never created, so a phone that only sent the bare DELETE could not
 * remove a single meeting. Sending the confirmation up front is the opposite
 * mistake — it skips the check the refusal exists for. So: ask, show the
 * answer, then confirm.
 *
 * The body shape is shared; what differs per route is the confirmation (the
 * servers validate their query strictly, so the wrong spelling is a 400) and
 * the list of kinds an UNREADABLE answer falls back to. The narrow reading
 * wins everywhere: a body that is not an object, or a `usage`/`unchecked` that
 * is not an array, reports every kind as unchecked rather than none.
 *
 * Rendering-free on purpose — the words live in ui/GuardedDeleteSheet.tsx.
 */

import { api, type QueryParams } from './client';

export type GuardedResource = 'webpage' | 'recording' | 'knowledgeBase' | 'skill';

/**
 * The kinds each guard scans, as the server lists them. Only what an
 * unreadable answer falls back to: a kind the server adds later still arrives
 * through `unchecked` under its own name.
 */
export const GUARD_KINDS: Record<GuardedResource, readonly string[]> = {
    // server/core/webpages/webpageUsage.js KINDS
    webpage: ['solution', 'automation', 'chat', 'agent'],
    // server/core/meetingNotes/meetingUsage.js KINDS
    recording: ['kb', 'automation', 'notebook'],
    // server/core/kb/kbUsage.js KINDS
    knowledgeBase: ['agent', 'automation', 'app', 'webpage', 'project', 'notebook', 'template', 'support'],
    // server/stores/skillStore.js listSkillUsage
    skill: ['agent', 'automation'],
};

/**
 * What gets past each guard. Skills are the odd one out: their DeleteQuery
 * accepts only `confirmBreaking` = 'true' | 'false', so `confirm=1` there is a
 * 400, not a confirmation.
 */
const CONFIRM_QUERY: Record<GuardedResource, QueryParams> = {
    webpage: { confirm: '1' },
    recording: { confirm: '1' },
    knowledgeBase: { confirm: '1' },
    skill: { confirmBreaking: 'true' },
};

/** One row of the shared used-by contract, as far as the phone reads it. */
export type DeleteGuardRow = {
    kind?: string;
    id?: string;
    /** Null on a row owned by someone else (redactForeign) — never guessed at. */
    title?: string | null;
    role?: string;
    foreign?: boolean;
    /**
     * Where inside the user it applies — "step 3" for a routine step, a tag
     * filter for a meeting source. The server sends one row PER site, so one
     * routine can come back twice; this is what tells the two apart. Absent on
     * a foreign row.
     */
    siteLabel?: string | null;
    stepId?: string | null;
};

export type DeleteGuard = {
    /** Was this a refusal by the guard at all? */
    blocked: boolean;
    /** What was FOUND. Empty is not the same as "nothing uses this". */
    usage: DeleteGuardRow[];
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

export function readDeleteGuard(x: unknown, resource: GuardedResource): DeleteGuard {
    const body = blockPayload(x);
    // Not the guard: nothing is claimed in either direction.
    if (!body) return { blocked: false, usage: [], unchecked: [], readable: true };

    const usage = Array.isArray(body.usage) ? (body.usage as unknown[]).filter(isObj) : null;
    const unchecked = Array.isArray(body.unchecked)
        ? (body.unchecked as unknown[]).filter((k): k is string => typeof k === 'string' && !!k)
        : [...GUARD_KINDS[resource]];

    return {
        blocked: true,
        usage: (usage as DeleteGuardRow[]) || [],
        unchecked,
        readable: usage !== null,
    };
}

/**
 * The DELETE itself. `confirmed` is the second press, sent only after the
 * guard's answer was shown — never on the first request.
 */
export async function guardedDelete(
    path: string,
    resource: GuardedResource,
    confirmed = false,
): Promise<void> {
    await api.delete(path, confirmed ? { query: CONFIRM_QUERY[resource] } : undefined);
}

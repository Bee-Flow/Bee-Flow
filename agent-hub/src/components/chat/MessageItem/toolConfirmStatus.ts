/**
 * The status of ONE held call: ONE reading, for the card AND the trail.
 *
 * `tool_confirm` says that the agent wanted to do something and did not do it.
 * Afterwards a decision can come in from two sides:
 *
 *   SERVER   a new `tool_confirm` with `status: 'approved'|'declined'`. The
 *            turn has then already passed that call, so approved means that it
 *            HAS RUN.
 *   SESSION  the click of this user on the card, not yet sent. The decision
 *            travels with the NEXT message, and the call runs only when the
 *            model proposes it again. Approved here means "will run", not
 *            "has run".
 *
 * Those two were conflated in the UI. The card said "You approved this, it ran"
 * as soon as one had clicked, while nothing had happened yet. Hence this file
 * returns not only the STATUS but also WHO set it. A panel that claims something
 * has run while it is still waiting is exactly the reassurance that a test chat
 * should find, not produce.
 *
 * ── UNKNOWN NARROWS, AND NARROWING HERE IS NOT 'PENDING' ────────────────
 *
 * A status we do not know may not become 'pending'. 'pending' is itself a CLAIM
 * ("this has not run"), and we cannot make that claim for an unknown status. So
 * there is a fourth status, `unknown`, and it says exactly that: we do not know.
 * No buttons, no green, no "it is still open".
 *
 * Pure: no React, no t(), no DOM.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/chat/MessageItem/toolConfirmStatus.test.js
 */

/** De gesloten lijst. Alles daarbuiten is `unknown`, nooit iets geruststellends. */
export const CONFIRM_STATUSES = Object.freeze(['pending', 'approved', 'declined', 'unknown']);

/** Who set the status: the server (it has happened) or this session (it is going to happen). */
export const DECISION_SOURCES = Object.freeze(['server', 'session']);

/** A pending tool call, as far as the confirmation status reads it. */
export interface ConfirmCall {
    status?: string;
    callId?: string;
    argsKey?: string;
}

/** What this session decided, by call id or args key. */
export type ConfirmBook = Record<string, string>;

/**
 * Status and provenance of one held call.
 *
 * ── THE SESSION NOTE HANGS ON THE CARD, NOT ON THE ACTION ───────────
 *
 * `decided` is read preferably by `callId`, and only then by `argsKey`.
 * That is no detail. `argsKey` is name-plus-arguments and therefore the same for
 * every card of the same action, whereas `callId` is new per round.
 * Reading by argsKey let a card in turn 5 say "You declined this" on a click from
 * turn 2, including removing the buttons with which you could have revised it.
 * The click is a fact about ONE card. A new card for the same action is a new
 * question.
 *
 * @param {object} call     one row from `msg.pendingToolCalls`
 * @param {object} [decided] { [callId or argsKey]: 'approve'|'decline' }: what
 *                           was clicked in this session
 * @returns {{status: string, by: string|null}} `by` is null as long as nothing
 *          has been decided (status 'pending') or nobody knows it ('unknown').
 */
export function confirmDecisionOf(call: ConfirmCall | null | undefined, decided: ConfirmBook | null | undefined = {}) {
    if (!call || typeof call !== 'object') return { status: 'unknown', by: null };

    // De server heeft het laatste woord: hij weet of de call gedraaid heeft.
    const served = call.status;
    if (served && served !== 'pending') {
        return CONFIRM_STATUSES.includes(served)
            ? { status: served, by: served === 'unknown' ? null : 'server' }
            : { status: 'unknown', by: null };
    }

    const book = decided && typeof decided === 'object' ? decided : null;
    const callKey = typeof call.callId === 'string' && call.callId ? call.callId : null;
    const argsKey = typeof call.argsKey === 'string' && call.argsKey ? call.argsKey : null;
    // callId first, see the heading. argsKey stays as fallback for a card without a
    // callId, and for the caller that still keeps accounts by argsKey.
    const mine = book
        ? (callKey && book[callKey] !== undefined ? book[callKey] : (argsKey ? book[argsKey] : null))
        : null;
    if (mine === 'approve') return { status: 'approved', by: 'session' };
    if (mine === 'decline') return { status: 'declined', by: 'session' };
    return { status: 'pending', by: null };
}

/** Only the status, for whoever does not need the provenance. */
export function confirmStatusOf(call: ConfirmCall | null | undefined, decided: ConfirmBook | null | undefined = {}) {
    return confirmDecisionOf(call, decided).status;
}

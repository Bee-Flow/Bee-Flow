// @typecheck strict
/**
 * versionFacts — what happened in ONE edit of a web page, mechanically
 * derived, plus who made it.
 *
 * ── WHY THIS IS A MODULE OF ITS OWN ─────────────────────────────────────────
 *
 * The row in the history list is written in three places — the manual save (routes/webpages.js, PUT /:id), the AI turn
 * (routes/ai/webpageChat.js) and the restore (POST /:id/versions/:vid/
 * restore) — and read in one place (GET /:id/versions). Without a shared
 * module there would be three ways to calculate "how many lines" and "what is this called", and then the list
 * would speak different languages about the same event.
 *
 * Everything here is PURE: no database, no storage, no require of a store.
 * The route supplies the facts (the bytes, the names); this module decides what
 * to make of them. That makes it testable without a harness.
 *
 * ── THE RULE THAT THIS MODULE PROTECTS ──────────────────────────────────────
 *
 * UNKNOWN IS NOT ZERO AND NOT YOU.
 *
 *   - A line difference that we could not measure is `null`, never 0. "Nothing
 *     changed" is a statement; "we did not look" is not one.
 *   - An `actor_user_id` that cannot be read (never recorded, or an account that
 *     no longer exists) yields an author that is UNKNOWN. Never the reader
 *     himself — that would have the history make a claim about who did
 *     something, on the basis of nothing.
 *
 * ── THE SUMMARY IS DERIVED, NEVER READ ─────────────────────────────────────
 *
 * The one-line summary of an AI turn comes from WHAT HAPPENED (which
 * slots the tools wrote), not from the prose of the model. The same
 * rule that agent-hub/src/pages/webpages/webpageTurnFacts.js already observes on the
 * client side: the model does not always describe its own work correctly, the tool history does.
 */

'use strict';

/**
 * The three slots with the names that apply everywhere in the product. The same
 * names as agent-hub/src/pages/webpages/webpageCodeFiles.PRIMARY_SLOTS and as the
 * keys of stores/webpage/shared.js — needed here because the summary must name a
 * FILE NAME and not a slot letter.
 */
/** @type {Readonly<Record<string, string>>} */
const SLOT_FILES = Object.freeze({
    html: 'index.html',
    css: 'style.css',
    js: 'script.js',
});

/** The fixed summary of a manual edit in the Code tab. */
const MANUAL_EDIT_SUMMARY = 'Edited in code';

/**
 * Number of lines in a text.
 *
 * Not `text.split('\n').length`: that counts a trailing newline as an
 * extra empty line, so that "a\n" would be two lines and every edit that
 * only adds the closing newline would yield +1.
 *
 * An empty text has 0 lines — an empty file is not one empty line.
 * @param {unknown} text
 */
function countLines(text) {
    if (typeof text !== 'string' || text === '') return 0;
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return text.charCodeAt(text.length - 1) === 10 ? n : n + 1;
}

/**
 * The NET line difference between two versions of the same text.
 *
 * Gives `null` as soon as one of the two sides has no text — then nothing has been
 * measured and no number may arise.
 * @param {unknown} before
 * @param {unknown} after
 */
function lineDelta(before, after) {
    if (typeof before !== 'string' || typeof after !== 'string') return null;
    return countLines(after) - countLines(before);
}

/**
 * The net line difference over a collection of slots.
 *
 * `before` and `after` are objects with slot keys ({ html, css, js }).
 * Slots of which one of the two sides is missing do not count — but if
 * because of that NOTHING measurable remains, the outcome is `null` and not 0.
 * @param {Record<string, unknown> | null | undefined} before
 * @param {Record<string, unknown> | null | undefined} after
 * @param {Iterable<string> | null | undefined} slots
 */
function slotsLineDelta(before, after, slots) {
    const list = Array.from(slots || []);
    let total = 0;
    let measured = 0;
    for (const slot of list) {
        const d = lineDelta(before?.[slot], after?.[slot]);
        if (d === null) continue;
        total += d;
        measured++;
    }
    return measured === 0 ? null : total;
}

/**
 * `index.html`, `index.html and style.css`, `a, b and c`.
 * @param {string[]} names
 */
function joinFileNames(names) {
    const list = names.filter(Boolean);
    if (list.length === 0) return '';
    if (list.length === 1) return list[0];
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * The one-line summary of one AI turn.
 *
 * Slots are named in the fixed order html → css → js, not in the
 * order in which the tools happened to fire: two identical turns
 * should yield the same line.
 *
 * A turn without a recognizable slot falls back to 'AI edit' — the text that these
 * rows all carried before W4. That is not a nice summary, but it is the honest one:
 * we only know THAT the AI did something.
 * @param {Iterable<string> | null | undefined} slots
 */
function aiTurnSummary(slots) {
    const known = Object.keys(SLOT_FILES).filter(slot => Array.from(slots || []).includes(slot));
    if (known.length === 0) return 'AI edit';
    return `AI edited ${joinFileNames(known.map(s => SLOT_FILES[s]))}`;
}

/**
 * The summary of the snapshot that a RESTORE makes.
 *
 * The row contains the state from BEFORE the restore — restoring it makes the restore undone. The text says that
 * literally, instead of "Restored v12", which on a row with the old content reads exactly the other way round.
 * @param {number} seq
 */
function restoreSummary(seq) {
    return Number.isFinite(seq) && seq > 0
        ? `Before restoring v${seq}`
        : 'Before restoring an earlier version';
}

/**
 * Who made the version, as the history list may show it.
 *
 * @param {string|null} actorUserId  the column value
 * @param {object} [opts]
 * @param {string|null} [opts.viewerId]  who is looking (for `isYou`)
 * @param {Map<any, any>|Record<string, any>|null} [opts.names] id → display name, looked up by the
 *        route. An id that is not in it is an account that can no longer be
 *        read.
 * @returns {null | { id: string, name: string|null, isYou: boolean }}
 *          `null` = never recorded. `name: null` = recorded but not
 *          readable. The UI draws both as "unknown"; the distinction is kept
 *          because only the second case has a trail to follow.
 */
function actorOf(actorUserId, { viewerId = null, names = null } = {}) {
    const id = typeof actorUserId === 'string' && actorUserId.trim() ? actorUserId.trim() : null;
    if (!id) return null;
    /** @type {string | null} */
    let name = null;
    if (names && typeof names.get === 'function') name = names.get(id);
    else if (names && typeof names === 'object') name = /** @type {Record<string, string>} */ (names)[id];
    return {
        id,
        name: (typeof name === 'string' && name.trim()) ? name.trim() : null,
        // On the ID, not on the name: two colleagues may carry
        // the same display name without the one inheriting the work of the other.
        isYou: !!viewerId && id === viewerId,
    };
}

module.exports = {
    SLOT_FILES,
    MANUAL_EDIT_SUMMARY,
    countLines,
    lineDelta,
    slotsLineDelta,
    joinFileNames,
    aiTurnSummary,
    restoreSummary,
    actorOf,
};

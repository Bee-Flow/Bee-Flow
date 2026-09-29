/**
 * The wire contract of /api/playbooks: the error envelope every refusal is
 * shaped in, the body guard, the language a NEW request builds in, and the
 * limits and closed vocabularies a request body is measured against.
 *
 * They live together because they are one thing — what this router accepts
 * and what it answers — and apart from the routes because every route group
 * is measured against the same numbers.
 */

'use strict';

const { z } = require('zod');
const { normaliseLocale } = require('../../playbooks/copy');
const { MAX_BRIEF_CHARS } = require('../../playbooks/recipeDoc');
const { MAX_DESIGN_BRIEF_CHARS } = require('../../playbooks/phases/designPhase');

const MAX_DESCRIPTION = 2000;
const MAX_TITLE = 120;
const MAX_FOLDER = 300;
const MAX_FEEDBACK = 800;  // what a person asks the designer to change
// Derived, never guessed: a rendered brief plus the design block appended to it
// plus room to edit. The literal 3000 sat beside a comment claiming 1000 + 1600
// while the real caps were 1200 + 1800 = 3002, so editing ONE character of a
// maximum-length app brief in the handoff card was refused 400.
const MAX_BRIEF = MAX_BRIEF_CHARS + MAX_DESIGN_BRIEF_CHARS + 600;
const TABLE_MODES = new Set(['new', 'existing']);
// The depth axis the dialog offers (licensing/tierMeta DEPTH_TIER_KEYS), plus
// `standard`: which of them a given person may pick is decided there against
// /ai/config/tiers-for-user; this set only keeps an unknown string out of the
// builder's `modelTier`. `pro` and `deep_thinking` are the same tier.
const TIERS = new Set(['fast', 'auto', 'standard', 'thinking', 'pro', 'deep_thinking']);
const CLIENT_STATUSES = new Set(['running', 'awaiting', 'failed', 'done']);

/**
 * The language a NEW request builds in. English when the caller says nothing:
 * a missing locale used to mean Dutch, so anything that dropped it on the way
 * — an older client, a script, a proxy that strips a body field — silently
 * produced a Dutch demo under an English screen. A playbook ALREADY on file
 * keeps its own locale (localeOf → copyFor, Dutch for the rows written before
 * there was one).
 */
function localeOfRequest(value) {
    return normaliseLocale(value, 'en');
}

function sendErr(res, status, code, error, extra = {}) {
    return res.status(status).json({ error, code, ...extra });
}

// -- What a caller may send, and how this router says no --------------
//
// Every refusal here travels in THIS router's own envelope -- `{ error, code,
// … }` -- and the Studio reads the code: `usePlaybook` counts a
// `version_conflict`, and the new-playbook dialog shows the server's own
// sentence for `bad_options` and `recipe_invalid` and a generic line for
// anything else. So the schemas below are PARSED rather than mounted as
// `core/http/validate`: mounting it would answer `invalid_request` and turn
// every one of those messages into "Check the options."
//
// `check` is that parse. It gives back the parsed value, or sends the refusal
// under the code the route has always used and returns `{ ok: false }`.

// `worded` and the unknown-key sentence are shared with every other route
// schema (core/http/schemaParts.js), so a refusal reads the same everywhere.
const { worded, unknownKeysText } = require('../../core/http/schemaParts');

/** An object that refuses a key it does not know, in a sentence naming what `subject` does take. */
const closedObject = (shape, subject = 'This request') => {
    const known = Object.keys(shape);
    const errorMap = (issue, ctx) => (issue.code === 'unrecognized_keys'
        ? { message: unknownKeysText(issue.keys, known, subject) }
        : { message: ctx.defaultError });
    return z.object(shape, { errorMap }).strict();
};

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), closedObject(shape));

const LOCALE_TEXT = 'locale is a language code, like "nl" or "en".';
/**
 * The interface language. `normaliseLocale` answers anything it cannot read
 * with English, and the language a playbook is built in has now been wrong
 * twice for exactly that reason (see localeOfRequest below). A code that is
 * not a code is named instead of quietly becoming English.
 */
const localeCode = () => worded(LOCALE_TEXT).trim().regex(/^[A-Za-z]{2}([-_][A-Za-z0-9]{2,8})*$/, LOCALE_TEXT);

const TIER_TEXT = `tier is one of: ${[...TIERS].join(', ')}.`;
const tierName = () => worded(TIER_TEXT).trim().refine((v) => TIERS.has(v), TIER_TEXT);

// `tierName` says a tier is A tier. Whether it is one THIS person may use is
// asked per request of their own list (phaseFlow.tierFor, over
// core/entitlements/tierAccess), because the answer depends on who is asking.

const VERSION_TEXT = 'expectedVersion is the version this playbook had when you read it.';
/**
 * The optimistic lock. It was read as `Number(req.body?.expectedVersion)` and
 * then checked only `if (Number.isInteger(…))`, so a value that is not a
 * number -- `'abc'`, `null`, an object -- SKIPPED THE CHECK ENTIRELY and the
 * phase moved on top of whatever somebody else had just written.
 *
 * And it is a whole NUMBER, not whatever coerces to one: `z.coerce.number()`
 * read `[3]` and `'3'` as 3, `true` as 1 and `null` as 0, so an array or a
 * boolean passed the lock whenever it happened to coerce to the version.
 * Every client sends the number it read from the playbook's JSON
 * (usePlaybook/phaseMachine, scripts/drive-playbook.js; mobile has none).
 */
const expectedVersion = () => z.number({ required_error: VERSION_TEXT, invalid_type_error: VERSION_TEXT })
    .int(VERSION_TEXT).optional();

/**
 * Parse `value` against `schema`, or answer with this router's own envelope.
 * Returns `{ ok: true, value }` or `{ ok: false }` -- the caller returns on
 * the second, exactly the way it returns after a `sendErr`.
 *
 * A misspelled required field fails twice: as missing, and as a key the body
 * does not take. The second is what happened, so it is the sentence the
 * refusal leads with -- `{ mesage: … }` answered "Say who should use this
 * app.", as though the person had typed nothing.
 */
function check(res, schema, value, code, part = 'body') {
    const parsed = schema.safeParse(value);
    if (parsed.success) return { ok: true, value: parsed.data };
    const errors = parsed.error.issues.map((i) => ({ path: [part, ...i.path].join('.'), message: i.message }));
    const unknownKey = parsed.error.issues.findIndex((i) => i.code === 'unrecognized_keys');
    sendErr(res, 400, code, errors[unknownKey === -1 ? 0 : unknownKey].message, { errors });
    return { ok: false };
}

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

module.exports = {
    z,
    worded,
    closedObject,
    bodyOf,
    localeCode,
    tierName,
    expectedVersion,
    check,
    MAX_DESCRIPTION,
    MAX_TITLE,
    MAX_FOLDER,
    MAX_FEEDBACK,
    MAX_BRIEF,
    TABLE_MODES,
    TIERS,
    CLIENT_STATUSES,
    localeOfRequest,
    sendErr,
    isObject,
};

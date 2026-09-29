/**
 * The zod vocabulary this router's request schemas are built from.
 *
 * Every body below is `.strict()`, and on this surface that is the whole
 * point. A datatable descriptor is a closed contract — the router's own header
 * says so about SQL — and the same rule has to hold for the plain settings: a
 * key nobody reads used to be dropped under a 200, which is a setting the
 * person believes they saved.
 *
 * Three traps are closed here once so no route re-opens them:
 *
 *   • `worded()` — zod answers a missing field with the bare word "Required"
 *     unless it is given a `required_error`, and no caller should ever read
 *     that.
 *   • enums — `invalid_type_error` covers a wrong TYPE only, never a wrong
 *     VALUE, so every enum here carries an `errorMap` instead. See the header
 *     of core/http/validate.js.
 *   • `flag()` — the query-string "yes". `confirmedBreaking` used to accept
 *     the literal string 'true' and nothing else, so the ONE surface that
 *     sends `?confirmBreaking=1` could never confirm anything.
 */

'use strict';

const { z } = require('zod');
const dataModel = require('../../core/dataEngine/dataModel/vocabulary');

/** A string whose every refusal — including "you left it out" — is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape).strict(),
);

/** An enum whose refusal is one sentence, for a wrong value as much as a wrong type. */
const choice = (values, message) => z.enum(values, { errorMap: () => ({ message }) });

/**
 * A "yes" on the query string.
 *
 * A URL carries no booleans, so both spellings a client actually sends are
 * accepted — and anything else is REFUSED rather than read as "no". A
 * confirmation that silently fails to confirm is worse than one that is
 * missing: the person clicked the button and the server disagreed in silence.
 */
const flag = (message) => choice(['true', '1', 'false', '0'], message)
    .transform((v) => v === 'true' || v === '1')
    .optional();

const KEY_TEXT = 'A table key may use lowercase letters, numbers and underscores';
const NAME_TEXT = 'Give the table a name';
const PURPOSE_TEXT = 'Say what this table is for — it goes in your processing record';

/** The technical name of one physical Postgres table. */
const tableKey = () => worded(KEY_TEXT).trim().regex(dataModel.KEY_RE, KEY_TEXT);

/** The label on screen. */
const tableName = () => worded(NAME_TEXT).trim().min(1, NAME_TEXT)
    .max(dataModel.DATA_LIMITS.MAX_NAME_LEN, `A name may be at most ${dataModel.DATA_LIMITS.MAX_NAME_LEN} characters`);

/** The Art. 30 purpose. Never blank — the generated register would record nothing. */
const tablePurpose = () => worded(PURPOSE_TEXT).trim().min(1, PURPOSE_TEXT);

/**
 * Which tenancy a NEW table goes in. A word, not a flag: 'organisation' and
 * 'personal' are the only two placements, and a third spelling must not be
 * read as either of them.
 *
 * Typed here but NOT enumerated here, deliberately. The WORD is judged in the
 * handler, which answers `code: 'bad_scope'` — a code the Studio's create
 * dialog branches on to show a translated sentence (NewDatatableDialog.
 * messageFor). An enum would move that refusal to the generic
 * `invalid_request` and drop the person from their own language into the
 * server's. The schema's job here is the type and, through `.strict()`, the
 * misspelled KEY.
 */
const SCOPE_TEXT = 'A table belongs either to your organisation or to this account';
const SCOPE_WORDS = Object.freeze(['organisation', 'personal']);
const scopeWord = () => worded(SCOPE_TEXT).trim().min(1, SCOPE_TEXT).optional();

/**
 * Who sees which rows.
 *
 * 'all' or 'own', and nothing else: the store writes `rowScope === 'own' ? 'own'
 * : 'all'` and auth/datatableAccess reads it the same way, so ANY other
 * spelling used to mean "everyone with access sees every row" — under a 200
 * that reported the table as created.
 */
const ROW_SCOPE_TEXT = 'Rows are visible to everyone with access, or only to whoever added them';
const rowScopeWord = () => choice(['all', 'own'], ROW_SCOPE_TEXT);

/** A field a route only carries through: an id minted elsewhere. */
const idText = (message) => worded(message).trim().min(1, message);

/**
 * `?confirmBreaking=` — the query string every destructive route reads.
 *
 * `.strict()` and nothing else on the query: a confirmation is the only thing
 * these routes take from the URL, and `?confirmbreaking=1` (lower case b) used
 * to be dropped, which reads as "no" on exactly the request where "no" is the
 * expensive answer.
 */
const CONFIRM_TEXT = 'confirmBreaking is true or false.';
const ConfirmBreakingQuery = z.object({ confirmBreaking: flag(CONFIRM_TEXT) }).strict();

module.exports = {
    worded, bodyOf, choice, flag,
    tableKey, tableName, tablePurpose, scopeWord, SCOPE_WORDS, rowScopeWord, idText,
    ConfirmBreakingQuery,
    KEY_TEXT, NAME_TEXT, PURPOSE_TEXT, SCOPE_TEXT, ROW_SCOPE_TEXT, CONFIRM_TEXT,
};

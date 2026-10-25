// @typecheck strict
/**
 * The request-body pieces the meeting-notes settings routes share
 * (gmeetNotesSettings.js, teamsNotesSettings.js): a strict body that also
 * accepts no body, the on/off-or-no-opinion flag, and the fields every
 * provider has. Why the body is strict is explained in gmeetNotesSettings.js.
 */

const { z, typeError } = require('../utils/zod');

/**
 * A body that also accepts no body: Express 5 leaves `req.body` undefined then.
 * @template {import('zod').ZodRawShape} T
 * @param {T} shape
 */
const bodyOf = (shape) => z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object(shape, { error: typeError({ invalid: 'Send the settings as a JSON object.' }) }).strict(),
);

/** @param {string} name */
const onOff = (name) => z.boolean({ error: typeError({ invalid: `${name} is true, false, or null for no opinion.` }) })
    .nullable().optional();

const LANGUAGE_TEXT = 'language is a language code, like nl or en.';

/** The two switches and the lookback every provider's settings document carries. */
const toggleFields = {
    autoImport: onOff('autoImport'),
    autoRecordConfig: onOff('autoRecordConfig'),
};
const lookbackHoursField = z.number({ error: typeError({ invalid: 'lookbackHours is a number of hours.' }) }).nullable().optional();

module.exports = { bodyOf, onOff, LANGUAGE_TEXT, toggleFields, lookbackHoursField };

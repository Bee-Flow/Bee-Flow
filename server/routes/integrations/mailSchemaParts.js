// @typecheck strict
/**
 * The request-body pieces the two mail integrations share (gmail.js,
 * outlook.js): the draft's recipient fields and the whole-number list size.
 * Each route keeps its own provider-specific keys (thread ids, Graph ids).
 */

const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

/**
 * @param {string} name
 * @param {string} what
 */
const required = (name, what) => worded(`${name} is required — ${what}.`).trim().min(1, `${name} is required — ${what}.`);

/** @param {string} name */
const optionalText = (name) => worded(`${name} must be text.`).nullish();

/** to / subject / body / cc / bcc: the keys an approval card's draft always carries. */
const draftFields = {
    to: required('to', 'who the message goes to'),
    subject: required('subject', 'what the message is about'),
    body: required('body', 'the message itself'),
    cc: optionalText('cc'),
    bcc: optionalText('bcc'),
};

/** A page size or top: a whole number of at least 1 (the route clamps the ceiling). */
const listSize = (/** @type {string} */ name) => z.coerce.number({ error: typeError({ invalid: `${name} must be a number.` }) })
    .int(`${name} must be a whole number.`)
    .min(1, `${name} must be at least 1.`)
    .optional();

module.exports = { required, optionalText, draftFields, listSize };

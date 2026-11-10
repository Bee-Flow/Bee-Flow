// @typecheck strict
/**
 * Top-level key `format` (schema 3): how the whole app writes numbers, amounts and dates.
 *
 *   { language?, currency?, currencyDecimals?, dateFormat?, timeZone? }
 *
 * Every key is optional and none is filled in: an app without `format` (every app made before
 * it) writes values exactly as before, and a key that is left out keeps the old choice for
 * what it names. The cleaner and the formatter are one shared module
 * (server/shared/format/, generated to agent-hub/src/shared/format/), so the canvas, a public
 * page and this check agree. Public: an anonymous visitor's page formats like the app.
 */

'use strict';

const { cleanAppFormat, shapeProblems } = require('../../shared/format/formatClean.mjs');

module.exports = {
    key: 'format',
    since: 3,
    public: true,
    shape: '{ language?: "en-US", currency?: "USD", currencyDecimals?: 0..10, dateFormat?: "short"|"medium"|"long"|"full"|"<pattern>", timeZone?: "Europe/Amsterdam" }',
    description: 'How the app writes numbers, amounts and dates for its readers. '
        + 'Set only what should differ: an absent key keeps the default (the reader\'s own browser language, amounts in EUR without decimals, the reader\'s clock). '
        + 'language is a BCP 47 tag and picks separators, month names and the date order. '
        + 'currency (ISO 4217, e.g. "USD") and currencyDecimals apply to every `currency` column, chart axis and stat that does not name its own. '
        + 'dateFormat is a style word or a pattern built from yyyy yy MMMM MMM MM M dd d EEEE EEE HH H hh h mm ss a (literal letters in single quotes, e.g. "d MMM yyyy"); a datetime adds HH:mm after a pattern. '
        + 'timeZone (IANA, e.g. "Europe/Amsterdam") is the clock every moment is shown on; a plain calendar date (YYYY-MM-DD) never moves. '
        + 'One column, chart or stat overrides it with its own formatOptions. '
        + 'Translating the app\'s own texts is not part of this key. '
        + 'No builder tool writes this key yet (the editor\'s Value format section in app settings does); formatOptions are written with app_add_components and app_update_component.',
    /**
     * @param {unknown} value
     * @param {(code: string, path: string, message: string) => void} push
     */
    canon(value, push) {
        return cleanAppFormat(value, push, 'format');
    },
    /**
     * @param {unknown} value
     * @param {{ pushE: (f: { code: string, severity: string, path: string, message: string, hint?: string }) => void }} ctx
     */
    validate(value, { pushE }) {
        for (const problem of shapeProblems(value, cleanAppFormat, 'format')) {
            pushE({
                code: 'format.invalid', severity: 'error', path: problem.path, message: problem.message,
                hint: 'Run the definition through canonicalize: it drops what cannot be used.',
            });
        }
    },
};

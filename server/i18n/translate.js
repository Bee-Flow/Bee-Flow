// @typecheck
/**
 * Server-side translation of one catalogue key: the English defaults
 * (i18n/defaults/en) overlaid with the stored translations of the locale
 * (the add-nl-* migrations fill those), `{var}` substituted, English when the
 * locale has no value. Used where the server itself writes a sentence a person
 * reads (a bell notification), in the recipient's language.
 */

'use strict';

/** 'nl-NL' / 'NL_nl' -> 'nl'; anything unusable -> 'en'. */
function normaliseLocale(locale) {
    const code = typeof locale === 'string' ? locale.trim().toLowerCase().split(/[-_]/)[0] : '';
    return /^[a-z]{2,3}$/.test(code) ? code : 'en';
}

/**
 * Fill `{name}` placeholders; an unknown placeholder stays as written.
 * @param {string} text
 * @param {Record<string, unknown>} [vars]
 */
function fill(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, (whole, name) => (
        vars && Object.prototype.hasOwnProperty.call(vars, name) && vars[name] != null ? String(vars[name]) : whole
    ));
}

/**
 * @param {string} locale
 * @param {string} key
 * @param {Record<string, unknown>} [vars]
 * @param {{ getStrings?: (locale: string) => Promise<Record<string, string>> }} [deps]
 * @returns {Promise<string>}  the key itself when no catalogue has it
 */
async function translate(locale, key, vars = {}, deps = {}) {
    const getStrings = deps.getStrings || ((code) => require('../stores/languageStore').getEffectiveGUIStrings(code));
    const code = normaliseLocale(locale);
    /** @type {Record<string, string>} */
    let strings = {};
    try { strings = (await getStrings(code)) || {}; } catch { strings = {}; }
    let text = strings[key];
    if (typeof text !== 'string' || !text) {
        text = require('./defaults/en').GUI_DEFAULTS[key];
    }
    return typeof text === 'string' && text ? fill(text, vars) : key;
}

module.exports = { translate, normaliseLocale, fill };

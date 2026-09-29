// @typecheck
/**
 * Token NEUTRALISATION — turning `[person_1]` into "someone".
 *
 * ── WHY THIS IS NOT THE SAME AS TOKENISATION ────────────────────────
 * A token is not a neutral placeholder. It is a KEY in the token map of ONE
 * conversation (tokenizer.js: "two people on one token, in different
 * conversations"), and `restoreTokens` substitutes it on the READER'S turn,
 * with the READER'S map — including the drift shapes the model writes
 * (`[person2]`, `[email]2`, tokenRestore.js:20-31).
 *
 * So text that LEAVES the conversation it was minted in — a skill example
 * copied out of a chat and pasted into everybody's system prompt, an
 * automation suggestion, anything read later by somebody who was not there —
 * must not carry tokens at all. Carrying them is worse than carrying nothing:
 * `[person_1]` in a stored example silently becomes the READER's own customer
 * when their restore pass runs over the model's reply.
 *
 * This function is therefore the LAST step of such a copy, after detection and
 * tokenisation have located the values: the value is gone (tokenisation did
 * that) and the key is gone too (this does that), leaving a readable generic
 * noun that says what kind of thing used to be there.
 *
 * ── THE SHAPES IT HAS TO COVER ──────────────────────────────────────
 * Exactly the shapes `restoreTokens` will substitute, or the gap between the
 * two is the leak:
 *
 *   [person_1]        the minted form
 *   [person1]         drift — the model drops the underscore
 *   [email]2          drift — the model pushes the counter outside
 *   [PII:person:1]    the legacy form restoreTokens still accepts
 *   [REDACTED:…]      the block-mode marker
 *
 * A bracketed span that is NOT token-like (`[see the docs]`, a markdown link
 * label) is left exactly as it was: this runs over ordinary prose and must not
 * rewrite it.
 *
 * ── ONE VOCABULARY, TWO CALLERS ─────────────────────────────────────
 * `automation/suggestions.js` has had a private `stripTokens` with this same
 * word list since the suggestion feature shipped. This module is the shared
 * one; that copy is in another track's files and is reported for folding in
 * rather than edited here.
 */

'use strict';

/** Category key (see `_tokenCategoryKey`, minus separators) → readable noun. */
const TOKEN_WORDS = Object.freeze({
    email: 'an email address',
    emailaddress: 'an email address',
    person: 'someone',
    name: 'a name',
    phone: 'a phone number',
    phonenumber: 'a phone number',
    creditcard: 'a card number',
    creditcardnumber: 'a card number',
    iban: 'a bank account',
    bankaccount: 'a bank account',
    ssn: 'an ID number',
    ussocialsecuritynumber: 'an ID number',
    nationalid: 'an ID number',
    nationalidentificationnumber: 'an ID number',
    bsn: 'an ID number',
    passport: 'a passport number',
    passportnumber: 'a passport number',
    driverlicense: 'a licence number',
    address: 'an address',
    location: 'a place',
    organization: 'an organisation',
    organisation: 'an organisation',
    org: 'an organisation',
    company: 'a company',
    url: 'a link',
    ip: 'an IP address',
    ipaddress: 'an IP address',
    date: 'a date',
    dob: 'a date of birth',
    dateofbirth: 'a date of birth',
    medical: 'a medical detail',
    vat: 'a tax number',
    taxid: 'a tax number',
    // The old "Always hide these" terms, and their migrated types.
    customterm: 'a confidential term',
    custom: 'a confidential detail',
});

/** What an unrecognised category becomes. No brackets — see below. */
const GENERIC_WORD = 'a personal detail';
/** An org's own data type ("Your own data"): not necessarily personal. */
const CUSTOM_WORD = 'a confidential detail';

/**
 * A bracketed span whose interior is token-ish, plus the counter the model
 * sometimes writes OUTSIDE the brackets. Deliberately the same span shape
 * `restoreTokens` matches, so nothing it would substitute survives this.
 */
const BRACKET_RE = /\[([a-z0-9_ ]{1,60})\]([ \t]?\d{1,4})?/gi;
/** `[PII:person:1]` — the legacy minted form. */
const LEGACY_RE = /\[PII:[^\]\n]{0,80}\]/gi;
/** `[REDACTED:category]` — block mode's marker. */
const REDACTED_RE = /\[REDACTED:[^\]\n]{0,80}\]/gi;

/** Lowercase, letters+digits only — the same key `restoreTokens` compares on. */
function _norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function _wordFor(categoryKey) {
    if (TOKEN_WORDS[categoryKey]) return TOKEN_WORDS[categoryKey];
    // Lazy: the registry pulls in the matchers, and this module is a leaf.
    try {
        if (require('../customTypes/registry').isCustomTokenKey(categoryKey)) return CUSTOM_WORD;
    } catch (_) { /* registry unavailable: the generic word is still safe */ }
    return GENERIC_WORD;
}

/**
 * Replace every restorable token in `text` with a readable generic noun.
 *
 * Returns the text unchanged when there is no `[` in it at all, so the common
 * case costs one `indexOf`.
 *
 * @param {string} text
 * @returns {string}
 */
function neutraliseTokens(text) {
    if (typeof text !== 'string' || text.indexOf('[') === -1) return typeof text === 'string' ? text : '';
    return text
        .replace(LEGACY_RE, (m) => {
            // `[PII:person:1]` → the middle field is the category.
            const parts = m.slice(1, -1).split(':');
            return _wordFor(_norm(parts[1]));
        })
        .replace(REDACTED_RE, (m) => _wordFor(_norm(m.slice(1, -1).split(':')[1])))
        .replace(BRACKET_RE, (m, inner, tail) => {
            // Token-like means "a key, then digits" once normalised, which is
            // what every minted and every drifted token collapses to. A key
            // starts and ends with a letter and may hold digits in between (an
            // org's own placeholder, `[client2_code_1]`), exactly the keys
            // restoreTokens can substitute. Anything else is ordinary prose in
            // brackets and is left alone.
            const whole = _norm(inner) + _norm(tail || '');
            const hit = /^([a-z](?:[a-z0-9]*[a-z])?)([0-9]+)$/.exec(whole);
            if (!hit) return m;
            return _wordFor(hit[1]);
        });
}

module.exports = { neutraliseTokens, TOKEN_WORDS, GENERIC_WORD, CUSTOM_WORD };

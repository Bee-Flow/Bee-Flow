// @typecheck
/**
 * Password policy — one source of truth for what counts as an acceptable password.
 *
 * Signup used to accept 4 characters while password reset (loginRoutes.js) and
 * the 'reset.min_length' i18n string already required 8, so the weakest possible
 * password could only be set at signup. 8 is the value the rest of the product
 * already states to users.
 *
 * LENGTH WAS THE ONLY RULE, AND LENGTH IS NOT A RULE
 * A black-box pentest created a real, working organisation account through the
 * UI with the password `password`, logged straight into the application, then
 * used the authenticated API to change it to `12345678` — both accepted. That
 * matters more here than it would elsewhere, because the same assessment found
 * no rate limiting and no account lockout anywhere on the authentication
 * perimeter: unlimited guesses against a password space that includes the
 * single most common password in existence is an account-takeover chain, not
 * three separate low findings. See loginThrottle.js for the other half.
 *
 * WHAT THIS ENFORCES
 *   • a minimum length — 8 normally, 12 for accounts holding administrative
 *     rights, which are the accounts an attacker is actually aiming at;
 *   • rejection of the bundled common/breached list (commonPasswords.js),
 *     matched against a CANONICALISED form so `P@ssw0rd`, `Welkom123!` and
 *     `Sunshine2024` are caught by their base word rather than sailing past on
 *     a literal string comparison;
 *   • rejection of passwords derived from the account's own username or e-mail;
 *   • rejection of pure repeats and keyboard/alphabet runs.
 *
 * WHAT THIS DELIBERATELY DOES NOT ENFORCE
 * Composition rules ("one uppercase, one digit, one symbol"). NIST SP 800-63B
 * dropped them because they push users towards exactly the P@ssw0rd1 shapes the
 * deny-list above already catches, while blocking genuinely strong passphrases.
 * The one exception is the first-run super-admin setup route, which had a
 * complexity check before this module existed; weakening an existing control to
 * satisfy a style preference would be a strange way to close a security finding,
 * so it stays.
 *
 * The frontend mirrors MIN_PASSWORD_LENGTH in
 * agent-hub/src/pages/login/signupValidation.js; the two are pinned together by
 * that module's test. The frontend deliberately does NOT mirror the deny-list —
 * shipping it to the browser publishes nothing secret, but it doubles the
 * bundle's job for a check the server has to repeat anyway. The server is
 * authoritative; the client only spares a round-trip on length.
 *
 * server/compliance/checks/iso27001/a8-5-secure-auth.js reads MIN_PASSWORD_LENGTH
 * from here — keep the export name.
 */

const { COMMON_PASSWORDS } = require('./commonPasswords');
const log = require('../telemetry/log');

const MIN_PASSWORD_LENGTH = 8;
/**
 * Administrative accounts (super-admin, org_admin) get a longer floor. They are
 * the accounts credential stuffing is aimed at, and on a multi-tenant product a
 * compromised org_admin is a compromised tenant.
 */
const MIN_ADMIN_PASSWORD_LENGTH = 12;
/**
 * Not a security limit — bcrypt only reads the first 72 bytes anyway. It stops
 * a megabyte "password" from being carried through the Argon2id DEK derivation
 * on every login, and gives the user a real error instead of a silent truncation.
 */
const MAX_PASSWORD_LENGTH = 256;

/** Org roles that get the longer minimum. */
const ADMIN_ORG_ROLES = new Set(['org_admin', 'admin']);

// Reverse the substitutions people reach for when a form tells them to "add a
// number or symbol". Without this, `P@ssw0rd` is simply not in the deny-list.
const LEET = { '4': 'a', '@': 'a', '3': 'e', '1': 'i', '!': 'i', '|': 'i', '0': 'o', '5': 's', '$': 's', '7': 't', '+': 't', '8': 'b', '9': 'g' };

/**
 * Every form of the candidate worth testing against the deny-list.
 *
 * The point is that `Welkom123!`, `welkom`, `W3lk0m` and `welkom_2025` are one
 * password wearing four hats, and an attacker's list contains all four while a
 * literal Set lookup catches only one.
 */
function canonicalForms(password) {
    const lower = String(password).toLowerCase();
    const forms = new Set([lower]);

    const deleet = lower.replace(/[4@31!|05$7+89]/g, (c) => LEET[c] || c);
    forms.add(deleet);

    for (const base of [lower, deleet]) {
        // Drop separators and symbols: `bee-flow_2025` → `beeflow2025`.
        const alnum = base.replace(/[^a-z0-9]/g, '');
        if (alnum) forms.add(alnum);
        // Drop the year/counter people append: `beeflow2025` → `beeflow`.
        const core = alnum.replace(/^[0-9]+/, '').replace(/[0-9]+$/, '');
        if (core.length >= 4) forms.add(core);
    }
    return forms;
}

/** Is the password one of the ones an attacker tries first? */
function isCommonPassword(password) {
    for (const form of canonicalForms(password)) {
        if (COMMON_PASSWORDS.has(form)) return true;
    }
    return false;
}

/**
 * `aaaaaaaa`, `abababab`, `123123123` — long enough to pass a length check and
 * worthless. Detects a password that is one unit repeated to fill the minimum.
 *
 * Two rules rather than "any repeat", because "any repeat" is too blunt: a
 * SHORT unit (≤4) repeated is padding, and a COMMON word repeated is a common
 * word. Everything else — `hunter2hunter2`, `molenwiekmolenwiek` — is left
 * alone, since rejecting it buys little and rejecting things users consider
 * reasonable is how a password policy trains people to write passwords down.
 */
const MAX_FILLER_UNIT = 4;
function isRepeatedUnit(password) {
    const s = String(password);
    for (let unit = 1; unit <= Math.floor(s.length / 2); unit++) {
        if (s.length % unit !== 0) continue;
        const head = s.slice(0, unit);
        if (head.repeat(s.length / unit) !== s) continue;
        if (unit <= MAX_FILLER_UNIT) return true;
        if (COMMON_PASSWORDS.has(head.toLowerCase())) return true;
    }
    return false;
}

/**
 * A straight run through the alphabet, the digits or a keyboard row —
 * `12345678`, `abcdefgh`, `qwertyui` and their reverses. Flagged when the run
 * accounts for most of the password, so `abcd` inside a longer passphrase is
 * fine but `abcdefgh1` is not.
 */
function isSequential(password) {
    const s = String(password).toLowerCase();
    if (s.length < 4) return false;
    const ROWS = ['abcdefghijklmnopqrstuvwxyz', '01234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', 'azertyuiop'];
    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < s.length; i++) {
        const adjacent = ROWS.some((row) => {
            const a = row.indexOf(s[i - 1]);
            const b = row.indexOf(s[i]);
            return a !== -1 && b !== -1 && Math.abs(a - b) === 1;
        });
        run = adjacent ? run + 1 : 1;
        if (run > longestRun) longestRun = run;
    }
    return longestRun >= Math.max(4, Math.ceil(s.length * 0.7));
}

/**
 * A password built out of the account's own identity is public knowledge with
 * extra steps — and username enumeration hands an attacker the first half of it.
 */
function derivesFromIdentity(password, { username, email }) {
    const lower = String(password).toLowerCase();
    const alnum = lower.replace(/[^a-z0-9]/g, '');
    const candidates = [];
    if (username) candidates.push(String(username).toLowerCase());
    if (email && String(email).includes('@')) {
        const [local, domain] = String(email).toLowerCase().split('@');
        candidates.push(local);
        // The domain label only — `beeflow` out of `beeflow.nl`.
        if (domain) candidates.push(domain.split('.')[0]);
    }
    return candidates.some((c) => {
        const clean = c.replace(/[^a-z0-9]/g, '');
        if (clean.length < 4) return false;
        return alnum.includes(clean) || clean.includes(alnum);
    });
}

/**
 * The one gate every password-setting path calls.
 *
 * Synchronous on purpose: it is called from request handlers that already have
 * an await-heavy critical path, and every check here is local. The optional
 * Have I Been Pwned lookup is a separate async function precisely so that no
 * caller accidentally makes an outbound network call part of its hot path.
 *
 * @param {string} password
 * @param {object} [opts]
 * @param {string} [opts.username]  the account's username, if known
 * @param {string} [opts.email]     the account's e-mail, if known
 * @param {boolean} [opts.isAdmin]  target holds administrative rights → longer minimum
 * @param {string} [opts.role]      'admin' also selects the longer minimum
 * @param {string} [opts.orgRole]   'org_admin' also selects the longer minimum
 * @returns {{ok: boolean, error?: string, code?: string}}
 */
function validatePassword(password, opts = {}) {
    const { username = '', email = '', isAdmin = false, role = '', orgRole = '' } = opts;

    if (typeof password !== 'string' || password.length === 0) {
        return { ok: false, code: 'password_required', error: 'A password is required' };
    }

    const privileged = !!isAdmin || role === 'admin' || ADMIN_ORG_ROLES.has(orgRole);
    const min = privileged ? MIN_ADMIN_PASSWORD_LENGTH : MIN_PASSWORD_LENGTH;

    if (password.length < min) {
        return {
            ok: false,
            code: 'password_too_short',
            error: privileged
                ? `Administrator passwords must be at least ${min} characters`
                : `Password must be at least ${min} characters`,
        };
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
        return { ok: false, code: 'password_too_long', error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters` };
    }
    if (isCommonPassword(password)) {
        return {
            ok: false,
            code: 'password_too_common',
            error: 'This password appears in known breach lists. Please choose a different one.',
        };
    }
    if (isRepeatedUnit(password)) {
        return { ok: false, code: 'password_repetitive', error: 'This password is a single repeated pattern. Please choose a different one.' };
    }
    if (isSequential(password)) {
        return { ok: false, code: 'password_sequential', error: 'This password is a keyboard or alphabet sequence. Please choose a different one.' };
    }
    if (derivesFromIdentity(password, { username, email })) {
        return { ok: false, code: 'password_contains_identity', error: 'Your password must not contain your username or e-mail address.' };
    }
    return { ok: true };
}

// ── Optional: Have I Been Pwned range check ───────────────────────────────────
// Opt-in via PASSWORD_BREACH_CHECK=hibp. OFF by default, and that default is a
// product decision rather than an oversight: this is a privacy-first,
// self-hostable product and a fair number of installs are air-gapped, so an
// outbound call on every password change cannot be a hard dependency.
//
// The protocol is k-anonymity — only the first five hex characters of the
// SHA-1 leave this process, and the API answers with every suffix under that
// prefix (~500 hashes). The password itself is never transmitted, and the
// service cannot tell which of the returned hashes was ours.
//
// FAILS OPEN. An unreachable breach API must never make it impossible to change
// a password; the bundled deny-list above is the control that is always on.

const _hibpCache = new Map();   // sha1 prefix → { at, suffixes: Map<suffix, count> }
const HIBP_TTL_MS = 6 * 60 * 60 * 1000;

function breachCheckEnabled() {
    return String(process.env.PASSWORD_BREACH_CHECK || '').toLowerCase() === 'hibp';
}

/**
 * @returns {Promise<{breached: boolean, count: number}|null>} null = check disabled or unavailable
 */
async function checkBreachedPassword(password) {
    if (!breachCheckEnabled() || typeof password !== 'string' || !password) return null;
    try {
        const crypto = require('crypto');
        const sha1 = crypto.createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
        const prefix = sha1.slice(0, 5);
        const suffix = sha1.slice(5);

        let entry = _hibpCache.get(prefix);
        if (!entry || Date.now() - entry.at > HIBP_TTL_MS) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 2500);
            try {
                const resp = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
                    signal: controller.signal,
                    headers: { 'Add-Padding': 'true', 'User-Agent': 'BeeFlow-PasswordPolicy' },
                });
                if (!resp.ok) return null;
                const body = await resp.text();
                const suffixes = new Map();
                for (const line of body.split('\n')) {
                    const [s, c] = line.trim().split(':');
                    if (s) suffixes.set(s.toUpperCase(), parseInt(c, 10) || 0);
                }
                entry = { at: Date.now(), suffixes };
                _hibpCache.set(prefix, entry);
                // Bound the cache — one entry per prefix seen, and there are
                // 1,048,576 possible prefixes.
                if (_hibpCache.size > 5000) _hibpCache.clear();
            } finally {
                clearTimeout(timer);
            }
        }
        const count = entry.suffixes.get(suffix) || 0;
        // Padded responses include zero-count decoys; treat those as clean.
        return { breached: count > 0, count };
    } catch (err) {
        if (err?.name !== 'AbortError') {
            log.warn('[PasswordPolicy] breach check unavailable:', err.message);
        }
        return null;
    }
}

/**
 * validatePassword + the optional breach lookup, for the handful of call sites
 * that set a password and can afford one outbound request.
 * @returns {Promise<{ok: boolean, error?: string, code?: string}>}
 */
async function validatePasswordAsync(password, opts = {}) {
    const local = validatePassword(password, opts);
    if (!local.ok) return local;
    const breach = await checkBreachedPassword(password);
    if (breach?.breached) {
        return {
            ok: false,
            code: 'password_breached',
            error: 'This password has appeared in a public data breach. Please choose a different one.',
        };
    }
    return { ok: true };
}

module.exports = {
    MIN_PASSWORD_LENGTH,
    MIN_ADMIN_PASSWORD_LENGTH,
    MAX_PASSWORD_LENGTH,
    validatePassword,
    validatePasswordAsync,
    checkBreachedPassword,
    // exported for tests
    isCommonPassword,
    isRepeatedUnit,
    isSequential,
    canonicalForms,
};

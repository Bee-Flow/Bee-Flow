/**
 * App Studio catalog — definition.variables: the declared shared values, their
 * types, the reserved names, and the default coercion both runtimes seed from.
 */

'use strict';

const { LIMITS } = require('./limits');

// ---------------------------------------------------------------------------
// Variables — definition.variables, the app's DECLARED shared values.
//
// `vars` was a bag that came into existence by accident: a filter_bar field
// name, a set_variable step, a resultVar. Nothing listed the names an app
// used, nothing gave them a starting value, and nothing caught a typo — a
// formula reading `vars.statusfilter` where `vars.filters.status` was meant
// resolved to undefined, the filter entry was dropped, and the component
// listed the whole table without a word. Declaring them fixes all three.
// ---------------------------------------------------------------------------

const VARIABLE_TYPES = ['text', 'number', 'yesno', 'date', 'record', 'list', 'any'];

const VARIABLE_TYPE_DEFAULTS = {
    text: '', number: 0, yesno: false, date: null, record: {}, list: [], any: null,
};

/**
 * A name has to be reachable as `vars.<name>` in a formula, so it must lex as a
 * single IDENT to the shared expression engine. Deliberately narrower than the
 * engine accepts: no `$` (nothing here uses it and it reads like a template
 * artefact), no leading digit. Length matches set_variable.name / resultVar
 * (60) so a name an action can WRITE is always a name an author can DECLARE.
 */
const VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;

/**
 * `filters` belongs to the filter_bar component, which republishes the WHOLE
 * object on every keystroke (runtime/components/AppFilterBar) — a declared
 * default there would be wiped the first time someone typed, and a declared
 * type would contradict the object the bar writes. true/false/null lex as
 * literals, not identifiers, so `vars.true` is a parse error rather than a
 * miss; naming them is what turns "bad characters" into "reserved word".
 */
const RESERVED_VARIABLE_NAMES = ['filters', 'true', 'false', 'null'];

const VARIABLE_SPEC = {
    name: { type: 'string', required: true, maxLen: 60 },
    label: { type: 'string', maxLen: 80, default: '' },
    type: { type: 'enum', values: VARIABLE_TYPES, default: 'any' },
    default: { type: 'json' },
    description: { type: 'string', maxLen: 500, default: '' },
};

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function jsonBytes(value) {
    try { return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8'); }
    catch { return Infinity; }
}

/**
 * Bring a declared default in line with its type.
 *
 * One implementation, four callers (canonicalize, validate, the executor's
 * scope seed and the catalog), because a default that means one thing on the
 * client and another on the server is worse than no default at all.
 *
 * `date` falls back to null rather than today: a definition is cached,
 * published and frozen, so a "today" baked into the bytes is wrong tomorrow
 * morning. An author who wants today writes the `today` root where it is read.
 *
 * Returns { value, coerced } — `coerced` true when the input was not already
 * the canonical form, which is what canonicalize turns into a repair note.
 */
function coerceVariableDefault(type, value) {
    const fallback = Object.prototype.hasOwnProperty.call(VARIABLE_TYPE_DEFAULTS, type)
        ? VARIABLE_TYPE_DEFAULTS[type] : null;
    const miss = () => ({ value: fallback, coerced: true });

    switch (type) {
        case 'text': {
            if (typeof value === 'string') {
                return value.length > LIMITS.MAX_STRING
                    ? { value: value.slice(0, LIMITS.MAX_STRING), coerced: true }
                    : { value, coerced: false };
            }
            if (typeof value === 'number' && Number.isFinite(value)) return { value: String(value), coerced: true };
            if (typeof value === 'boolean') return { value: String(value), coerced: true };
            return miss();
        }
        case 'number': {
            if (typeof value === 'number' && Number.isFinite(value)) return { value, coerced: false };
            if (typeof value === 'string' && value.trim() !== '') {
                const n = Number(value);
                if (Number.isFinite(n)) return { value: n, coerced: true };
            }
            if (typeof value === 'boolean') return { value: value ? 1 : 0, coerced: true };
            return miss();
        }
        case 'yesno': {
            if (typeof value === 'boolean') return { value, coerced: false };
            if (value === 'true' || value === 1) return { value: true, coerced: true };
            if (value === 'false' || value === 0) return { value: false, coerced: true };
            return miss();
        }
        case 'date': {
            if (value === null) return { value: null, coerced: false };
            if (typeof value === 'string') {
                if (ISO_DATE_ONLY_RE.test(value)) return { value, coerced: false };
                // An ISO datetime is a date someone over-specified.
                if (ISO_DATE_ONLY_RE.test(value.slice(0, 10))) return { value: value.slice(0, 10), coerced: true };
            }
            return miss();
        }
        case 'record': {
            const ok = value && typeof value === 'object' && !Array.isArray(value);
            if (!ok) return miss();
            return jsonBytes(value) > LIMITS.MAX_VARIABLE_DEFAULT_BYTES ? miss() : { value, coerced: false };
        }
        case 'list': {
            if (!Array.isArray(value)) return miss();
            return jsonBytes(value) > LIMITS.MAX_VARIABLE_DEFAULT_BYTES ? miss() : { value, coerced: false };
        }
        case 'any':
        default: {
            if (value === undefined) return { value: null, coerced: true };
            return jsonBytes(value) > LIMITS.MAX_VARIABLE_DEFAULT_BYTES ? miss() : { value, coerced: false };
        }
    }
}

/**
 * The `vars` seed a run starts from: { [name]: coerced default }.
 *
 * Both halves of the runtime call this — the browser at mount and
 * buildServerScope on every step — so a filter reading `vars.status` filters on
 * first paint instead of being dropped for having no value yet.
 */
function seedVariableDefaults(variables) {
    const out = {};
    for (const v of Array.isArray(variables) ? variables : []) {
        if (!v || typeof v !== 'object') continue;
        if (typeof v.name !== 'string' || !VARIABLE_NAME_RE.test(v.name)) continue;
        if (RESERVED_VARIABLE_NAMES.includes(v.name)) continue;
        const type = VARIABLE_TYPES.includes(v.type) ? v.type : 'any';
        out[v.name] = coerceVariableDefault(type, v.default).value;
    }
    return out;
}

module.exports = {
    VARIABLE_TYPES,
    VARIABLE_TYPE_DEFAULTS,
    VARIABLE_NAME_RE,
    RESERVED_VARIABLE_NAMES,
    VARIABLE_SPEC,
    coerceVariableDefault,
    seedVariableDefaults,
};

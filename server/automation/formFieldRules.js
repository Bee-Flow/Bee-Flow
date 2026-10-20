/**
 * Per-field answer rules and conditional visibility for forms.
 *
 *   • Rules: min/max (number, date), minLength/maxLength (text, textarea,
 *     email), pattern (text, textarea), minSelected/maxSelected (multiselect).
 *     `normalizeRules` copies only the attributes valid for a type,
 *     `validateRules` tells the author what is wrong, `checkRules` judges one
 *     submitted value.
 *   • showIf: an expression in the restricted shared/expr grammar. Its only
 *     root is `form`, and it may only name input fields declared EARLIER on
 *     the same page. `validateShowIf` checks that on save, `isVisible`
 *     evaluates it on submit.
 *
 * Security: author regexes run ONLY through RE2 (linear time, no
 * backtracking), anchored to the whole value; expressions only through the
 * restricted engine. Nothing here evals input.
 *
 * Pure: no I/O. No module in here requires formTriggerContract.js.
 */

'use strict';

const RE2 = require('re2');
const { parseExpr, evaluate } = require('../shared/expr/index.mjs');
const log = require('../telemetry/log');
const { MAX_STRING_VALUE } = require('./appTriggerContract');
const { formOptionsCap, isPlainObject, DATE_RE, MAX_TEXTAREA_LEN, MAX_SHOW_IF_LEN, MAX_PATTERN_LEN, MAX_PATTERN_MESSAGE_LEN } = require('./formFieldTypes');

/** The longest answer each text-like type accepts (see formCoerce.js). */
const TEXT_MAX_LEN = Object.freeze({ text: MAX_STRING_VALUE, email: MAX_STRING_VALUE, textarea: MAX_TEXTAREA_LEN });

/** The rule attributes each type carries. */
const RULE_KEYS = Object.freeze({
    number: ['min', 'max'],
    date: ['min', 'max'],
    text: ['minLength', 'maxLength', 'pattern', 'patternMessage'],
    textarea: ['minLength', 'maxLength', 'pattern', 'patternMessage'],
    email: ['minLength', 'maxLength'],
    multiselect: ['minSelected', 'maxSelected'],
});
const ALL_RULE_KEYS = Object.freeze([...new Set(Object.values(RULE_KEYS).flat())]);

const absent = (v) => v === undefined || v === null || v === '';
const isNonNegInt = (v) => Number.isInteger(v) && v >= 0;

/** A number the author typed: a finite number, or numeric text. */
function asNumber(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
}

function asCount(v) {
    const n = asNumber(v);
    return n !== null && isNonNegInt(n) ? n : null;
}

// ── Patterns ───────────────────────────────────────────

const PATTERN_CACHE_MAX = 200;
const patternCache = new Map();

/**
 * Compile an author pattern for a WHOLE-value match. The bare pattern is
 * compiled first, on its own: wrapped, an unbalanced `a)|(b` would still
 * compile and quietly change what the anchors cover.
 * Returns the RE2, or null when the pattern is not valid RE2 syntax.
 */
function compilePattern(pattern) {
    if (typeof pattern !== 'string' || !pattern || pattern.length > MAX_PATTERN_LEN) return null;
    if (patternCache.has(pattern)) return patternCache.get(pattern);
    let re = null;
    try {
        void new RE2(pattern, 'u');
        re = new RE2(`^(?:${pattern})$`, 'u');
    } catch (err) {
        log.debug('form pattern does not compile', { error: String(err?.message || err).slice(0, 200) });
    }
    if (patternCache.size >= PATTERN_CACHE_MAX) patternCache.delete(patternCache.keys().next().value);
    patternCache.set(pattern, re);
    return re;
}

// ── Normalize / validate ───────────────────────────────

/**
 * The rule attributes of `raw` that are valid for `type`, nothing else.
 * Idempotent: normalizing its own output returns the same thing.
 */
function normalizeRules(raw, type) {
    const out = {};
    const keys = RULE_KEYS[type];
    if (!keys || !isPlainObject(raw)) return out;
    for (const key of keys) {
        const v = raw[key];
        if (absent(v)) continue;
        if (key === 'min' || key === 'max') {
            if (type === 'number') {
                const n = asNumber(v);
                if (n !== null) out[key] = n;
            } else if (typeof v === 'string' && DATE_RE.test(v.trim())) {
                out[key] = v.trim();
            }
        } else if (key === 'minLength' || key === 'maxLength') {
            const n = asCount(v);
            if (n !== null) out[key] = Math.min(n, TEXT_MAX_LEN[type]);
        } else if (key === 'minSelected' || key === 'maxSelected') {
            const n = asCount(v);
            if (n !== null) out[key] = n;
        } else if (key === 'pattern') {
            if (typeof v === 'string' && v && v.length <= MAX_PATTERN_LEN) out.pattern = v;
        } else if (typeof v === 'string' && v.trim()) {
            out.patternMessage = v.trim().slice(0, MAX_PATTERN_MESSAGE_LEN);
        }
    }
    return out;
}

/**
 * Tell the author what is wrong with the rules on a field declaration `f`.
 * `push(code, path, message, hint)` collects issues.
 */
function validateRules(f, at, push) {
    const allowed = RULE_KEYS[f.type] || [];
    const label = `"${f.name}"`;
    for (const key of ALL_RULE_KEYS) {
        if (absent(f[key]) || allowed.includes(key)) continue;
        push('field_rule_invalid', `${at}.${key}`, `${key} does not apply to ${label}, which is a ${f.type || 'text'} question.`, 'Remove it, or change the question type.');
    }
    if (!allowed.length) return;

    const bad = (key, message, hint) => push('field_rule_invalid', `${at}.${key}`, message, hint);
    const pair = (lo, hi, parse, what) => {
        const a = absent(f[lo]) ? null : parse(f[lo]);
        const b = absent(f[hi]) ? null : parse(f[hi]);
        if (!absent(f[lo]) && a === null) bad(lo, `${lo} on ${label} is not valid.`, what);
        if (!absent(f[hi]) && b === null) bad(hi, `${hi} on ${label} is not valid.`, what);
        if (a !== null && b !== null && a > b) bad(hi, `${lo} is larger than ${hi} on ${label}.`, `Make ${hi} at least ${lo}.`);
        return { a, b };
    };

    if (allowed.includes('min') && f.type === 'number') pair('min', 'max', asNumber, 'Use a plain number.');
    if (allowed.includes('min') && f.type === 'date') pair('min', 'max', (v) => (typeof v === 'string' && DATE_RE.test(v.trim()) ? v.trim() : null), 'Use a date as YYYY-MM-DD.');
    if (allowed.includes('minLength')) {
        const { a, b } = pair('minLength', 'maxLength', asCount, 'Use a whole number, 0 or more.');
        const cap = TEXT_MAX_LEN[f.type];
        for (const [key, n] of [['minLength', a], ['maxLength', b]]) {
            if (n !== null && n > cap) bad(key, `${key} on ${label} is larger than the ${cap} characters this question can hold.`, `Use ${cap} or less.`);
        }
    }
    if (allowed.includes('minSelected')) {
        const { b } = pair('minSelected', 'maxSelected', asCount, 'Use a whole number, 0 or more.');
        const cap = formOptionsCap();
        if (b !== null && cap > 0 && b > cap) bad('maxSelected', `maxSelected on ${label} is larger than the ${cap} choices a question can offer.`, `Use ${cap} or less.`);
    }
    if (allowed.includes('pattern') && !absent(f.pattern)) validatePattern(f, at, push);
    if (allowed.includes('patternMessage') && !absent(f.patternMessage)
        && (typeof f.patternMessage !== 'string' || f.patternMessage.length > MAX_PATTERN_MESSAGE_LEN)) {
        bad('patternMessage', `patternMessage on ${label} must be text of at most ${MAX_PATTERN_MESSAGE_LEN} characters.`, 'Shorten it.');
    }
}

function validatePattern(f, at, push) {
    const path = `${at}.pattern`;
    if (typeof f.pattern !== 'string' || f.pattern.length > MAX_PATTERN_LEN) {
        push('field_pattern_invalid', path, `The pattern on "${f.name}" must be text of at most ${MAX_PATTERN_LEN} characters.`, 'Shorten the pattern.');
    } else if (!compilePattern(f.pattern)) {
        push('field_pattern_invalid', path, `The pattern on "${f.name}" is not a valid pattern.`, 'Check the brackets and escapes. Look-ahead and back-references are not supported.');
    }
}

// ── Checking one value ─────────────────────────────────

/**
 * Judge one NON-BLANK value against the field's rules. Returns null when it
 * passes, else an error tail such as "must be at least 3" that the caller
 * prefixes with the label. A blank value is never checked here: "is it
 * required" is the caller's question.
 */
function checkRules(field, value) {
    switch (field.type) {
        case 'number': {
            if (typeof value !== 'number') return null;
            if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
            if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
            return null;
        }
        case 'date': {
            if (typeof value !== 'string' || !value) return null;
            if (field.min !== undefined && value < field.min) return `must be on or after ${field.min}`;
            if (field.max !== undefined && value > field.max) return `must be on or before ${field.max}`;
            return null;
        }
        case 'multiselect': {
            if (!Array.isArray(value) || !value.length) return null;
            if (field.minSelected !== undefined && value.length < field.minSelected) {
                return `must have at least ${field.minSelected} ${field.minSelected === 1 ? 'choice' : 'choices'}`;
            }
            if (field.maxSelected !== undefined && value.length > field.maxSelected) {
                return `must have at most ${field.maxSelected} ${field.maxSelected === 1 ? 'choice' : 'choices'}`;
            }
            return null;
        }
        case 'text':
        case 'textarea':
        case 'email': {
            if (typeof value !== 'string' || !value) return null;
            const len = [...value].length;
            if (field.minLength !== undefined && len < field.minLength) return `must be at least ${field.minLength} characters`;
            if (field.maxLength !== undefined && len > field.maxLength) return `must be at most ${field.maxLength} characters`;
            if (field.pattern) {
                const re = compilePattern(field.pattern);
                // A pattern that cannot compile is the author's mistake,
                // reported on save. It must not lock every visitor out.
                if (re && !re.test(value)) return 'is not in the expected format';
            }
            return null;
        }
        default:
            return null;
    }
}

/**
 * The full message for a value that fails its rules, or null. A pattern
 * failure with an authored `patternMessage` shows that message as written:
 * the author wrote the whole sentence ("Use a code like AB-123").
 */
function ruleError(field, value) {
    const tail = checkRules(field, value);
    if (!tail) return null;
    if (tail === 'is not in the expected format' && field.patternMessage) return field.patternMessage;
    return `${field.label} ${tail}.`;
}

// ── showIf ─────────────────────────────────────────────

/** An authored showIf as a trimmed string within the limit, else ''. */
function normalizeShowIf(raw) {
    if (typeof raw !== 'string') return '';
    const s = raw.trim();
    return s.length <= MAX_SHOW_IF_LEN ? s : '';
}

/** Every `path` node of an AST, including the ones inside index brackets and call arguments. */
function pathNodes(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (node.kind === 'path') {
        out.push(node);
        for (const s of node.segments) if (s.expr) pathNodes(s.expr, out);
    }
    for (const key of ['a', 'b', 'cond']) if (node[key]) pathNodes(node[key], out);
    if (Array.isArray(node.args)) for (const a of node.args) pathNodes(a, out);
    return out;
}

/** The field name a `form.<name>` path points at, or null when it names no field plainly. */
function referencedField(node) {
    const second = node.segments[1];
    if (!second) return null;
    if (second.kind === 'name') return second.v;
    if (second.kind === 'index' && second.expr?.kind === 'str') return second.expr.v;
    return null;
}

/**
 * Check a showIf on save. `earlierInputNames` are the input fields declared
 * before this one on the same page. Emits `field_show_if_invalid`.
 */
function validateShowIf(src, earlierInputNames, at, push) {
    const known = new Set(earlierInputNames);
    const fail = (message, hint) => push('field_show_if_invalid', at, message, hint);
    if (typeof src !== 'string' || !src.trim()) {
        fail('The condition for showing this question is empty.', 'Write a condition such as form.contact == "email", or remove it.');
        return;
    }
    if (src.trim().length > MAX_SHOW_IF_LEN) {
        fail(`The condition for showing this question is longer than ${MAX_SHOW_IF_LEN} characters.`, 'Shorten it.');
        return;
    }
    let ast;
    try {
        ast = parseExpr(src);
    } catch (err) {
        fail(`The condition for showing this question cannot be read: ${String(err?.message || err).slice(0, 120)}.`, 'Use answers of earlier questions as form.<name>, e.g. form.contact == "email".');
        return;
    }
    for (const node of pathNodes(ast)) {
        const root = node.segments[0];
        if (root?.kind !== 'name' || root.v !== 'form') {
            fail(`The condition can only look at earlier answers (form.<name>), not "${root?.v ?? '?'}".`, 'Replace it with form.<name> of a question above this one.');
            return;
        }
        const name = referencedField(node);
        if (name === null) {
            fail('The condition has to name a question, e.g. form.contact.', 'Add the name of an earlier question after "form.".');
            return;
        }
        if (!known.has(name)) {
            fail(`The condition refers to "${name}", which is not a question above this one on the same page.`, 'A question can only depend on questions that come before it.');
            return;
        }
    }
}

const SHOW_IF_AST_MAX = 200;
const showIfAsts = new Map();

function astOf(src) {
    if (showIfAsts.has(src)) return showIfAsts.get(src);
    const ast = parseExpr(src);
    if (showIfAsts.size >= SHOW_IF_AST_MAX) showIfAsts.delete(showIfAsts.keys().next().value);
    showIfAsts.set(src, ast);
    return ast;
}

/**
 * Is a field with this showIf visible, given the earlier answers
 * (`formScope`: name -> value)? No showIf means visible. A condition that
 * cannot be evaluated FAILS OPEN (visible), like approval-stage conditions:
 * a broken expression must never hide a question the visitor has to answer.
 */
function isVisible(showIf, formScope) {
    if (typeof showIf !== 'string' || !showIf) return true;
    try {
        return !!evaluate(astOf(showIf), { form: formScope || {} });
    } catch (err) {
        log.warn('form showIf failed; the question stays visible', { error: String(err?.message || err).slice(0, 200) });
        return true;
    }
}

module.exports = {
    RULE_KEYS,
    TEXT_MAX_LEN,
    normalizeRules,
    validateRules,
    compilePattern,
    checkRules,
    ruleError,
    normalizeShowIf,
    validateShowIf,
    isVisible,
};

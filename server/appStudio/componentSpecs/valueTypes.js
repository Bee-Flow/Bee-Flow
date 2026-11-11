// @typecheck strict
/**
 * App Studio value types: the kinds of value a style knob or a design key can hold beyond
 * the base ones.
 *
 * The base kinds are handled by name where they are used: int, enum, colorOrRole and unitInt
 * for a style knob (canonicalize/style.js, validate/nodes.js, builderPrompt/catalogRender.js),
 * enum and url for a design key (appDesignSpec.js). Any other `type` on a knob or a design
 * key is looked up here, so a new kind of value is one entry in VALUE_TYPES and reaches the
 * canonicalizer, the validator and the AI catalogue together.
 *
 * An entry holds:
 *   check(spec, where)  throws when a knob or key of this type is declared wrongly
 *   clean(value, spec)  the value to store, or undefined when it is not acceptable
 *   hint(spec)          what an acceptable value looks like, for a repair or error message
 *   render(key, spec)   the token for the AI catalogue
 *
 * A value of these types has no default that is written: null or absent means "not set",
 * and the key then stays out of the canonical form.
 *
 * @typedef {{ type: string, maxLen?: number, sanitize?: (text: string) => unknown, clean?: (value: unknown) => unknown, shape?: string, [k: string]: unknown }} TypedSpec  A knob or design key of one of these types.
 * @typedef {{ check: (spec: TypedSpec, where: string) => void, clean: (value: unknown, spec: TypedSpec) => unknown, hint: (spec: TypedSpec) => string, render: (key: string, spec: TypedSpec) => string }} ValueType
 */

'use strict';

const { sameJsonValue } = require('../../shared/format/sameJsonValue.mjs');

const ASSET_PREFIX = 'asset:';
const ASSET_ID_MAX = 64;
const ASSET_ID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';

/**
 * Is `value` a reference to one of the app's own assets: the string `asset:<id>`, the id
 * 1..64 letters, digits, `_` or `-`? Whether that asset exists is not decided here.
 * @param {unknown} value
 * @returns {value is string}
 */
function isAssetRef(value) {
    if (typeof value !== 'string' || !value.startsWith(ASSET_PREFIX)) return false;
    const id = value.slice(ASSET_PREFIX.length);
    if (id.length < 1 || id.length > ASSET_ID_MAX) return false;
    for (const ch of id) if (!ASSET_ID_CHARS.includes(ch)) return false;
    return true;
}

/** @type {Readonly<Record<string, ValueType>>} */
const VALUE_TYPES = Object.freeze({
    asset: Object.freeze({
        check() {},
        clean: (/** @type {unknown} */ value) => (isAssetRef(value) ? value : undefined),
        hint: () => 'Use "asset:<id>" with the id of an asset of this app, or null.',
        render: (/** @type {string} */ key) => `${key}(null|asset:<id>)`,
    }),
    // Stylesheet text. The type has no sanitiser of its own: the declaring spec names the
    // one that fits where the text is used, and without one no text is accepted at all.
    css: Object.freeze({
        check(/** @type {TypedSpec} */ spec, /** @type {string} */ where) {
            if (!Number.isInteger(spec.maxLen) || Number(spec.maxLen) < 1) throw new Error(`${where}: a css value declares maxLen (a whole number of characters)`);
            if (typeof spec.sanitize !== 'function') throw new Error(`${where}: a css value declares sanitize(text), returning the text that may be stored`);
        },
        clean(/** @type {unknown} */ value, /** @type {TypedSpec} */ spec) {
            if (typeof value !== 'string' || typeof spec.sanitize !== 'function') return undefined;
            if (!Number.isInteger(spec.maxLen) || value.length > Number(spec.maxLen)) return undefined;
            const text = spec.sanitize(value);
            return typeof text === 'string' && text.length <= Number(spec.maxLen) && text.trim() ? text : undefined;
        },
        hint: (/** @type {TypedSpec} */ spec) => `Use stylesheet text of at most ${spec.maxLen} characters, or null.`,
        render: (/** @type {string} */ key, /** @type {TypedSpec} */ spec) => `${key}(null|css, max ${spec.maxLen} chars)`,
    }),
    // A small value of a fixed shape (a number in a range, an object of a few keys) that the
    // declaring spec cleans itself: `clean(value)` returns what is stored or undefined, `shape`
    // says what is accepted (design.tokens, design.radiusPx, design.dark: designTokens.mts).
    shaped: Object.freeze({
        check(/** @type {TypedSpec} */ spec, /** @type {string} */ where) {
            if (typeof spec.clean !== 'function') throw new Error(`${where}: a shaped value declares clean(value), returning the value that may be stored`);
            if (typeof spec.shape !== 'string' || !spec.shape) throw new Error(`${where}: a shaped value declares shape, the accepted form as text`);
        },
        clean: (/** @type {unknown} */ value, /** @type {TypedSpec} */ spec) => (typeof spec.clean === 'function' ? spec.clean(value) : undefined),
        hint: (/** @type {TypedSpec} */ spec) => `Use ${String(spec.shape)}, or null.`,
        render: (/** @type {string} */ key, /** @type {TypedSpec} */ spec) => `${key}(null|${String(spec.shape)})`,
    }),
});

/**
 * The value type of a spec, or null when its `type` is one of the base kinds (or unknown).
 * @param {{ type?: unknown } | null | undefined} spec
 * @returns {ValueType | null}
 */
function valueTypeOf(spec) {
    const type = spec && spec.type;
    return typeof type === 'string' && Object.prototype.hasOwnProperty.call(VALUE_TYPES, type) ? VALUE_TYPES[type] : null;
}

/**
 * Is `value` already in the form clean() would store? The validator's question: canonical
 * bytes handed in directly must not carry a value the canonicalizer would have changed.
 * @param {ValueType} valueType
 * @param {unknown} value
 * @param {TypedSpec} spec
 */
function isCleanValue(valueType, value, spec) {
    if (value === undefined || value === null) return false;
    const cleaned = valueType.clean(value, spec);
    // An object or a list is clean when it cleans to the same JSON (the cleaner builds a new one),
    // whatever the order of its keys: JSONB hands a stored value back in another order.
    return cleaned === value || (typeof value === 'object' && cleaned !== undefined && sameJsonValue(cleaned, value));
}

module.exports = { VALUE_TYPES, valueTypeOf, isCleanValue, isAssetRef };

// @typecheck strict
/**
 * App Studio validator — one prop's value against its COMPONENT_SPECS field
 * spec (string caps, enums, numbers in range, bindings, formulas, lists of
 * strings and of objects). Split out of validate/nodes.js, which walks the
 * component tree and calls this per prop.
 */

'use strict';

const { LIMITS, HEX_RE, FORMULA_SCOPE_ROOTS } = require('../componentSpecs');
const { isObject } = require('./shared');
const { validateFormula } = require('./formulas');
const { validateBinding } = require('./bindings');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Per-prop value checks driven by COMPONENT_SPECS
// ---------------------------------------------------------------------------

/**
 * One field of a component spec (componentSpecs/*Specs.js), as far as this check reads it.
 * @typedef {{ type: string, required?: boolean, maxLen?: number, min?: number, max?: number, values?: unknown[],
 *   maxItems?: number, itemShape?: Record<string, ItemSpec> }} ItemSpec
 * @typedef {{ type: string, required?: boolean, default?: unknown, maxLen?: number, min?: number | null, max?: number | null,
 *   values?: unknown[], allowIsoDate?: boolean, maxItems?: number, itemMaxLen?: number,
 *   itemShape?: Record<string, ItemSpec> }} FieldSpec
 */

/** @typedef {import('./shared').ValidationCtx} Ctx */

/**
 * @param {Ctx} ctx
 * @param {string} code
 * @param {string} path
 * @param {string} message
 * @param {string} hint
 */
function err(ctx, code, path, message, hint) {
    ctx.pushE({ code, severity: 'error', path, message, hint });
}

/** @param {string} key @param {FieldSpec} fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkText(key, fs, value, path, ctx) {
    if (typeof value !== 'string') { err(ctx, 'prop.type', path, `\`${key}\` must be a string (got ${typeof value}).`, 'Pass a plain string.'); return; }
    const maxLen = fs.maxLen || LIMITS.MAX_STRING;
    if (value.length > maxLen) err(ctx, 'prop.too_long', path, `\`${key}\` is ${value.length} chars — the maximum is ${maxLen}.`, 'Shorten the text.');
    if (fs.required && !value) err(ctx, 'prop.required', path, `\`${key}\` must be a non-empty string.`, 'Provide a value.');
}

/** @param {string} key @param {FieldSpec} _fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkUrl(key, _fs, value, path, ctx) {
    if (typeof value !== 'string') { err(ctx, 'prop.type', path, `\`${key}\` must be a URL string.`, 'Pass an https:// URL.'); return; }
    let ok = false;
    try { ok = new URL(value).protocol === 'https:'; } catch { ok = false; }
    if (!ok) err(ctx, 'prop.url_invalid', path, `\`${key}\` must be a valid https:// URL (got ${JSON.stringify(value.slice(0, 80))}).`, 'Only https URLs are allowed.');
}

/** @param {string} key @param {FieldSpec} _fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkColor(key, _fs, value, path, ctx) {
    if (typeof value !== 'string' || !HEX_RE.test(value)) err(ctx, 'prop.type', path, `\`${key}\` must be a #rrggbb color.`, 'Use a 6-digit hex literal like #0F766E.');
}

/** @param {string} key @param {FieldSpec} _fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkBoolean(key, _fs, value, path, ctx) {
    if (typeof value !== 'boolean') err(ctx, 'prop.type', path, `\`${key}\` must be a boolean.`, 'Use true or false.');
}

/** @param {string} key @param {FieldSpec} fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkNumber(key, fs, value, path, ctx) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (fs.type === 'int' && !Number.isInteger(value))) {
        err(ctx, 'prop.type', path, `\`${key}\` must be ${fs.type === 'int' ? 'an integer' : 'a number'}.`, 'Pass a plain number, not a string.');
        return;
    }
    const below = fs.min !== undefined && fs.min !== null && value < fs.min;
    const above = fs.max !== undefined && fs.max !== null && value > fs.max;
    if (below || above) {
        err(ctx, 'prop.range', path, `\`${key}\` ${value} is out of range ${fs.min}..${fs.max}.`, `Use a value between ${fs.min} and ${fs.max}.`);
    }
}

/** @param {string} key @param {FieldSpec} fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkEnum(key, fs, value, path, ctx) {
    const legal = fs.values || [];
    if (legal.includes(value)) return;
    if (fs.allowIsoDate && typeof value === 'string' && ISO_DATE_RE.test(value)) return;
    err(ctx, 'prop.enum', path, `\`${key}\` ${JSON.stringify(value)} is not a legal value.`, `Use one of: ${legal.map((v) => JSON.stringify(v)).join(', ')}${fs.allowIsoDate ? ', or an ISO date (YYYY-MM-DD)' : ''}.`);
}

/** @param {string} key @param {FieldSpec} _fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkBinding(key, _fs, value, path, ctx) {
    validateBinding(key, value, path, ctx);
}

/** @param {string} _key @param {FieldSpec} _fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkFormula(_key, _fs, value, path, ctx) {
    validateFormula(value, path, ctx, FORMULA_SCOPE_ROOTS);
}

/**
 * Shared by both list types: the item cap.
 * @param {string} key @param {FieldSpec} fs @param {unknown[]} items @param {string} path @param {Ctx} ctx
 */
function checkItemCap(key, fs, items, path, ctx) {
    if (fs.maxItems && items.length > fs.maxItems) err(ctx, 'prop.too_many_items', path, `\`${key}\` has ${items.length} items — the maximum is ${fs.maxItems}.`, 'Trim the list.');
}

/** @param {string} key @param {FieldSpec} fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkStringList(key, fs, value, path, ctx) {
    if (!Array.isArray(value)) { err(ctx, 'prop.type', path, `\`${key}\` must be an array of strings.`, 'Pass a list of string values.'); return; }
    checkItemCap(key, fs, value, path, ctx);
    const maxLen = fs.itemMaxLen || LIMITS.MAX_STRING;
    value.forEach((item, i) => {
        if (typeof item !== 'string') err(ctx, 'prop.item_invalid', `${path}[${i}]`, `\`${key}\` item ${i} must be a string.`, 'Each value is a plain string.');
        else if (item.length > maxLen) err(ctx, 'prop.item_invalid', `${path}[${i}]`, `\`${key}\` item ${i} is ${item.length} chars — the maximum is ${maxLen}.`, 'Shorten it.');
    });
}

// Item fields of a `list` prop ---------------------------------------------

/** @typedef {(fk: string, fs: ItemSpec, fv: unknown, fp: string, ctx: Ctx) => void} FieldCheck */

/** @type {FieldCheck} */
function itemString(ik, ifs, iv, fp, ctx) {
    if (typeof iv !== 'string') err(ctx, 'prop.item_invalid', fp, `\`${ik}\` must be a string.`, 'Pass a plain string.');
    else if (iv.length > (ifs.maxLen || LIMITS.MAX_STRING)) err(ctx, 'prop.item_invalid', fp, `\`${ik}\` is ${iv.length} chars — the maximum is ${ifs.maxLen || LIMITS.MAX_STRING}.`, 'Shorten it.');
    else if (ifs.required && !iv) err(ctx, 'prop.item_required', fp, `\`${ik}\` must be non-empty.`, 'Fill the field.');
}

/** @type {FieldCheck} */
function itemEnum(ik, ifs, iv, fp, ctx) {
    if ((ifs.values || []).includes(iv)) return;
    err(ctx, 'prop.item_invalid', fp, `\`${ik}\` ${JSON.stringify(iv)} is not a legal value.`, `Use one of: ${(ifs.values || []).join(', ')}.`);
}

/** @type {FieldCheck} */
function itemInt(ik, ifs, iv, fp, ctx) {
    const bad = typeof iv !== 'number' || !Number.isInteger(iv) || (ifs.min !== undefined && iv < ifs.min) || (ifs.max !== undefined && iv > ifs.max);
    if (bad) {
        err(ctx, 'prop.item_invalid', fp, `\`${ik}\` must be an integer${ifs.min !== undefined ? ` ${ifs.min}..${ifs.max}` : ''}.`, 'Pass a plain integer.');
    }
}

/** @type {FieldCheck} */
function itemBoolean(ik, _ifs, iv, fp, ctx) {
    if (typeof iv !== 'boolean') err(ctx, 'prop.item_invalid', fp, `\`${ik}\` must be a boolean.`, 'Use true or false.');
}

/** Field of a nested (second level) item: strings and enums only. @type {FieldCheck} */
function subField(sk, sfs, sv, sp, ctx) {
    if (sfs.type === 'string' && typeof sv !== 'string') {
        err(ctx, 'prop.item_invalid', sp, `\`${sk}\` must be a string.`, 'Pass a plain string.');
    } else if (sfs.type === 'enum' && !(sfs.values || []).includes(sv)) {
        err(ctx, 'prop.item_invalid', sp, `\`${sk}\` ${JSON.stringify(sv)} is not a legal value.`, `Use one of: ${(sfs.values || []).join(', ')}.`);
    }
}

/**
 * One item of a list: must be an object, each shape field present when required
 * and checked by `checkField`.
 * @param {{ key: string, i: number, ip: string }} pos the list key, the item index and the item path
 * @param {unknown} item
 * @param {Record<string, ItemSpec>} shape
 * @param {FieldCheck} checkField
 * @param {Ctx} ctx
 */
function walkItemFields(pos, item, shape, checkField, ctx) {
    const { key, i, ip } = pos;
    if (!isObject(item)) { err(ctx, 'prop.item_invalid', ip, `\`${key}\` item ${i} must be an object.`, `Each item needs: ${Object.keys(shape).join(', ')}.`); return; }
    for (const [ik, ifs] of Object.entries(shape)) {
        const iv = /** @type {Record<string, unknown>} */ (item)[ik];
        if (iv === undefined || iv === null) {
            if (ifs.required) err(ctx, 'prop.item_required', `${ip}.${ik}`, `\`${key}\` item ${i} is missing required \`${ik}\`.`, 'Fill the field.');
            continue;
        }
        checkField(ik, ifs, iv, `${ip}.${ik}`, ctx);
    }
}

/**
 * ONE level of nesting, and only one. A data_grid column
 * carries its own value→tone map, which is a list inside
 * a list; without this branch the whole map fell through
 * unchecked, so a typo'd tone reached the runtime and
 * silently rendered grey. Deeper nesting is not a shape
 * this schema language should grow — if a prop needs it,
 * it wants to be a component, not a column field.
 * @type {FieldCheck}
 */
function itemNestedList(ik, ifs, iv, fp, ctx) {
    if (!Array.isArray(iv)) {
        err(ctx, 'prop.item_invalid', fp, `\`${ik}\` must be an array.`, 'Pass a list of objects.');
    } else if (ifs.maxItems && iv.length > ifs.maxItems) {
        err(ctx, 'prop.too_many_items', fp, `\`${ik}\` has ${iv.length} items — the maximum is ${ifs.maxItems}.`, 'Trim the list.');
    } else {
        iv.forEach((sub, si) => {
            walkItemFields({ key: ik, i: si, ip: `${fp}[${si}]` }, sub, ifs.itemShape || {}, subField, ctx);
        });
    }
}

/** @type {Record<string, FieldCheck>} */
const ITEM_FIELD_CHECKS = {
    string: itemString,
    enum: itemEnum,
    int: itemInt,
    boolean: itemBoolean,
    list: itemNestedList,
};

/** @type {FieldCheck} */
function itemField(ik, ifs, iv, fp, ctx) {
    const check = Object.hasOwn(ITEM_FIELD_CHECKS, ifs.type) ? ITEM_FIELD_CHECKS[ifs.type] : undefined;
    if (check) check(ik, ifs, iv, fp, ctx);
}

/** @param {string} key @param {FieldSpec} fs @param {unknown} value @param {string} path @param {Ctx} ctx */
function checkList(key, fs, value, path, ctx) {
    const shape = fs.itemShape || {};
    if (!Array.isArray(value)) { err(ctx, 'prop.type', path, `\`${key}\` must be an array.`, 'Pass a list of objects.'); return; }
    checkItemCap(key, fs, value, path, ctx);
    value.forEach((item, i) => {
        const ip = `${path}[${i}]`;
        walkItemFields({ key, i, ip }, item, shape, itemField, ctx);
        if (!isObject(item)) return;
        const extra = Object.keys(item).filter((k) => !(k in shape));
        if (extra.length) ctx.pushW({ code: 'prop.item_unknown_key', severity: 'warning', path: ip, message: `\`${key}\` item ${i} has unknown keys: ${extra.join(', ')} — the renderer ignores them.`, hint: `Legal item keys: ${Object.keys(shape).join(', ')}.` });
    });
}

/** @typedef {(key: string, fs: FieldSpec, value: unknown, path: string, ctx: Ctx) => void} PropCheck */

/** @type {Record<string, PropCheck>} */
const PROP_CHECKS = {
    string: checkText,
    markdown: checkText,
    icon: checkText,
    url: checkUrl,
    color: checkColor,
    boolean: checkBoolean,
    int: checkNumber,
    number: checkNumber,
    enum: checkEnum,
    binding: checkBinding,
    formula: checkFormula,
    stringList: checkStringList,
    list: checkList,
};

/**
 * @param {string} key
 * @param {FieldSpec} fs
 * @param {unknown} value
 * @param {string} path
 * @param {Ctx} ctx
 */
function validatePropValue(key, fs, value, path, ctx) {
    if (value === undefined || value === null) {
        if (fs.required) err(ctx, 'prop.required', path, `Missing required prop \`${key}\`.`, `Provide a ${fs.type} value${fs.default !== undefined && fs.default !== null ? ` (spec default: ${JSON.stringify(fs.default)})` : ''}.`);
        return;
    }
    const check = Object.hasOwn(PROP_CHECKS, fs.type) ? PROP_CHECKS[fs.type] : undefined;
    if (check) check(key, fs, value, path, ctx);
}

module.exports = { validatePropValue };

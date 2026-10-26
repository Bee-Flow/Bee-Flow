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

/**
 * @param {string} key
 * @param {FieldSpec} fs
 * @param {unknown} value
 * @param {string} path
 * @param {import('./shared').ValidationCtx} ctx
 */
function validatePropValue(key, fs, value, path, ctx) {
    const { pushE, pushW } = ctx;

    if (value === undefined || value === null) {
        if (fs.required) pushE({ code: 'prop.required', severity: 'error', path, message: `Missing required prop \`${key}\`.`, hint: `Provide a ${fs.type} value${fs.default !== undefined && fs.default !== null ? ` (spec default: ${JSON.stringify(fs.default)})` : ''}.` });
        return;
    }

    switch (fs.type) {
        case 'string':
        case 'markdown':
        case 'icon': {
            if (typeof value !== 'string') { pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be a string (got ${typeof value}).`, hint: 'Pass a plain string.' }); return; }
            const maxLen = fs.maxLen || LIMITS.MAX_STRING;
            if (value.length > maxLen) pushE({ code: 'prop.too_long', severity: 'error', path, message: `\`${key}\` is ${value.length} chars — the maximum is ${maxLen}.`, hint: 'Shorten the text.' });
            if (fs.required && !value) pushE({ code: 'prop.required', severity: 'error', path, message: `\`${key}\` must be a non-empty string.`, hint: 'Provide a value.' });
            return;
        }
        case 'url': {
            if (typeof value !== 'string') { pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be a URL string.`, hint: 'Pass an https:// URL.' }); return; }
            let ok = false;
            try { ok = new URL(value).protocol === 'https:'; } catch { ok = false; }
            if (!ok) pushE({ code: 'prop.url_invalid', severity: 'error', path, message: `\`${key}\` must be a valid https:// URL (got ${JSON.stringify(value.slice(0, 80))}).`, hint: 'Only https URLs are allowed.' });
            return;
        }
        case 'color': {
            if (typeof value !== 'string' || !HEX_RE.test(value)) pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be a #rrggbb color.`, hint: 'Use a 6-digit hex literal like #0F766E.' });
            return;
        }
        case 'boolean': {
            if (typeof value !== 'boolean') pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be a boolean.`, hint: 'Use true or false.' });
            return;
        }
        case 'int':
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value) || (fs.type === 'int' && !Number.isInteger(value))) {
                pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be ${fs.type === 'int' ? 'an integer' : 'a number'}.`, hint: 'Pass a plain number, not a string.' });
                return;
            }
            if ((fs.min !== undefined && fs.min !== null && value < fs.min) || (fs.max !== undefined && fs.max !== null && value > fs.max)) {
                pushE({ code: 'prop.range', severity: 'error', path, message: `\`${key}\` ${value} is out of range ${fs.min}..${fs.max}.`, hint: `Use a value between ${fs.min} and ${fs.max}.` });
            }
            return;
        }
        case 'enum': {
            const legal = fs.values || [];
            if (legal.includes(value)) return;
            if (fs.allowIsoDate && typeof value === 'string' && ISO_DATE_RE.test(value)) return;
            pushE({ code: 'prop.enum', severity: 'error', path, message: `\`${key}\` ${JSON.stringify(value)} is not a legal value.`, hint: `Use one of: ${legal.map((v) => JSON.stringify(v)).join(', ')}${fs.allowIsoDate ? ', or an ISO date (YYYY-MM-DD)' : ''}.` });
            return;
        }
        case 'binding':
            validateBinding(key, value, path, ctx);
            return;
        case 'formula': {
            validateFormula(value, path, ctx, FORMULA_SCOPE_ROOTS);
            return;
        }
        case 'stringList': {
            if (!Array.isArray(value)) { pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be an array of strings.`, hint: 'Pass a list of string values.' }); return; }
            if (fs.maxItems && value.length > fs.maxItems) pushE({ code: 'prop.too_many_items', severity: 'error', path, message: `\`${key}\` has ${value.length} items — the maximum is ${fs.maxItems}.`, hint: 'Trim the list.' });
            value.forEach((item, i) => {
                if (typeof item !== 'string') pushE({ code: 'prop.item_invalid', severity: 'error', path: `${path}[${i}]`, message: `\`${key}\` item ${i} must be a string.`, hint: 'Each value is a plain string.' });
                else if (item.length > (fs.itemMaxLen || LIMITS.MAX_STRING)) pushE({ code: 'prop.item_invalid', severity: 'error', path: `${path}[${i}]`, message: `\`${key}\` item ${i} is ${item.length} chars — the maximum is ${fs.itemMaxLen || LIMITS.MAX_STRING}.`, hint: 'Shorten it.' });
            });
            return;
        }
        case 'list': {
            const shape = fs.itemShape || {};
            if (!Array.isArray(value)) { pushE({ code: 'prop.type', severity: 'error', path, message: `\`${key}\` must be an array.`, hint: 'Pass a list of objects.' }); return; }
            if (fs.maxItems && value.length > fs.maxItems) pushE({ code: 'prop.too_many_items', severity: 'error', path, message: `\`${key}\` has ${value.length} items — the maximum is ${fs.maxItems}.`, hint: 'Trim the list.' });
            value.forEach((item, i) => {
                const ip = `${path}[${i}]`;
                if (!isObject(item)) { pushE({ code: 'prop.item_invalid', severity: 'error', path: ip, message: `\`${key}\` item ${i} must be an object.`, hint: `Each item needs: ${Object.keys(shape).join(', ')}.` }); return; }
                for (const [ik, ifs] of Object.entries(shape)) {
                    const iv = item[ik];
                    if (iv === undefined || iv === null) {
                        if (ifs.required) pushE({ code: 'prop.item_required', severity: 'error', path: `${ip}.${ik}`, message: `\`${key}\` item ${i} is missing required \`${ik}\`.`, hint: 'Fill the field.' });
                        continue;
                    }
                    if (ifs.type === 'string') {
                        if (typeof iv !== 'string') pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be a string.`, hint: 'Pass a plain string.' });
                        else if (iv.length > (ifs.maxLen || LIMITS.MAX_STRING)) pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` is ${iv.length} chars — the maximum is ${ifs.maxLen || LIMITS.MAX_STRING}.`, hint: 'Shorten it.' });
                        else if (ifs.required && !iv) pushE({ code: 'prop.item_required', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be non-empty.`, hint: 'Fill the field.' });
                    } else if (ifs.type === 'enum' && !(ifs.values || []).includes(iv)) {
                        pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` ${JSON.stringify(iv)} is not a legal value.`, hint: `Use one of: ${(ifs.values || []).join(', ')}.` });
                    } else if (ifs.type === 'int') {
                        if (typeof iv !== 'number' || !Number.isInteger(iv) || (ifs.min !== undefined && iv < ifs.min) || (ifs.max !== undefined && iv > ifs.max)) {
                            pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be an integer${ifs.min !== undefined ? ` ${ifs.min}..${ifs.max}` : ''}.`, hint: 'Pass a plain integer.' });
                        }
                    } else if (ifs.type === 'boolean' && typeof iv !== 'boolean') {
                        pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be a boolean.`, hint: 'Use true or false.' });
                    } else if (ifs.type === 'list') {
                        // ONE level of nesting, and only one. A data_grid column
                        // carries its own value→tone map, which is a list inside
                        // a list; without this branch the whole map fell through
                        // unchecked, so a typo'd tone reached the runtime and
                        // silently rendered grey. Deeper nesting is not a shape
                        // this schema language should grow — if a prop needs it,
                        // it wants to be a component, not a column field.
                        if (!Array.isArray(iv)) {
                            pushE({ code: 'prop.item_invalid', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` must be an array.`, hint: 'Pass a list of objects.' });
                        } else if (ifs.maxItems && iv.length > ifs.maxItems) {
                            pushE({ code: 'prop.too_many_items', severity: 'error', path: `${ip}.${ik}`, message: `\`${ik}\` has ${iv.length} items — the maximum is ${ifs.maxItems}.`, hint: 'Trim the list.' });
                        } else {
                            iv.forEach((sub, si) => {
                                const sp = `${ip}.${ik}[${si}]`;
                                if (!isObject(sub)) { pushE({ code: 'prop.item_invalid', severity: 'error', path: sp, message: `\`${ik}\` item ${si} must be an object.`, hint: `Each item needs: ${Object.keys(ifs.itemShape || {}).join(', ')}.` }); return; }
                                for (const [sk, sfs] of Object.entries(ifs.itemShape || {})) {
                                    const sv = sub[sk];
                                    if (sv === undefined || sv === null) {
                                        if (sfs.required) pushE({ code: 'prop.item_required', severity: 'error', path: `${sp}.${sk}`, message: `\`${ik}\` item ${si} is missing required \`${sk}\`.`, hint: 'Fill the field.' });
                                        continue;
                                    }
                                    if (sfs.type === 'string' && typeof sv !== 'string') {
                                        pushE({ code: 'prop.item_invalid', severity: 'error', path: `${sp}.${sk}`, message: `\`${sk}\` must be a string.`, hint: 'Pass a plain string.' });
                                    } else if (sfs.type === 'enum' && !(sfs.values || []).includes(sv)) {
                                        pushE({ code: 'prop.item_invalid', severity: 'error', path: `${sp}.${sk}`, message: `\`${sk}\` ${JSON.stringify(sv)} is not a legal value.`, hint: `Use one of: ${(sfs.values || []).join(', ')}.` });
                                    }
                                }
                            });
                        }
                    }
                }
                const extra = Object.keys(item).filter((k) => !(k in shape));
                if (extra.length) pushW({ code: 'prop.item_unknown_key', severity: 'warning', path: ip, message: `\`${key}\` item ${i} has unknown keys: ${extra.join(', ')} — the renderer ignores them.`, hint: `Legal item keys: ${Object.keys(shape).join(', ')}.` });
            });
            return;
        }
        default:
            return;
    }
}

module.exports = { validatePropValue };

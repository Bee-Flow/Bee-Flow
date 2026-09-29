/**
 * App Studio canonicalizer — a component's props, cleaned against its spec.
 */

'use strict';

const { LIMITS } = require('../componentSpecs');
const { isObject, deepCopy, truncate } = require('./shared');
const { cleanBinding } = require('./bindings');

// ---------------------------------------------------------------------------
// Props — spec-driven: unknown keys dropped, missing filled from defaults,
// strings truncated, numeric strings coerced, bindings wrapped.
// ---------------------------------------------------------------------------

const STRINGISH_TYPES = new Set(['string', 'markdown', 'icon', 'url', 'color']);

function cleanPropValue(fs, raw, path, push) {
    if (STRINGISH_TYPES.has(fs.type)) {
        if (typeof raw === 'string') return truncate(raw, fs.maxLen || LIMITS.MAX_STRING, path, push);
        return deepCopy(raw); // wrong types left for validate.js
    }
    if (fs.type === 'int' || fs.type === 'number') {
        if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
            push('props.coerced', path, `Coerced numeric string ${JSON.stringify(raw)} to ${Number(raw)}.`);
            return Number(raw);
        }
        return deepCopy(raw); // range checks are validate.js's job for props
    }
    if (fs.type === 'binding') {
        // A binding prop whose SPEC DEFAULT is null uses null to mean "not
        // bound" (kanban columnsSource/swimlanesSource): validate.js accepts
        // null for any optional prop, and cleanProps emits the default
        // verbatim when the key is absent. That null must round-trip
        // unchanged — wrapping it as {kind:'static',value:null} would make
        // the second canonicalize pass differ from the first (idempotence
        // break). Props whose default IS a binding object keep the wrap:
        // their canonical form never contains a bare null.
        if (raw === null && fs.default === null) return null;
        return cleanBinding(raw, path, push);
    }
    if (fs.type === 'formula') {
        if (typeof raw === 'string') return truncate(raw, LIMITS.MAX_FORMULA_LEN, path, push);
        return deepCopy(raw); // wrong type left for validate.js (compile-check)
    }
    if (fs.type === 'stringList') {
        if (!Array.isArray(raw)) {
            push('props.invalid', path, 'Expected an array of strings — reset to the default.');
            return deepCopy(fs.default);
        }
        return raw.map((x, i) => (typeof x === 'string' ? truncate(x, fs.itemMaxLen || LIMITS.MAX_STRING, `${path}[${i}]`, push) : deepCopy(x)));
    }
    if (fs.type === 'list') {
        if (!Array.isArray(raw)) {
            push('props.invalid', path, 'Expected an array — reset to the default.');
            return deepCopy(fs.default);
        }
        // Items pass through (validate.js checks itemShape) but string fields
        // still honour the global truncation rule.
        return raw.map((item, i) => {
            if (!isObject(item)) return deepCopy(item);
            const out = {};
            for (const [k, v] of Object.entries(item)) {
                const shape = fs.itemShape && fs.itemShape[k];
                out[k] = (shape && typeof v === 'string')
                    ? truncate(v, shape.maxLen || LIMITS.MAX_STRING, `${path}[${i}].${k}`, push)
                    : deepCopy(v);
            }
            return out;
        });
    }
    // boolean / enum — validate.js flags wrong values.
    return deepCopy(raw);
}

function cleanProps(node, spec, id, path, push) {
    let provided = node.props;
    if (provided !== undefined && !isObject(provided)) {
        push('props.invalid', `${path}.props`, 'props must be an object — rebuilt from defaults.');
        provided = {};
    }
    provided = provided || {};
    const props = {};
    const filled = [];
    for (const [key, fs] of Object.entries(spec.props)) {
        if (key in provided) {
            props[key] = cleanPropValue(fs, provided[key], `${path}.props.${key}`, push);
        } else {
            props[key] = deepCopy(fs.default === undefined ? null : fs.default);
            filled.push(key);
        }
    }
    const unknown = Object.keys(provided).filter((k) => !(k in spec.props));
    if (unknown.length) {
        const legal = Object.keys(spec.props);
        push('props.unknown_key', `${path}.props`, `Dropped unknown prop keys: ${unknown.join(', ')}. Legal keys for ${node.type}: ${legal.length ? legal.join(', ') : '(none)'}.`);
    }
    // Forms must have a name so field mappings can target them.
    if (node.type === 'form' && (typeof props.name !== 'string' || !props.name)) {
        props.name = 'frm_' + (id.split('_')[1] || id);
        push('form.name_defaulted', `${path}.props.name`, `Form name missing — defaulted to "${props.name}".`);
        const i = filled.indexOf('name');
        if (i !== -1) filled.splice(i, 1);
    }
    if (filled.length) {
        push('props.defaulted', `${path}.props`, `Filled missing props from spec defaults: ${filled.join(', ')}.`);
    }
    return props;
}

module.exports = { cleanPropValue, cleanProps };

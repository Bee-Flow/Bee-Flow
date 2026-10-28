// @typecheck
'use strict';

/**
 * The reliability settings of an ai_step as the validator reads them: the
 * temperature, the lists of allowed values (enumFrom), the checks run after
 * the answer, and the fallback. The shape rules live in
 * core/automationModel/aiStepReliability.js (one definition for the validator,
 * the builder and the runner); this file maps those problems onto findings and
 * adds what only the whole step can tell:
 *
 *   - a field a check names has to be a field of the declared output;
 *   - a list of allowed values is text, so the field should be text;
 *   - a reference that reads `loop.` needs a loop around it;
 *   - a fallback fills fields the answer actually has;
 *   - a high temperature makes the answer vary between runs.
 *
 * Tools do not make any of it an error: the checks still apply to a step that
 * may call tools. The references themselves (a deleted or later step) are
 * scoped like every other binding (refSurfaces.js -> referenceScoping.js).
 */

const { isObject } = require('../helpers');
const { reliabilityProblems, parseFieldPath } = require('../../../core/automationModel/aiStepReliability');

const MAX_FIELDS_SHOWN = 12;
const HIGH_TEMPERATURE = 1;

/**
 * The declared top-level fields of an output schema, or null when the step
 * declares none. Both shapes the builder writes are read: a JSON Schema
 * ({type:'object', properties}) and the flat {name:'string'} map.
 * @param {any} schema
 * @returns {Record<string, any> | null}
 */
function declaredFields(schema) {
    if (!isObject(schema)) return null;
    const props = isObject(schema.properties) ? schema.properties : (schema.type === 'object' ? {} : schema);
    return Object.keys(props).length ? props : null;
}

/** The declared type of one schema node: 'string', 'number', 'array', ... or null when unknown. @param {any} node */
function typeOfNode(node) {
    if (typeof node === 'string') return node;
    if (isObject(node) && typeof node.type === 'string') return node.type;
    if (isObject(node) && Array.isArray(node.type)) {
        const real = node.type.filter((t) => t !== 'null');
        return real.length === 1 && typeof real[0] === 'string' ? real[0] : null;
    }
    return null;
}

/**
 * The declared type of the field a path points at, or null when the schema
 * does not say (a nested object without properties, a list without items).
 * @param {Record<string, any>} props @param {Array<{ name: string, each: boolean }>} segments
 */
function leafType(props, segments) {
    let node = props[segments[0].name];
    for (let i = 0; i < segments.length; i++) {
        if (node === undefined || node === null) return null;
        if (segments[i].each) {
            if (typeOfNode(node) !== 'array' || !isObject(node.items)) return null;
            node = node.items;
        }
        if (i + 1 < segments.length) node = isObject(node) && isObject(node.properties) ? node.properties[segments[i + 1].name] : null;
    }
    return typeOfNode(node);
}

/** Every field path the step's lists and checks name, with where it sits. @param {import('../helpers').StepDef} step */
function namedFields(step) {
    const out = [];
    (Array.isArray(step.enumFrom) ? step.enumFrom : []).forEach((e, i) => {
        if (isObject(e)) out.push({ field: e.field, path: `enumFrom[${i}].field`, enumeration: true });
    });
    (Array.isArray(step.checks) ? step.checks : []).forEach((c, i) => {
        if (isObject(c)) out.push({ field: c.field, path: `checks[${i}].field`, enumeration: false });
    });
    return out;
}

/** Every run path the step's lists and checks read, with where it sits. @param {import('../helpers').StepDef} step */
function namedRefs(step) {
    const out = [];
    (Array.isArray(step.enumFrom) ? step.enumFrom : []).forEach((e, i) => {
        if (isObject(e)) out.push({ ref: e.ref, path: `enumFrom[${i}].ref` });
    });
    (Array.isArray(step.checks) ? step.checks : []).forEach((c, i) => {
        if (!isObject(c)) return;
        out.push({ ref: c.ref, path: `checks[${i}].ref` });
        out.push({ ref: c.sameCountAs, path: `checks[${i}].sameCountAs` });
    });
    return out.filter((r) => typeof r.ref === 'string' && r.ref.trim());
}

/**
 * @param {string} at
 */
function checkAiStepReliability(ctx, step, at) {
    if (step.type !== 'ai_step') return;
    const { pushE, pushW } = ctx;

    for (const p of reliabilityProblems(step)) {
        (p.severity === 'error' ? pushE : pushW)({
            code: p.code, severity: p.severity, path: `${at}.${p.path}`, message: `Step ${step.id}: ${p.message}`, hint: p.hint,
        });
    }

    if (typeof step.temperature === 'number' && step.temperature > HIGH_TEMPERATURE) {
        pushW({
            code: 'ai_step.temperature_high', severity: 'warning', path: `${at}.temperature`,
            message: `Step ${step.id}: with a temperature above ${HIGH_TEMPERATURE} the answers vary more between runs.`,
            hint: 'Keep it at 1 or lower for classification, extraction and anything a later step relies on; raise it for creative writing.',
        });
    }

    const named = namedFields(step);
    const declared = declaredFields(step.outputSchema);
    if (named.length && !declared) {
        pushW({
            code: 'ai_step.checks_without_schema', severity: 'warning', path: `${at}.outputSchema`,
            message: `Step ${step.id}: checks need named output fields, and this step declares none, so they cannot find what to look at.`,
            hint: 'Give the step a Structured output with the fields the checks name (for example {"type":"object","properties":{"category":{"type":"string"}}}).',
        });
    }
    if (declared) {
        const available = Object.keys(declared);
        const list = `${available.slice(0, MAX_FIELDS_SHOWN).join(', ')}${available.length > MAX_FIELDS_SHOWN ? ', …' : ''}`;
        for (const n of named) {
            const parsed = parseFieldPath(n.field);
            if (!parsed) continue;
            if (!Object.prototype.hasOwnProperty.call(declared, parsed.segments[0].name)) {
                pushW({
                    code: 'ai_step.check_field_unknown', severity: 'warning', path: `${at}.${n.path}`,
                    message: `Step ${step.id}: ${n.path.replace(/\.field$/, '')} looks at "${parsed.segments[0].name}", which is not a field of this step's output (it has: ${list}).`,
                    hint: 'Pick a field from the step\'s Structured output.',
                });
            } else if (n.enumeration) {
                const type = leafType(declared, parsed.segments);
                if (type && type !== 'string') {
                    pushW({
                        code: 'ai_step.enum_from_type', severity: 'warning', path: `${at}.${n.path}`,
                        message: `Step ${step.id}: ${n.path.replace(/\.field$/, '')} offers a list of allowed values for "${n.field}", but that field is declared as ${type}, not text.`,
                        hint: 'Allowed values are text. Declare the field as a string, or check it another way.',
                    });
                }
            }
        }
    }

    const fallback = isObject(step.fallback) && step.fallback.kind === 'value' && isObject(step.fallback.fields) ? step.fallback.fields : null;
    if (fallback && declared) {
        for (const name of Object.keys(fallback)) {
            if (Object.prototype.hasOwnProperty.call(declared, name)) continue;
            pushW({
                code: 'ai_step.fallback_field_unknown', severity: 'warning', path: `${at}.fallback.fields.${name}`,
                message: `Step ${step.id}: the fallback fills "${name}", which is not a field of this step's output, so no later step can read it as part of the answer.`,
                hint: `Use the fields of the Structured output${available(declared)}.`,
            });
        }
    }

    // The fallback values are the WHOLE answer (aiStepRepair.applyFallback): a
    // declared field it leaves out is undefined for every later step.
    if (fallback && declared) {
        const missing = Object.keys(declared).filter((name) => !Object.prototype.hasOwnProperty.call(fallback, name));
        if (missing.length) {
            pushW({
                code: 'ai_step.fallback_fields_missing', severity: 'warning', path: `${at}.fallback.fields`,
                message: `Step ${step.id}: the fallback values replace the whole answer, but they leave out ${missing.slice(0, MAX_FIELDS_SHOWN).map((n) => `"${n}"`).join(', ')}${missing.length > MAX_FIELDS_SHOWN ? ', …' : ''}, so later steps that read it get nothing.`,
                hint: 'Add a value for every field of the Structured output that a later step reads (an empty text is fine).',
            });
        }
    }

    // `loop.` is bound by this step's own forEach or by a loop around it. The
    // reference check reports a loop variable nothing binds; this is the plain
    // sentence for the common slip of reading `loop.` with no loop at all.
    const insideLoop = typeof ctx.isInsideLoop === 'function'
        ? ctx.isInsideLoop(step)
        : ((ctx.loopVarsAbove && ctx.loopVarsAbove.get(step)) || []).length > 0;
    if (!isObject(step.forEach) && !insideLoop) {
        for (const r of namedRefs(step)) {
            if (!/^loop(?:[.[]|$)/.test(r.ref.trim())) continue;
            pushW({
                code: 'ai_step.loop_ref_unbound', severity: 'warning', path: `${at}.${r.path}`,
                message: `Step ${step.id}: ${r.path} reads "${r.ref.trim()}", but this step does not run once per item and is not inside a loop, so there is no loop here.`,
                hint: 'Read the list from an earlier step (steps.<id>.output.<list>), or run this step once per item.',
            });
        }
    }
}

/** ` (it has: a, b)` for a hint. @param {Record<string, any>} declared */
function available(declared) {
    const names = Object.keys(declared);
    return ` (${names.slice(0, MAX_FIELDS_SHOWN).join(', ')}${names.length > MAX_FIELDS_SHOWN ? ', …' : ''})`;
}

module.exports = { checkAiStepReliability, declaredFields };

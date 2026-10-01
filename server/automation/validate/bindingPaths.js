/**
 * What the shared core's binding checks (shared/mapping/validate.mjs) need
 * from the server: the fields a source is known to produce, and the paths an
 * expression reads.
 *
 * `fieldsOf(source)` answers a list of field names only where the list is
 * COMPLETE enough to call a miss a miss, and null everywhere else, because an
 * unknown_field warning on a field that does exist is worse than none:
 *   - the trigger payload: an app_event trigger's declared fields, plus the
 *     keys of its catalog sample and the enriched keys the producer adds
 *     (triggerBlock.js extraFields), for every trigger of the graph; null as
 *     soon as one trigger is not an app_event (a webhook body, a form, a
 *     manual run: anything can arrive);
 *   - an ai_step's output, when it declares an object outputSchema;
 *   - a set step's output in single mode: exactly its field names.
 * A step that runs once per item (forEach) outputs the fan-out envelope, so
 * it is not known here.
 */

const { parseExpr } = require('../expr');
const { formatSegment, RUNTIME_ROOTS } = require('../../shared/mapping/index.mjs');
const { isObject } = require('./helpers');

/** 'attachments[{attachmentId, filename}]' → 'attachments'; 'resourceData.id' → 'resourceData'. */
function topKey(name) {
    const m = /^[A-Za-z_$][\w$]*/.exec(String(name));
    return m ? m[0] : null;
}

function appEventFields(trigger) {
    if (!isObject(trigger) || trigger.kind !== 'app_event') return null;
    const provider = trigger.appEvent?.provider;
    const event = trigger.appEvent?.event;
    // Required lazily: the trigger catalog loads every integration's
    // declaration, which the validator should not pay for at require time.
    const { getEventDef } = require('../triggerSources');
    const def = getEventDef(provider, event);
    if (!def) return null;
    const { TRIGGER_PROMPT_NOTES } = require('../builderPrompt/triggerBlock');
    const notes = TRIGGER_PROMPT_NOTES[`${provider}.${event}`];
    const names = [
        ...(Array.isArray(def.fields) ? def.fields : []),
        ...Object.keys(isObject(def.sample) ? def.sample : {}),
        ...(Array.isArray(notes?.extraFields) ? notes.extraFields : []),
    ].map(topKey).filter(Boolean);
    return names.length ? [...new Set(names)] : null;
}

function aiStepFields(step) {
    const schema = step.outputSchema;
    if (!isObject(schema)) return null;
    if (schema.type === 'object' && isObject(schema.properties)) {
        if (schema.additionalProperties === true) return null;
        return Object.keys(schema.properties);
    }
    // The shorthand the builder writes: { field: 'string', … }.
    if (schema.type === undefined && Object.values(schema).every(v => typeof v === 'string')) return Object.keys(schema);
    return null;
}

/**
 * Build `fieldsOf` for one graph.
 * @param {object} graph — the definition (or layer) being validated
 * @param {Map<string, object>} stepsById
 */
function createFieldsOf(graph, stepsById) {
    let triggerFields;
    const triggerKnown = () => {
        if (triggerFields !== undefined) return triggerFields;
        const triggers = [graph?.trigger, ...(Array.isArray(graph?.triggers) ? graph.triggers : [])].filter(Boolean);
        const lists = triggers.map(appEventFields);
        triggerFields = lists.length && lists.every(Boolean) ? [...new Set(lists.flat())] : null;
        return triggerFields;
    };
    return (source) => {
        if (!source) return null;
        if (source.root === 'trigger') return triggerKnown();
        if (source.root !== 'steps') return null;
        const step = stepsById.get(source.id);
        // A step that runs once per item outputs the fan-out envelope
        // ({ iterations, results, … }), not its own fields.
        if (!step || step.forEach || step.repeat) return null;
        if (step.type === 'ai_step') return aiStepFields(step);
        if (step.type === 'set' && typeof step.arrayRef !== 'string' && isObject(step.fields)) {
            const names = Object.keys(step.fields);
            return names.length ? names : null;
        }
        return null;
    };
}

/** One path node of the expression tree as a legacy path, cut at the first computed index. */
function pathNodeText(node) {
    const [head, ...rest] = node.segments;
    if (!head || head.kind !== 'name') return null;
    let out = head.v;
    for (const seg of rest) {
        let piece = null;
        if (seg.kind === 'name') piece = formatSegment(seg.v);
        else if (seg.kind === 'wildcard') piece = '[*]';
        else if (seg.kind === 'index' && seg.expr?.kind === 'num') piece = formatSegment(seg.expr.v);
        else if (seg.kind === 'index' && seg.expr?.kind === 'str') piece = formatSegment(seg.expr.v);
        if (piece === null) break;
        out += piece;
    }
    return out;
}

/**
 * The run-state paths an expression reads (roots trigger/steps/vars/loop/
 * secrets only; `item`, `now` and the like are someone else's scope). An
 * expression that does not parse reads nothing here: its parse error is the
 * expression rules' to report.
 * @param {string} src
 * @returns {string[]}
 */
function exprPaths(src) {
    let ast;
    try { ast = parseExpr(String(src)); } catch { return []; }
    const out = [];
    const walk = (n, depth = 0) => {
        if (!n || typeof n !== 'object' || depth > 64) return;
        if (n.kind === 'path') {
            const text = pathNodeText(n);
            if (text && RUNTIME_ROOTS.includes(n.segments[0].v)) out.push(text);
            for (const seg of n.segments) if (seg.kind === 'index') walk(seg.expr, depth + 1);
            return;
        }
        for (const key of ['a', 'b', 'cond']) walk(n[key], depth + 1);
        if (Array.isArray(n.args)) for (const a of n.args) walk(a, depth + 1);
    };
    walk(ast);
    return out;
}

module.exports = { createFieldsOf, exprPaths };

/**
 * builder_inline_layer: fold a flowlet (definition.layers[<key>]) into the flow
 * that calls it, in place of the call_layer step.
 *
 * Why it exists: an approved plan often says "inline the flowlet" (the call
 * hides data the user wants to see on the canvas), and the only tools were
 * add + remove, which mint new ids and break every binding downstream. Here the
 * steps move over with fresh ids, and the two seams are rewritten:
 *
 *   - INSIDE the moved steps, `trigger.output.<param>` (what the caller passed)
 *     becomes the binding the call_layer step gave that param;
 *   - OUTSIDE, `steps.<callId>.output.<field>` (what the flowlet returned)
 *     becomes the binding the flowlet's Return step held for that field.
 *
 * A seam that cannot be rewritten without guessing (a Return field that is a
 * template read through `.x`, an expression that reads the call, a reference
 * spelled in a form this does not read) REFUSES the whole call and says why;
 * nothing changes. All work happens on copies and is committed at the end.
 */

'use strict';

const { scanTemplate } = require('../expr');
const { rekeyDefinition } = require('../portability');
const { collectCallLayerSteps } = require('../validate');
const { findStepAnywhere } = require('./draftGraph');
const { findDanglingRefs } = require('./stepEditing');

const BINDING_KINDS = new Set(['literal', 'ref', 'template', 'expr']);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Thrown inside the walk; turned into a refusal by applyInlineLayer. */
class Unmappable extends Error {}

/**
 * A path head and what it stands for: `head` ("trigger.output" or
 * "steps.<callId>.output") followed by one field; `lookup(field)` is the
 * binding that field resolves to, or null when there is none.
 */
function seam(head, lookup, what) {
    const rx = new RegExp(`^(\\s*)${escapeRegExp(head)}\\.([A-Za-z_][A-Za-z0-9_]*)((?:[.\\[][\\s\\S]*)?)(\\s*)$`);
    const resolve = (m) => {
        const binding = lookup(m[2]);
        if (!binding) throw new Unmappable(`${what} "${m[2]}" has no binding to take its place`);
        return binding;
    };
    return {
        /** A bare path or placeholder body → the new path text, or null when it is not this seam. */
        path(text) {
            const m = rx.exec(text);
            if (!m) return null;
            const binding = resolve(m);
            if (binding.kind !== 'ref' || typeof binding.path !== 'string') {
                throw new Unmappable(`${what} "${m[2]}" is a ${binding.kind} binding, which cannot stand inside a path or a template`);
            }
            return `${m[1]}${binding.path}${m[3]}${m[4]}`;
        },
        /** A whole {kind:'ref'} binding → the binding that replaces it, or null when it is not this seam. */
        binding(ref) {
            const m = rx.exec(ref.path);
            if (!m) return null;
            const binding = resolve(m);
            if (binding.kind === 'ref' && typeof binding.path === 'string') return { ...binding, path: `${binding.path}${m[3]}` };
            if (m[3]) throw new Unmappable(`${what} "${m[2]}" is a ${binding.kind} binding but is read through "${m[3]}"`);
            return structuredClone(binding);
        },
    };
}

/** The text of a template with the seam's placeholders rewritten (runner-grade scanner, as stepIdRewrite). */
function rewriteTemplate(text, s) {
    if (typeof text !== 'string' || !text.includes('{{')) return text;
    let out = '';
    let last = 0;
    for (const part of scanTemplate(text)) {
        if (part.type !== 'ref') continue;
        const next = s.path(part.inner);
        if (next === null) continue;
        const lead = part.raw.indexOf(part.inner, 2);
        if (lead < 0) continue;
        out += text.slice(last, part.start) + part.raw.slice(0, lead) + next + part.raw.slice(lead + part.inner.length);
        last = part.end;
    }
    return last ? out + text.slice(last) : text;
}

/** Rewrite every occurrence of the seam inside `value`; returns the new value (objects change in place). */
function rewriteSeam(value, s) {
    if (typeof value === 'string') {
        if (value.includes('{{')) return rewriteTemplate(value, s);
        const next = s.path(value);
        return next === null ? value : next;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) value[i] = rewriteSeam(value[i], s);
        return value;
    }
    if (!isObject(value)) return value;
    if (typeof value.kind === 'string' && BINDING_KINDS.has(value.kind)) {
        if (value.kind === 'ref' && typeof value.path === 'string') {
            const replaced = s.binding(value);
            if (replaced) { for (const k of Object.keys(value)) delete value[k]; Object.assign(value, replaced); }
        } else if (value.kind === 'template' && typeof value.value === 'string') {
            value.value = rewriteTemplate(value.value, s);
        }
        return value;
    }
    for (const k of Object.keys(value)) value[k] = rewriteSeam(value[k], s);
    return value;
}

const edgeKey = (e) => `${e.from}\u0000${e.to}\u0000${e.label || ''}`;

/**
 * @param {object} graph  the flow the call_layer step lives in (the root, or the flowlet named by scope)
 * @param {object} draft  the root definition (it holds `layers`)
 * @param {{stepId: string}} args
 */
function applyInlineLayer(graph, draft, args) {
    const stepId = typeof args?.stepId === 'string' ? args.stepId : '';
    if (!stepId) return { error: 'builder_inline_layer needs stepId: the id of the call_layer step that runs the flowlet.' };
    const found = findStepAnywhere(graph, stepId);
    if (!found) return { error: `Unknown stepId "${stepId}". Read the draft for the id of the call_layer step.` };
    const call = found.step;
    if (call.type !== 'call_layer') return { error: `Step "${stepId}" is a ${call.type} step, not a call_layer step. Pass the id of the step that calls the flowlet.` };
    if (found.kind !== 'graph') return { error: `Cannot inline: "${stepId}" sits inside a loop body. Only a call_layer step on the flow itself can be inlined.` };
    const layerKey = call.layerKey;
    const layer = draft.layers?.[layerKey];
    if (!isObject(layer)) return { error: `Cannot inline: flowlet "${layerKey}" does not exist.` };
    const refuse = (why) => ({ error: `Cannot inline flowlet "${layerKey}" at "${stepId}": ${why}. Nothing changed; the flowlet and its call stay as they are.` });

    if (call.forEach) return refuse('the call runs once per item (forEach), and the moved steps would run only once');
    const outgoing = (graph.edges || []).filter(e => e && e.from === stepId);
    const incoming = (graph.edges || []).filter(e => e && e.to === stepId);
    if (outgoing.some(e => e.label === 'on_error')) return refuse('the call has an error branch, which has no single step to hang on after inlining; remove or re-wire it first');
    if (isObject(layer.vars) && Object.keys(layer.vars).length) return refuse('the flowlet declares vars, which would be lost');
    const outSteps = (layer.steps || []).filter(s => s && s.type === 'layer_output');
    if (outSteps.length !== 1) return refuse(`it has ${outSteps.length} Return (layer_output) steps; exactly one is needed to map what it returns`);
    if (!isObject(layer.trigger)) return refuse('it has no layer_input trigger');

    // Fresh ids for everything in the flowlet, internal references rewritten
    // with them (portability.rekeyDefinition: one rule for "rename a graph").
    const copy = rekeyDefinition(layer).definition;
    const trgId = copy.trigger.id;
    const out = copy.steps.find(s => s && s.type === 'layer_output');
    const moved = copy.steps.filter(s => s !== out);

    try {
        // What the caller passed: trigger.output.<param> → the call's binding.
        const inputs = isObject(call.inputs) ? call.inputs : {};
        rewriteSeam([...moved, out], seam('trigger.output', (p) => (isObject(inputs[p]) ? inputs[p] : null), 'The flowlet input'));
        // What the flowlet returned: steps.<callId>.output.<field> → its Return binding.
        const returned = isObject(out.fields) ? out.fields : {};
        const result = seam(`steps.${stepId}.output`, (f) => (isObject(returned[f]) ? returned[f] : null), 'The flowlet return field');

        // The moved steps may still read their own trigger in a form the seam
        // does not understand (an expression, a whole-object read, a bracket).
        const leftover = moved.filter(s => /(?<![\w$.])trigger\s*(?:\.\s*output|\[)/.test(JSON.stringify(s))).map(s => s.id);
        if (leftover.length) return refuse(`step${leftover.length > 1 ? 's' : ''} ${leftover.join(', ')} read the flowlet's inputs in a form that cannot be mapped (an expression, or the whole inputs object); rewrite ${leftover.length > 1 ? 'them' : 'it'} to read one input at a time`);
        if (JSON.stringify(out.fields || {}).match(/(?<![\w$.])trigger\s*(?:\.\s*output|\[)/)) return refuse('its Return step reads the flowlet inputs in a form that cannot be mapped');

        // The parent: the call step is replaced by the moved steps, in place.
        const at = graph.steps.findIndex(s => s && s.id === stepId);
        const steps = structuredClone(graph.steps);
        steps.splice(at, 1, ...moved);
        const rest = steps.filter(s => !moved.includes(s));
        for (const s of rest) rewriteSeam(s, result);
        const vars = isObject(graph.vars) ? rewriteSeam(structuredClone(graph.vars), result) : graph.vars;

        const readers = findDanglingRefs({ steps }, stepId);
        if (readers.length) return refuse(`step${readers.length > 1 ? 's' : ''} ${readers.join(', ')} still read ${stepId}'s output in a form that cannot be mapped (the whole output object, an expression, or a bracket spelling); re-point ${readers.length > 1 ? 'them' : 'it'} at one return field first`);

        // Edges: the flowlet's trigger is replaced by whatever led to the call,
        // its Return by whatever followed it. A branch label on an edge into the
        // Return stays on the edge to the follower, so a flowlet that ends in
        // a condition still routes the same way.
        const after = outgoing.filter(e => e.label !== 'on_error');
        const edges = (graph.edges || []).filter(e => e && e.from !== stepId && e.to !== stepId).map(e => ({ ...e }));
        const add = (e) => { if (e.from !== e.to) edges.push(e); };
        for (const e of copy.edges || []) {
            if (!e) continue;
            const { from, to, ...meta } = e;
            if (from === trgId && to === out.id) {
                for (const i of incoming) for (const o of after) add({ from: i.from, to: o.to, ...(i.label ? { label: i.label, ...(i.caseName ? { caseName: i.caseName } : {}) } : (o.label ? { label: o.label } : {})) });
            } else if (from === trgId) {
                for (const i of incoming) add({ from: i.from, to, ...(i.label ? { label: i.label, ...(i.caseName ? { caseName: i.caseName } : {}) } : {}) });
            } else if (to === out.id) {
                for (const o of after) add({ from, to: o.to, ...meta, ...(o.label && !meta.label ? { label: o.label } : {}) });
            } else {
                add({ from, to, ...meta });
            }
        }
        const seen = new Set();
        const unique = edges.filter(e => { const k = edgeKey(e); if (seen.has(k)) return false; seen.add(k); return true; });

        // Commit.
        graph.steps = steps;
        graph.edges = unique;
        if (vars !== graph.vars) graph.vars = vars;
        const stillCalled = [draft, ...Object.values(draft.layers || {})]
            .some(g => g && collectCallLayerSteps(g).some(({ step }) => step.layerKey === layerKey));
        if (!stillCalled) delete draft.layers[layerKey];
        return {
            inlined: { layerKey, callStepId: stepId, movedStepIds: moved.map(s => s.id) },
            ...(stillCalled ? { _note: `Flowlet "${layerKey}" is still called elsewhere, so it was kept.` } : { _note: `Flowlet "${layerKey}" is no longer used and was removed.` }),
        };
    } catch (e) {
        if (e instanceof Unmappable) return refuse(e.message);
        throw e;
    }
}

module.exports = { applyInlineLayer };

/**
 * Automation Builder — live "tool draft" scanner.
 *
 * While the model streams a tool call, the adapter hands us the arguments JSON
 * accumulated so far (`tool_args_delta { name, partial }`). For a
 * builder_add_steps call that is a 5-10 KB document that takes a small model
 * half a minute to write, and the canvas used to show nothing until the last
 * brace. This module reads the UNFINISHED JSON and says which steps it already
 * describes — type, tool, label, and whether the object is still open — so the
 * client can place ghost cards as they are being typed.
 *
 * Deliberately NOT a JSON parser: the input is a prefix of a document, cut at
 * any byte, often inside a string. The scanner walks braces and strings (with
 * escapes) into a light tree of objects/arrays with their string-valued keys,
 * then a per-tool selector reads the step objects off that tree. Nothing here
 * may throw — any exception yields the empty result — and nothing here is
 * ever fed back to the model or the graph; it is a visualisation.
 *
 * Also exports the two throttles chatStream.js gates the SSE events with, with
 * an injectable clock so they can be tested without waiting.
 */

'use strict';

const MAX_STEPS = 40;
/** Tools whose partial arguments describe steps (contract: builder_add_* / replace_step / update_step(s)). */
const STEP_TOOL_RE = /^builder_(add_|replace_step|update_step)/;
const INSPECT_TOOL = 'builder_inspect_tool';
/** An unterminated tool name is shown only once it is unmistakably a name. */
const MIN_PARTIAL_INSPECT = 3;

const EMPTY = () => ({ steps: [], count: 0, capped: false, inspect: [] });

// The structural scan (braces/strings → light tree) and the throttles are
// core/llm/partialJsonScan.js, shared with the App Studio builder; the
// builder_* selectors below are this module's own.
const {
    scanStructure, childObject, childArray, firstArray, objectElements, pick, cleanLabel,
    makeDraftThrottle, makeProgressThrottle, MAX_LABEL,
} = require('../../../core/llm/partialJsonScan');
void childObject;

/**
 * One step from a step-level object (`primary`) and the object that carries
 * its fields when they are nested (`nested`: `spec` for add_steps items and
 * replace_step, `patch` for update_step(s), null for single add tools).
 * type/tool are reported only once their string has closed — half a tool name
 * is not a tool — while a label is shown as it is typed.
 */
function stepFrom(primary, nested, typeOverride) {
    const lookup = nested ? [nested, primary] : [primary];
    const type = typeOverride || (pick([primary, nested], ['type']) || {}).value || null;
    const tool = (pick(lookup, ['tool']) || {}).value || null;
    const labelStr = pick(lookup, ['label', 'title'], { any: true });
    const label = labelStr ? cleanLabel(labelStr.value) : null;
    const partial = !primary.closed || !!(labelStr && !labelStr.terminated);
    return { type, tool, label, partial };
}

/** Loop bodies: raw engine step objects (`{type, tool?, label?}`), flattened after their loop. */
function bodySteps(primary, nested, out, hit = {}) {
    const arr = childArray(primary, 'body') || (nested && childArray(nested, 'body'));
    for (const el of objectElements(arr)) {
        if (out.length >= MAX_STEPS) { hit.capped = true; return; }
        out.push(stepFrom(el, childObject(el, 'spec'), null));
        bodySteps(el, childObject(el, 'spec'), out, hit);
    }
}

/** builder_add_<x> → the engine type the client should draw. */
function inferredType(name) {
    const rest = name.replace(/^builder_add_/, '');
    return rest || null;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * @param {string} name        tool name, e.g. builder_add_steps
 * @param {string} partialJson the arguments JSON streamed so far (any prefix)
 * @returns {{ steps: Array<{type:string|null, tool:string|null, label:string|null, partial:boolean}>, count: number, inspect: string[] }}
 */
function scanToolDraft(name, partialJson) {
    try {
        const tool = typeof name === 'string' ? name : '';
        if (!tool) return EMPTY();
        const root = scanStructure(partialJson);
        if (!root || root.kind !== 'object') return EMPTY();

        if (tool === INSPECT_TOOL) {
            const inspect = [];
            const arr = childArray(root, 'tools') || firstArray(root);
            const keep = (s) => s && (s.terminated ? s.value.length > 0 : s.value.length >= MIN_PARTIAL_INSPECT);
            if (arr) for (const el of arr.elements) if (keep(el)) inspect.push(el.value);
            const single = root.strings.get('tool');
            if (keep(single)) inspect.push(single.value);
            return { steps: [], count: 0, capped: false, inspect };
        }

        if (!STEP_TOOL_RE.test(tool)) return EMPTY();

        const steps = [];
        // Set once the scan stops reading because it reached MAX_STEPS. The
        // client needs it: without it the ghost card renders the CEILING as a
        // total and every capped stream reads "Step 40 of 40" — a number that
        // says nothing about the batch (measured 2026-09-16 on a live build).
        const hit = { capped: false };
        if (tool === 'builder_add_steps' || tool === 'builder_update_steps') {
            const listKey = tool === 'builder_add_steps' ? 'steps' : 'updates';
            const nestedKey = tool === 'builder_add_steps' ? 'spec' : 'patch';
            // `spec` as the list name is the contract's shorthand; a model that
            // writes it that way still gets its cards.
            const arr = childArray(root, listKey) || childArray(root, 'spec') || firstArray(root);
            for (const el of objectElements(arr)) {
                if (steps.length >= MAX_STEPS) { hit.capped = true; break; }
                const nested = childObject(el, nestedKey);
                steps.push(stepFrom(el, nested, null));
                bodySteps(el, nested, steps, hit);
            }
        } else if (tool === 'builder_replace_step') {
            const newType = (pick([root], ['newType', 'type']) || {}).value || null;
            steps.push(stepFrom(root, childObject(root, 'spec'), newType));
            bodySteps(root, childObject(root, 'spec'), steps, hit);
        } else if (tool === 'builder_update_step') {
            steps.push(stepFrom(root, childObject(root, 'patch'), null));
        } else {
            // builder_add_<x>: the root object IS the step.
            steps.push(stepFrom(root, childObject(root, 'spec'), inferredType(tool)));
            bodySteps(root, childObject(root, 'spec'), steps, hit);
        }
        const kept = steps.slice(0, MAX_STEPS);
        return { steps: kept, count: kept.length, capped: hit.capped || steps.length > MAX_STEPS, inspect: [] };
    } catch (_) {
        return EMPTY();
    }
}

/**
 * A short string that changes exactly when a DERIVED field changes: a step
 * appears, a type or tool becomes known, a label finishes, an inspected tool
 * name lands. The text of a label that is still being typed is left out on
 * purpose — it changes on every token, and the 250 ms throttle already carries
 * it to the client; the key is what earns an IMMEDIATE emit.
 */
function deriveDraftKey({ steps, inspect } = {}) {
    const s = Array.isArray(steps) ? steps : [];
    const i = Array.isArray(inspect) ? inspect : [];
    const body = s.map(st => `${st.type || ''}|${st.tool || ''}|${st.partial ? '~' : (st.label || '')}`).join(';');
    return `${s.length}:${body}#${i.join(',')}`;
}

module.exports = {
    scanToolDraft,
    deriveDraftKey,
    makeDraftThrottle,
    makeProgressThrottle,
    // exposed for tests
    _scanStructure: scanStructure,
    MAX_STEPS,
    MAX_LABEL,
};

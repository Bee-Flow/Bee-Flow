/**
 * App Studio validator — an AI step's `contextSources` list: labelled extra context.
 * The count and label limits are errors (LIMITS), never a silent cut.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { LIMITS } = nodeRequire('../componentSpecs/limits');
const { isObject } = nodeRequire('./shared');
const { validateBinding } = nodeRequire('./bindings');

/**
 * @param {string} field
 * @param {unknown} value
 * @param {string} path
 * @param {import('./shared').ValidationCtx} ctx
 */
export function validateContextSources(field: string, value: unknown, path: string, ctx: { pushE: (e: Record<string, unknown>) => void } & Record<string, unknown>): void {
    const { pushE } = ctx;
    if (!Array.isArray(value)) {
        pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` must be a list of { label, source }.`, hint: 'Pass an array.' });
        return;
    }
    if (value.length > LIMITS.MAX_CONTEXT_SOURCES) {
        pushE({ code: 'action.step_field_invalid', severity: 'error', path, message: `\`${field}\` has ${value.length} context sources — the maximum is ${LIMITS.MAX_CONTEXT_SOURCES}.`, hint: 'Merge or remove sources.' });
        return;
    }
    // Each source is a real binding: a typo in the table id has to fail
    // here, not silently reach the model as an empty context that reads
    // like "this order has no lines".
    value.forEach((entry, i) => {
        if (!isObject(entry)) {
            pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}[${i}]`, message: 'Each context source must be an object { label, source }.', hint: 'Provide label + source.' });
            return;
        }
        if (typeof entry.label === 'string' && entry.label.trim().length > LIMITS.MAX_CONTEXT_SOURCE_LABEL) {
            pushE({ code: 'action.step_field_invalid', severity: 'error', path: `${path}[${i}].label`, message: `Context source label is ${entry.label.trim().length} chars — the maximum is ${LIMITS.MAX_CONTEXT_SOURCE_LABEL}.`, hint: 'Shorten the label.' });
        }
        validateBinding(`${field}[${i}].source`, entry.source, `${path}[${i}].source`, ctx);
    });
}

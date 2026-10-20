// @typecheck
/**
 * The plain-language lines for the two table steps, read by summarise.js: the
 * sentence in the automation's summary, and the compact detail on the builder
 * agent's step list. Both return null / '' for any other step type.
 */

'use strict';

/** A binding as short text. */
function describeBinding(b) {
    if (b == null) return '∅';
    if (typeof b !== 'object') return JSON.stringify(b);
    if (b.kind === 'ref') return `\`${b.path}\``;
    if (b.kind === 'template') return `"${b.value}"`;
    if (b.kind === 'expr') return `\`${b.value}\``;
    if (b.kind === 'literal') return JSON.stringify(b.value);
    return JSON.stringify(b);
}

const enabledOps = (step) => (Array.isArray(step.ops) ? step.ops : []).filter(o => o && o.op && o.enabled !== false).map(o => o.op);

/**
 * @param {any} step
 * @param {string} n  the step's number in the summary, e.g. "3."
 * @returns {string | null}
 */
function describeTableStep(step, n) {
    if (step.type === 'read_table') {
        const sheets = Array.isArray(step.sheets) ? ` (sheets: ${step.sheets.join(', ')})` : (step.sheets === 'first' ? ' (first sheet)' : '');
        const named = step.label && step.label !== 'Read table' ? ` — ${step.label}` : '';
        return `${n} Read table from ${step.source == null ? 'a file that is not picked yet' : describeBinding(step.source)}${sheets}${named}.`;
    }
    if (step.type === 'table') {
        const ops = enabledOps(step);
        const named = step.label && step.label !== 'Edit table' ? ` — ${step.label}` : '';
        return `${n} Edit table: ${ops.join(', ') || 'no operations yet'}${step.source == null ? '' : ` on ${describeBinding(step.source)}`}${named}.`;
    }
    return null;
}

/**
 * @param {any} step
 * @returns {string}
 */
function tableDetail(step) {
    if (step.type === 'read_table') {
        const sheets = Array.isArray(step.sheets) ? `[${step.sheets.join(', ')}]` : (step.sheets || 'all');
        return ` from ${describeBinding(step.source)} sheets=${sheets} headerRow=${step.headerRow || 1}`;
    }
    if (step.type === 'table') {
        const ops = (Array.isArray(step.ops) ? step.ops : []).map(o => (o && o.op ? `${o.op}${o.enabled === false ? ' (off)' : ''}` : '?'));
        return ` on ${describeBinding(step.source)} ops=[${ops.join(', ')}]`;
    }
    return '';
}

module.exports = { describeTableStep, tableDetail };

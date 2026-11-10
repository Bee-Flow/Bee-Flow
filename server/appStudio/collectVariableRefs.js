// @typecheck
'use strict';

/**
 * Every name anything in the app PUTS A VALUE IN — the write half of the
 * `vars` picture.
 *
 * One server-side implementation, mirroring the richer client collector, kept
 * in its own module for the same reason collectDataBindings.js is: validate.js
 * and the AI builder both need it, and a third private copy would drift.
 *
 * Reads are NOT collected here. validate.js already visits every formula
 * through validateFormula, so it records reads as a side effect of the walk it
 * was doing anyway; writes must be known BEFORE that walk starts, because the
 * walk consults them to decide whether `vars.<name>` is a typo.
 *
 * The distinction matters: a name that is written somewhere is a real variable
 * even when it was never declared, so reading it is fine. A name that is
 * neither declared nor written anywhere is the typo we are hunting.
 */

const { VARIABLE_NAME_RE, RESERVED_VARIABLE_NAMES } = require('./componentSpecs');
const { stepMetaOf } = require('./componentSpecs/stepRegistry');
const { extraChildLists } = require('../shared/appDefinition/stepFlow.mjs');

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Walk a step list in the same shape the runtime does — a step, then its child
 * branches. Order is irrelevant here (this collects a set), but the SHAPE is
 * not: a set_variable buried in a switch case is just as real as one at the top.
 * @param {number} [depth]
 */
function walkSteps(steps, visit, depth = 0) {
    if (!Array.isArray(steps) || depth > 12) return;
    for (const step of steps) {
        if (!isObject(step)) continue;
        visit(step);
        walkSteps(step.then, visit, depth + 1);
        walkSteps(step.else, visit, depth + 1);
        walkSteps(step.steps, visit, depth + 1);
        walkSteps(step.onError, visit, depth + 1);          // the legacy array form
        walkSteps(step.onError?.steps, visit, depth + 1);   // { steps, stop? }
        if (Array.isArray(step.cases)) {
            for (const c of step.cases) {
                if (isObject(c)) walkSteps(c.steps, visit, depth + 1);
            }
        }
        walkSteps(step.default, visit, depth + 1);
        // The places a registry container adds (a try's catch and finally).
        for (const list of extraChildLists(step)) walkSteps(list, visit, depth + 1);
    }
}

/** Walk every component in the definition, whatever its depth. */
function walkNodes(def, visit) {
    /**
     * @param {number} depth
     */
    const walk = (nodes, depth) => {
        if (!Array.isArray(nodes) || depth > 12) return;
        for (const node of nodes) {
            if (!isObject(node)) continue;
            visit(node);
            walk(node.children, depth + 1);
        }
    };
    for (const screen of Array.isArray(def?.screens) ? def.screens : []) {
        for (const section of Array.isArray(screen?.sections) ? screen.sections : []) {
            walk(section?.children, 0);
        }
    }
}

/**
 * collectVariableWrites(def) → { names, loopScoped, invalid }
 *
 *   names       Set of variable names something writes.
 *   loopScoped  Subset that only exists inside a loop body (itemVar/indexVar):
 *               real while the loop runs, gone afterwards, so a formula
 *               elsewhere reading one is still suspicious.
 *   invalid     [{ name, path, kind }] — writes to a name NO formula can read,
 *               e.g. set_variable.name = "my var", which lands in
 *               vars["my var"] while `vars.my var` is a parse error. The write
 *               silently never arrives; this is what surfaces it.
 */
function collectVariableWrites(def) {
    const names = new Set();
    const loopScoped = new Set();
    /** @type {{ name: string; path: string; kind: string; }[]} */
    const invalid = [];

    /**
     * @param {string} name
     * @param {string} path
     * @param {string} kind
     */
    const record = (name, path, kind, { loop = false } = {}) => {
        if (typeof name !== 'string' || !name) return;
        if (!VARIABLE_NAME_RE.test(name) && !RESERVED_VARIABLE_NAMES.includes(name)) {
            invalid.push({ name, path, kind });
            return;
        }
        names.add(name);
        if (loop) loopScoped.add(name);
    };

    // Actions: set_variable, resultVar (on steps AND on bare v1 actions), and
    // a loop's item/index bindings.
    const actions = isObject(def?.actions) ? def.actions : {};
    for (const [actionId, action] of Object.entries(actions)) {
        if (!isObject(action)) continue;
        const base = `actions.${actionId}`;

        // A bare v1 action of a server kind carries resultVar itself.
        if (typeof action.resultVar === 'string') {
            record(action.resultVar, `${base}.resultVar`, 'resultVar');
        }

        const steps = action.kind === 'sequence' ? action.steps : [action];
        walkSteps(steps, (/** @type {{ kind: string; name: string; resultVar: string; itemVar: string; indexVar: string; }} */ step) => {
            // Every kind that declares resultVar writes it; the spec decides
            // which kinds those are, so no second list is kept here.
            if (typeof step.resultVar === 'string') {
                record(step.resultVar, `${base}.${step.kind}.resultVar`, 'resultVar');
            }
            // The fields of a kind that name a variable it writes (`writesVars` in the step catalogue):
            // set_variable.name, a loop's itemVar and indexVar, and whatever a registry kind declares.
            for (const w of stepMetaOf(step.kind)?.writesVars ?? []) {
                record(/** @type {Record<string, string>} */ (/** @type {unknown} */ (step))[w.field], `${base}.${step.kind}${w.where ?? `.${w.field}`}`, w.as ?? w.field, { loop: w.loop === true });
            }
        });
    }

    // A filter_bar publishes its controls under the reserved `filters` name.
    walkNodes(def, (node) => {
        if (node.type !== 'filter_bar') return;
        const fields = Array.isArray(node.props?.fields) ? node.props.fields : [];
        if (fields.length) names.add('filters');
    });

    return { names, loopScoped, invalid };
}

module.exports = { collectVariableWrites };

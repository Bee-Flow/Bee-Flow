// @typecheck strict
/**
 * parse_json's SOURCE: where the value it parses comes from, and what a dry
 * run does when that value is data the dry run made up and cannot be parsed
 * (RM-7; the dry-run honesty rule is written in ./execCode.js's header).
 * execData.js runs the step itself and re-exports resolveParseJsonSource.
 */
'use strict';

const { refIsSynthetic } = require('./shared');
const { noteRunWarning } = require('./runWarnings');

/**
 * A parse_json step and the run context, as far as the source lookup reads them.
 * @typedef {{ id?: string, sourceRef?: unknown }} ParseJsonSourceStep
 * @typedef {{ from?: string, to?: string, label?: string }} SourceEdge
 * @typedef {{ definition?: { trigger?: { id?: string }, triggers?: Array<{ id?: string }>, edges?: SourceEdge[] },
 *   triggerSynthetic?: boolean }} ParseJsonSourceCtx
 * @typedef {{ name: string }} ParseJsonField
 * @typedef {{ trigger?: { output?: unknown }, steps?: Record<string, { output?: unknown, synthesised?: boolean }>,
 *   _templateWarnings?: unknown }} ParseJsonRunState
 */

/**
 * Resolve the step's source value. `sourceRef` resolves against the run
 * state with the secrets root stripped (exactly like execAiStep's
 * promptScope) so `secrets.*` can never be moved into step output. Without
 * a sourceRef, fall back to the single incoming edge's producer — scoped to
 * ctx.definition, which execCallLayer rebinds to the layer mini-definition,
 * so the lookup is correct inside layers/blocks. Loop bodies / parallel
 * branches do NOT rebind ctx.definition (their steps aren't in its edges),
 * so the fallback misses there and throws the clear error below — the
 * builder pre-fills sourceRef, making this a rare authoring-error path.
 * @param {ParseJsonSourceStep} step
 * @param {ParseJsonSourceCtx} ctx
 * @param {ParseJsonRunState} runState
 */
function resolveParseJsonSource(step, ctx, runState) {
    const bind = require('../automationModel/bind');
    if (typeof step.sourceRef === 'string' && step.sourceRef.trim()) {
        return bind.walkPath(step.sourceRef.trim(), { ...runState, secrets: {} });
    }
    const triggerIds = triggerIdsOf(ctx);
    for (const e of incomingEdges(step, ctx)) {
        const v = triggerIds.has(e.from)
            ? runState.trigger?.output
            : runState.steps?.[e.from]?.output;
        if (v !== undefined) return v;
    }
    throw new Error('parse_json: no source — set the Source field or wire an upstream step.');
}

/**
 * The ids of the definition's trigger(s).
 * @param {ParseJsonSourceCtx} ctx
 * @returns {Set<string>}
 */
function triggerIdsOf(ctx) {
    const def = ctx?.definition || {};
    const ids = new Set();
    if (def.trigger?.id) ids.add(def.trigger.id);
    for (const t of (Array.isArray(def.triggers) ? def.triggers : [])) {
        if (t?.id) ids.add(t.id);
    }
    return ids;
}

/**
 * The edges into this step that carry data (not its on_error edge).
 * @param {ParseJsonSourceStep} step
 * @param {ParseJsonSourceCtx} ctx
 * @returns {SourceEdge[]}
 */
function incomingEdges(step, ctx) {
    const edges = ctx?.definition?.edges;
    return (Array.isArray(edges) ? edges : []).filter(e => e && e.to === step.id && e.label !== 'on_error');
}

/**
 * True when parse_json's source is data a DRY RUN made up: the Source path, or
 * (without one) an incoming step, reads a synthesised step or a synthetic
 * trigger (./shared.js refIsSynthetic).
 * @param {ParseJsonSourceStep} step
 * @param {ParseJsonSourceCtx} ctx
 * @param {ParseJsonRunState} runState
 */
function parseJsonSourceSynthetic(step, ctx, runState) {
    if (typeof step.sourceRef === 'string' && step.sourceRef.trim()) return refIsSynthetic(step.sourceRef.trim(), runState, ctx || {});
    const triggerIds = triggerIdsOf(ctx);
    return incomingEdges(step, ctx)
        .some((e) => (triggerIds.has(e.from) ? !!ctx?.triggerSynthetic : refIsSynthetic(`steps.${e.from}`, runState, ctx || {})));
}

/**
 * parse_json over data a dry run made up, that would not parse: the
 * simulated step's placeholder is not the real answer, so the failure
 * predicts nothing about the live run. A labelled synthetic skip with a run
 * warning, never a red step and never a green one.
 * @param {ParseJsonSourceStep} step
 * @param {ParseJsonRunState} runState
 * @param {ParseJsonField[]} fields
 * @param {string} itemsRef
 * @param {Error} err
 */
function syntheticSourceSkip(step, runState, fields, itemsRef, err) {
    noteRunWarning(runState, `${step.id}: parse_json could not read the simulated data of this dry run (${err.message}); a live run reads the real answer.`);
    /** @type {Record<string, unknown>} */
    const output = itemsRef ? { items: [], count: 0 } : Object.fromEntries(fields.map((f) => [f.name, null]));
    output.skipped = `Not parsed in this dry run: the source is simulated data. ${err.message}`;
    return { output, skippedReason: 'synthetic_source', dryRunSynthesised: true, dryRunFallback: 'synthetic_input' };
}

/**
 * Run the step; in a dry run whose source is simulated, a failure (other than
 * a guardrail verdict) becomes the synthetic skip above. Live is unchanged.
 * @template T
 * @param {{ step: ParseJsonSourceStep, ctx: ParseJsonSourceCtx, runState: ParseJsonRunState, mode: string,
 *   fields: ParseJsonField[], itemsRef: string }} call
 * @param {() => Promise<T>} run
 */
async function withSyntheticSourceSkip({ step, ctx, runState, mode, fields, itemsRef }, run) {
    try {
        return await run();
    } catch (err) {
        const blocked = /** @type {{ guardrailBlocked?: boolean } | null} */ (err)?.guardrailBlocked;
        if (mode === 'dry_run' && !blocked && parseJsonSourceSynthetic(step, ctx, runState)) {
            return syntheticSourceSkip(step, runState, fields, itemsRef, /** @type {Error} */ (err));
        }
        throw err;
    }
}

module.exports = { resolveParseJsonSource, parseJsonSourceSynthetic, withSyntheticSourceSkip };

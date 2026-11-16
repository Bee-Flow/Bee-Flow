/**
 * App Studio builder tool app_edit_react_block (tools/app_edit_react_block.js): the content of
 * one `react_block` node, `props.block` (customBlock/reactBlockShape.mts): its TSX source, its
 * stylesheet, inputs and events. Each key that is passed replaces the stored one; null removes
 * it. `sourceEdits` change the source by exact find/replace pairs (utils/sourceEdits.mts).
 *
 * Every save compiles the source with the compiler the website's React block uses
 * (shared/cmsReact/compile.mjs, through stores/cms/reactBlock.mts: native esbuild, cached) and
 * stores the outcome with the stamp of the source it belongs to. The answer carries the outcome
 * (`compiled`, `compileError`, `diagnostics`) so the model can iterate until it compiles, the
 * block as stored (without the compiled code) and `_hints` for whatever the canonicalizer left out.
 */

import { compileReactSource } from '../../stores/cms/reactBlock.mts';
import { applySourceEdits, SourceEditFailure, sourceEditsProblem, type SourceEdit } from '../../utils/sourceEdits.mts';
import { reactSourceMaxChars } from '../customBlock/blockLimits.mts';
import { sourceStamp } from '../customBlock/reactBlockShape.mts';
import { adoptCanonical, isObject, ops, unknownAction, UNKNOWN_ACTION_HINT, type DraftWrap } from './blockToolShared.mts';

type ToolError = { error: string; _fixHint?: string };

export const REACT_EDIT_KEYS: readonly string[] = Object.freeze(['source', 'sourceEdits', 'css', 'inputs', 'events']);
const DIAGNOSTICS_MAX = 20;
const ECHO_MAX = 6000;

function fail(error: string, fixHint?: string): ToolError {
    return fixHint ? { error, _fixHint: fixHint } : { error };
}

/** What is wrong with the arguments before anything is changed, or null. */
function argsProblem(args: Record<string, unknown>): ToolError | null {
    if (!REACT_EDIT_KEYS.some((key) => args[key] !== undefined)) {
        return fail(`Pass at least one of: ${REACT_EDIT_KEYS.join(', ')}.`, 'e.g. app_edit_react_block { nodeId, source: "export default function Block({ title }) { return <h2>{title}</h2>; }", inputs: { title: { kind: "static", value: "Hello" } } }.');
    }
    if (args.source !== undefined && args.sourceEdits !== undefined) return fail('Send either source (whole) or sourceEdits, not both.');
    if (args.source !== undefined && args.source !== null && typeof args.source !== 'string') return fail('source must be the whole TSX file as a string.');
    if (args.sourceEdits !== undefined) {
        const problem = sourceEditsProblem(args.sourceEdits);
        if (problem) return fail(problem);
    }
    return null;
}

/** The next block value: the stored one with the passed keys replaced (null removes). */
function nextBlock(stored: unknown, args: Record<string, unknown>): Record<string, unknown> {
    const next: Record<string, unknown> = { source: '', ...(isObject(stored) ? stored : {}) };
    for (const key of ['source', 'css', 'inputs', 'events']) {
        if (args[key] === undefined) continue;
        if (args[key] === null) { if (key === 'source') next.source = ''; else delete next[key]; } else next[key] = args[key];
    }
    if (args.sourceEdits !== undefined) {
        next.source = applySourceEdits(typeof next.source === 'string' ? next.source : '', args.sourceEdits as SourceEdit[], 'app_get_node (props.block.source)');
    }
    return next;
}

/** Compile `next.source` and write the outcome into `next`; the report for the answer. */
async function compileInto(next: Record<string, unknown>): Promise<Record<string, unknown>> {
    delete next.compiled;
    delete next.compileError;
    delete next.compiledFor;
    const source = typeof next.source === 'string' ? next.source : '';
    if (!source.trim()) return { compiled: false, compileError: 'The block has no source yet.', diagnostics: [] };
    const outcome = await compileReactSource(source);
    next.compiledFor = sourceStamp(source);
    if (outcome.ok) next.compiled = outcome.code;
    else next.compileError = outcome.error;
    return { compiled: outcome.ok, compileError: outcome.ok ? '' : outcome.error, diagnostics: outcome.diagnostics.slice(0, DIAGNOSTICS_MAX) };
}

/** The block as stored, for the answer: the compiled code and its stamp are noise to a model. */
function echoOf(block: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...block };
    delete out.compiledFor;
    if (typeof out.compiled === 'string') out.compiled = `<${out.compiled.length} characters>`;
    if (typeof out.source === 'string' && out.source.length > ECHO_MAX) out.source = `${out.source.slice(0, ECHO_MAX)}… (${out.source.length} characters stored)`;
    return out;
}

/** The block as it would be saved, or why nothing is saved. */
function plannedBlock(node: Record<string, unknown>, args: Record<string, unknown>, def: Record<string, unknown>): Record<string, unknown> | ToolError {
    const problem = argsProblem(args);
    if (problem) return problem;
    const props = isObject(node.props) ? node.props : {};
    let next: Record<string, unknown>;
    try {
        next = nextBlock(props.block, args);
    } catch (e) {
        if (e instanceof SourceEditFailure) return fail(e.message, e.fixHint);
        throw e;
    }
    const max = reactSourceMaxChars();
    if (String(next.source).length > max) return fail(`The source is longer than ${max} characters; nothing was saved.`, 'Make the component smaller, or ask the operator to raise STUDIO_APP_REACT_SOURCE_CHARS.');
    const missing = unknownAction(next.events, def);
    if (missing) return fail(missing, UNKNOWN_ACTION_HINT);
    return next;
}

export async function apply(draftWrap: DraftWrap, args: Record<string, unknown> | null | undefined): Promise<Record<string, unknown>> {
    const a = isObject(args) ? args : {};
    const id = typeof a.nodeId === 'string' ? a.nodeId : '';
    const found = id ? ops.findNode(draftWrap.def, id) : null;
    if (!found || found.node.type !== 'react_block') {
        return fail(`No react_block with id ${JSON.stringify(id)}.`, 'Add one first: app_add_components with { type: "react_block" }, then pass its id as nodeId.');
    }
    const next = plannedBlock(found.node, a, draftWrap.def);
    if (typeof next.error === 'string') return next;

    const report = await compileInto(next);
    const result = adoptCanonical(draftWrap, ops.updateNodeProps(draftWrap.def, id, { block: next }), {});
    if (result.error) return result;
    const stored = ops.findNode(draftWrap.def, id)?.node.props as Record<string, unknown> | undefined;
    const block = isObject(stored?.block) ? stored.block : { source: '' };
    return { ...result, ...report, block: echoOf(block) };
}

/**
 * App Studio builder tool app_edit_block (tools/app_edit_block.js): the content of one
 * `custom_block` node, `props.block` (customBlock/blockShape.mts): its template, stylesheet,
 * inputs and events. Each key that is passed replaces the stored one; null removes it.
 *
 * The echo is the block as STORED, so the model sees what saving kept, with `_hints` for
 * everything the sanitiser left out (and on which template line) and `problems` for what the
 * template still asks for: a name that is no input, an event nobody wired, a broken formula.
 */

import { createRequire } from 'node:module';
import { canonicalTemplate, inspectTemplate } from '../../shared/blockTemplate/index.mjs';

const nodeRequire = createRequire(import.meta.url);
const ops = nodeRequire('../definitionOps.js') as {
    findNode: (def: unknown, id: string) => { node: Record<string, unknown> } | null;
    updateNodeProps: (def: unknown, id: string, patch: Record<string, unknown>) => unknown;
};
const { adoptCanonical } = nodeRequire('./shared.js') as { adoptCanonical: (wrap: DraftWrap, next: unknown, result: Record<string, unknown>) => Record<string, unknown> };

type DraftWrap = { def: Record<string, unknown> };

export const BLOCK_KEYS: readonly string[] = Object.freeze(['template', 'css', 'inputs', 'events']);
const ECHO_MAX = 6000;

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** What the stored template still asks of its declarations, as sentences. */
function openQuestions(block: Record<string, unknown>): string[] {
    const template = typeof block.template === 'string' ? block.template : '';
    const used = inspectTemplate(canonicalTemplate(template).nodes);
    const inputs = isObject(block.inputs) ? Object.keys(block.inputs) : [];
    const events = isObject(block.events) ? block.events : {};
    const out = used.errors.map((e) => `Template line ${e.line}: ${e.message}`);
    for (const ref of used.refs) if (!inputs.includes(ref)) out.push(`The template reads "${ref}", which is not an input: add inputs.${ref} with a binding.`);
    for (const name of used.events) if (typeof events[name] !== 'string') out.push(`A control raises "${name}" but events.${name} names no action yet.`);
    return out;
}

function unknownAction(events: unknown, def: Record<string, unknown>): string | null {
    if (!isObject(events)) return null;
    const actions = isObject(def.actions) ? def.actions : {};
    for (const [name, actionId] of Object.entries(events)) {
        if (typeof actionId === 'string' && actionId && !Object.hasOwn(actions, actionId)) return `events.${name} names the action ${JSON.stringify(actionId)}, which does not exist.`;
    }
    return null;
}

export function apply(draftWrap: DraftWrap, args: Record<string, unknown> | null | undefined): Record<string, unknown> {
    const id = typeof args?.nodeId === 'string' ? args.nodeId : '';
    const found = id ? ops.findNode(draftWrap.def, id) : null;
    if (!found || found.node.type !== 'custom_block') {
        return { error: `No custom_block with id ${JSON.stringify(id)}.`, _fixHint: 'Add one first: app_add_components with { type: "custom_block" }, then pass its id as nodeId.' };
    }
    const passed = BLOCK_KEYS.filter((key) => args && args[key] !== undefined);
    if (!passed.length) return { error: `Pass at least one of: ${BLOCK_KEYS.join(', ')}.`, _fixHint: 'e.g. app_edit_block { nodeId, template: "<p>{{ title }}</p>", inputs: { title: { kind: "static", value: "Hello" } } }.' };
    const props = isObject(found.node.props) ? found.node.props : {};
    const next: Record<string, unknown> = { template: '', ...(isObject(props.block) ? props.block : {}) };
    for (const key of passed) {
        if (args![key] === null) { if (key === 'template') next.template = ''; else delete next[key]; } else next[key] = args![key];
    }
    const missing = unknownAction(next.events, draftWrap.def);
    if (missing) return { error: missing, _fixHint: 'Create the action first (app_set_action), then wire it; or set the event to null.' };

    const result = adoptCanonical(draftWrap, ops.updateNodeProps(draftWrap.def, id, { block: next }), {});
    if (result.error) return result;
    const stored = ops.findNode(draftWrap.def, id)?.node.props as Record<string, unknown> | undefined;
    const block = isObject(stored?.block) ? stored.block : { template: '' };
    const template = typeof block.template === 'string' ? block.template : '';
    result.block = template.length > ECHO_MAX ? { ...block, template: `${template.slice(0, ECHO_MAX)}… (${template.length} characters stored)` } : { ...block };
    const problems = openQuestions(block);
    if (problems.length) result.problems = problems;
    return result;
}

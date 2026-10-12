/**
 * One builder tool call → the row the assistant's activity list shows for
 * it. A port of the web's Builder/chat/toolCallDisplay.js (describeToolCall,
 * describeLiveRun), pinned by ai.lockstep.test.ts (differential).
 *
 * The step's OWN answer (`result.added`) names the row, by the same type
 * label the cards use — not the tool's name, which read
 * `builder_add_array_op` three times for three different things. Only the
 * tools that create no step have a verb of their own. A batch
 * (builder_add_steps) is one row, "Added 4 steps", with its steps under it.
 *
 * An integration action is named by its APP when the caller can say which
 * (`appLabel`, from the catalog); the web reads its bundled integration
 * table for that.
 */

import type { BuilderAddedStep, BuilderToolCall, FlowCatalog } from '@/features/flow-editor/api';
import { humanizeToolName, nodeTypeLabel, typeGroupOf, type NodeFamily, type Translate } from '@/features/flow-editor/model';

const VERBS: Readonly<Record<string, readonly [string, string]>> = {
    builder_propose_trigger: ['automations.builder.act.trigger', 'Set the trigger'],
    builder_remove_step: ['automations.builder.act.remove', 'Removed a step'],
    builder_update_step: ['automations.builder.act.update', 'Adjusted a step'],
    builder_update_steps: ['automations.builder.act.update', 'Adjusted a step'],
    builder_replace_step: ['automations.builder.act.replace', 'Replaced a step'],
    builder_move_step: ['automations.builder.act.move', 'Moved a step'],
    builder_wire_error_branch: ['automations.builder.act.error_branch', 'Added a fallback for failures'],
    builder_set_metadata: ['automations.builder.act.metadata', 'Named the automation'],
    builder_inspect_tool: ['automations.builder.act.inspect', 'Looked up how an app works'],
    builder_summarise: ['automations.builder.act.summarise', 'Reviewed the automation'],
    builder_request_dry_run: ['automations.builder.act.dry_run', 'Tested the automation'],
    builder_finalize: ['automations.builder.act.finalize', 'Finished and saved'],
    builder_set_plan: ['automations.builder.act.plan', 'Updated the plan'],
    builder_create_datatable: ['automations.builder.act.create_datatable', 'Created a table'],
    builder_propose_plan: ['automations.builder.act.plan', 'Updated the plan'],
};

/** `builder_add_array_op` ops with a word of their own while no step names them yet. */
const ARRAY_OP_VERBS: Readonly<Record<string, readonly [string, string]>> = {
    flatten: ['flatten_node.activity', 'Flattening a list'],
};

/** The app behind a tool ("Gmail"), or null when the caller cannot say. */
export type AppLabel = (tool: string | null) => string | null;

/** The catalog's answer: the app whose actions include the tool. */
export function catalogAppLabel(catalog: FlowCatalog | null): AppLabel {
    return (tool) => {
        if (!tool || !catalog) return null;
        return catalog.apps.find((app) => app.actions.some((a) => a.name === tool))?.label || null;
    };
}

export interface ActivityStep {
    id: string | null;
    type: string | null;
    tool: string | null;
    family: NodeFamily | null;
    title: string;
}

export interface ActivityRow {
    title: string;
    detail: string;
    type: string | null;
    family: NodeFamily | null;
    status: 'done' | 'failed' | 'running';
    error: string | null;
    hint: string | null;
    steps: ActivityStep[];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function stepTitle(step: BuilderAddedStep, t: Translate, appLabel: AppLabel): string {
    const type = str(step.type);
    const tool = str(step.tool);
    if (type === 'integration_action') return appLabel(tool) || nodeTypeLabel(type, t) || '';
    return (type && nodeTypeLabel(type, t)) || appLabel(tool) || (type ? humanizeToolName(type) : '') || '';
}

function stepsOf(added: readonly BuilderAddedStep[], t: Translate, appLabel: AppLabel): ActivityStep[] {
    return added.map((s) => ({ id: s.id ?? null, type: str(s.type), tool: str(s.tool), family: typeGroupOf(str(s.type)), title: stepTitle(s, t, appLabel) }));
}

function titleFor(name: string, type: string | null, t: Translate, op: string | null = null): string {
    if (type) {
        const label = nodeTypeLabel(type, t);
        if (label) return label;
    }
    const opVerb = name === 'builder_add_array_op' && op && Object.hasOwn(ARRAY_OP_VERBS, op) ? ARRAY_OP_VERBS[op] : undefined;
    if (opVerb) return t(opVerb[0], opVerb[1]);
    const verb = VERBS[name];
    if (verb) return t(verb[0], verb[1]);
    // A tool added next month degrades to something readable, never a blank row.
    return humanizeToolName(name.replace(/^builder_(add_)?/, '')) || name || '';
}

function batchTitle(n: number, t: Translate): string {
    return n === 1 ? t('automations.builder.act.add_step_one', 'Added 1 step') : t('automations.builder.act.add_steps', 'Added {n} steps', { n });
}

export function describeToolCall(call: BuilderToolCall, t: Translate, appLabel: AppLabel = () => null): ActivityRow {
    const name = call.name || '';
    const error = str(call.error);
    const hint = str(call.hint);
    const steps = stepsOf(call.added ?? [], t, appLabel);
    const status = error ? 'failed' : 'done';
    if (call.batch && steps.length) {
        return {
            title: batchTitle(steps.length, t),
            detail: steps.map((s) => s.title).filter(Boolean).join(' · '),
            type: null,
            family: steps.every((s) => s.family === 'app') ? 'app' : null,
            status, error, hint, steps,
        };
    }
    const added = call.added?.[0] ?? null;
    const type = added ? str(added.type) : null;
    return {
        title: titleFor(name, type, t, str(call.op)),
        detail: (added && str(added.label)) || '',
        type,
        family: type ? typeGroupOf(type) : null,
        status, error, hint, steps,
    };
}

/** The row of a test run that is still going: the step it is on and how far, once it has said. */
export function describeLiveRun(focus: { label?: string | null; done?: number; total?: number } | null, t: Translate): ActivityRow {
    const total = Math.max(0, Number(focus?.total) || 0);
    const done = Math.min(total, Math.max(0, Number(focus?.done) || 0));
    const label = str(focus?.label);
    const detail = [label, total > 0 ? `${done}/${total}` : null].filter(Boolean).join(' · ');
    return {
        title: t('automations.builder.act.dry_run_live', 'Testing the automation…'),
        detail, type: null, family: null, status: 'running', error: null, hint: null, steps: [],
    };
}

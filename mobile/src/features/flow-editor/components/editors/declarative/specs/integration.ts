/**
 * An app action — the web's IntegrationActionFields
 * (actionEditors/integrationActionFields.jsx, with ActionCard.tsx): the
 * action (switchable to a sibling action of the same app, keeping the inputs
 * the new one shares), the
 * inputs laid out from the action's catalog schema, and the Advanced rows.
 */

import type { FlowCatalog, CatalogActionRow } from '@/features/flow-editor/api';
import type { FlowNode, ForEach } from '@/features/flow-editor/bindings';
import { deepenInputsWrite } from '@/features/flow-editor/bindings/deepenInputs';
import type { FormDraft } from '@/features/flow-editor/formState';
import { humanizeToolName } from '@/features/flow-editor/model';

import { msg, type EditorSpec, type OptionSpec, type SpecContext } from '../spec';
import { ASK_ONCE, FOR_EACH, retryIsSet, RETRY, TITLES } from './common';

export interface ActionLookup {
    action: CatalogActionRow | null;
    siblings: CatalogActionRow[];
    appLabel: string | null;
}

/**
 * The catalog action for `tool` and every action of the same app (the
 * operation switcher). Falls back to `appId` when the tool itself is not in
 * the catalog (the app is not connected), so the list still renders. Port of
 * the web's `findActionAndSiblings`.
 */
export function findActionAndSiblings(catalog: Pick<FlowCatalog, 'apps'> | null | undefined, tool: unknown, appId: unknown): ActionLookup {
    const apps = catalog?.apps ?? [];
    for (const app of apps) {
        const action = (app.actions || []).find((a) => a.name === tool);
        if (action) return { action, siblings: app.actions || [], appLabel: app.label || null };
    }
    if (appId) {
        const app = apps.find((a) => a.id === appId || (a.actions || []).some((x) => (x.integrationId || a.id) === appId));
        if (app) return { action: null, siblings: app.actions || [], appLabel: app.label || null };
    }
    return { action: null, siblings: [], appLabel: null };
}

const currentTool = (draft: FormDraft, step: FlowNode) => String(draft.tool || step.tool || '');
const lookup = (draft: FormDraft, ctx: SpecContext) => findActionAndSiblings(ctx.catalog, currentTool(draft, ctx.step), draft.appId || ctx.step.appId);

/**
 * Switching the operation: the inputs the new action also declares are kept,
 * the label follows the action, and its side-effect flag rides along.
 */
export function switchOperation(draft: FormDraft, ctx: SpecContext, nextTool: string): FormDraft {
    if (!nextTool || nextTool === currentTool(draft, ctx.step)) return {};
    const next = lookup(draft, ctx).siblings.find((a) => a.name === nextTool);
    const props = next?.inputSchema?.properties;
    const prev = (draft.inputs as Record<string, unknown>) || {};
    const inputs = props ? Object.fromEntries(Object.entries(prev).filter(([k]) => k in props)) : prev;
    return {
        tool: nextTool,
        label: next?.label || humanizeToolName(nextTool),
        inputs,
        ...(next && typeof next.sideEffect === 'boolean' ? { sideEffect: next.sideEffect } : {}),
    };
}

function operationOptions(draft: FormDraft, ctx: SpecContext): OptionSpec[] {
    const { siblings } = lookup(draft, ctx);
    const tool = currentTool(draft, ctx.step);
    const known = siblings.some((a) => a.name === tool);
    const rows = siblings.map((a) => ({ value: a.name, label: a.label || humanizeToolName(a.name), blurb: a.description || undefined }));
    return known || !tool ? rows : [{ value: tool, label: humanizeToolName(tool) }, ...rows];
}

const advancedSet = (draft: FormDraft) => !!draft.forEach || !!draft.askOnce || retryIsSet(draft);

export const INTEGRATION_ACTION: EditorSpec = {
    type: 'integration_action',
    sections: [
        {
            // The web shows the action as a card above the bands (ActionCard):
            // the setting's name as an error names it, and Switch's menu.
            key: 'basics',
            title: msg('automations.output.setting_action', 'Action'),
            defaultOpen: true,
            fields: [
                {
                    kind: 'select',
                    id: 'operation',
                    label: msg('automations.ndv.action_switch_menu', 'Actions of this app'),
                    hint: (draft, ctx) =>
                        lookup(draft, ctx).siblings.length > 1
                            ? msg('mobile.flow.action.operation_switch', 'Switch which action this node runs. Inputs shared with the new operation are kept.')
                            : msg('mobile.flow.action.operation_fixed', 'The action this node runs.'),
                    options: operationOptions,
                    read: (draft, ctx) => currentTool(draft, ctx.step),
                    write: (value, draft, ctx) => switchOperation(draft, ctx, String(value)),
                },
            ],
        },
        {
            key: 'inputs',
            title: TITLES.inputs,
            defaultOpen: true,
            fields: [
                {
                    kind: 'schema',
                    key: 'inputs',
                    schema: (draft, ctx) => lookup(draft, ctx).action?.inputSchema ?? null,
                    // A value from a list inside a list, picked into an empty
                    // input that takes one value, runs the step once per inner
                    // item, the outer item kept — never a list in one field.
                    write: (value, draft, ctx) => {
                        const schema = lookup(draft, ctx).action?.inputSchema;
                        const r = deepenInputsWrite(draft.forEach as ForEach | null, draft.inputs as Record<string, unknown>, (value || {}) as Record<string, unknown>, { sampleRoot: ctx.sampleRoot, schema });
                        return r.forEach ? { inputs: r.inputs, forEach: r.forEach } : { inputs: r.inputs };
                    },
                    hint: (draft, ctx) =>
                        lookup(draft, ctx).action?.inputSchema
                            ? null
                            : msg('mobile.flow.action.no_schema', 'No schema found for this tool — using generic key/value rows.'),
                },
            ],
        },
        {
            key: 'advanced',
            title: TITLES.advanced,
            defaultOpen: advancedSet,
            hasContent: advancedSet,
            fields: [FOR_EACH, RETRY, ASK_ONCE],
        },
    ],
};

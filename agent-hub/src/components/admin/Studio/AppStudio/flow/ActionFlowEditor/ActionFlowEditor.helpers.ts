import { parseId, type FlowStep, type GraphEdge, type GraphNode } from '../stepGraph';
import { isDanglingRef, labelForRef, type RefOption } from '../stepReferences';
import type { TranslateParams } from '@/hooks/useTranslation';
import type { AppAction } from '../../inspector/appDefinition';
import type { FlowGraph } from '../ActionFlowEditor.types';

/** Where a step added "after this one" lands in its scope. */
export function indexAfter(graph: FlowGraph, afterId: string | undefined) {
    if (!afterId) return null;
    const { prefix } = parseId(afterId);
    const scoped = graph.nodes.filter((n) => n.prefix === prefix && !n.isEntry);
    const at = scoped.findIndex((n) => n.id === afterId);
    return at === -1 ? null : at + 1;
}

/**
 * Put `node` at position `at` among the non-entry nodes of one scope, leaving
 * every other scope exactly where it is. The node ARRAY carries the order —
 * see moveStep for why the scope's edges are dropped alongside it.
 */
export function spliceScope(nodes: GraphNode[], prefix: string, at: number, node: GraphNode) {
    const scoped = nodes.filter((n) => n.prefix === prefix && !n.isEntry);
    const anchor = scoped[at];
    if (anchor) {
        const i = nodes.indexOf(anchor);
        return [...nodes.slice(0, i), node, ...nodes.slice(i)];
    }
    // Past the end of the scope: straight after its last node, so the new one
    // stays inside the scope rather than drifting into whatever follows.
    const last = scoped[scoped.length - 1];
    if (!last) return [...nodes, node];
    const i = nodes.indexOf(last);
    return [...nodes.slice(0, i + 1), node, ...nodes.slice(i + 1)];
}

/** Forget one scope's edges — they encode the order the array now owns. */
export function dropScopeEdges(edges: GraphEdge[], prefix: string) {
    return edges.filter((e) => parseId(e.from).prefix !== prefix);
}

/** Is there a neighbour that way, inside this step's own branch? */
export function canMove(graph: FlowGraph, id: string, delta: number) {
    const { prefix } = parseId(id);
    const scoped = graph.nodes.filter((n) => n.prefix === prefix && !n.isEntry);
    const at = scoped.findIndex((n) => n.id === id);
    return at !== -1 && at + delta >= 0 && at + delta < scoped.length;
}

/** A bare v1 action is an implicit one-step sequence — the runtime says so too. */
export function normalizeToSequence(action: AppAction | null | undefined): FlowStep {
    if (!action) return { kind: 'sequence', steps: [] };
    if (action.kind === 'sequence') return action as FlowStep;
    return { kind: 'sequence', steps: [action as FlowStep] };
}

/**
 * The one line under a step's name — what it actually does, in its own words.
 *
 * It used to print the raw id for everything a step points at: a "Go to screen"
 * node read `→ scr_8f21`, "Add a row" read `tbl_9f3a2c`, "Run automation" read a
 * uuid. On a canvas whose whole job is showing what happens, the one line that
 * says WHICH thing was the one line nobody could read. `options` is the same
 * name lookup the settings pickers use; without it (nothing loaded yet) each
 * helper falls back to the id, so the node never goes blank.
 *
 * → { text, missing } — `missing` marks a step pointing at something that has
 * since been deleted, so the canvas can show it before the app is published.
 */
export function summarise(step: FlowStep | null, options: Record<string, RefOption[]> = {}, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    if (!step) return { text: '', missing: false };

    const ref = (kind: string, id: unknown, empty: string) => {
        if (!id) return { text: empty, missing: false };
        return { text: labelForRef(options[kind], id), missing: isDanglingRef(options[kind], id) };
    };
    const plain = (text: string) => ({ text: text || '', missing: false });

    switch (step.kind) {
        case 'navigate': {
            const r = ref('screen', step.screenId, t('studio_apps_edit.action_flow.no_screen', 'No screen picked yet'));
            return { ...r, text: step.screenId ? `→ ${r.text}` : r.text };
        }
        case 'open_modal':
        case 'close_modal': return ref('modal', step.modalId, t('studio_apps_edit.action_flow.no_dialog', 'No dialog picked yet'));
        case 'toast': return plain(step.message || t('studio_apps_edit.action_flow.no_message', 'No message yet'));
        case 'open_url': return plain(step.url || t('studio_apps_edit.action_flow.no_address', 'No address yet'));
        case 'set_variable': return plain(step.name ? `vars.${step.name}` : t('studio_apps_edit.action_flow.no_variable', 'No variable picked yet'));
        case 'condition':
        case 'switch': return plain(step.expr || t('studio_apps_edit.action_flow.no_condition', 'No condition yet'));
        case 'loop': return plain(step.itemVar ? t('studio_apps_edit.action_flow.each_item', 'each {item}', { item: step.itemVar }) : t('studio_apps_edit.action_flow.every_row', 'For every row'));
        case 'create_record':
        case 'update_record':
        case 'delete_record': return ref('table', step.tableId, t('studio_apps_edit.action_flow.no_table', 'No table picked yet'));
        case 'refresh': {
            if (step.tableId) return ref('table', step.tableId, '');
            if (step.datasetId) return ref('dataset', step.datasetId, '');
            return plain(t('studio_apps_edit.action_flow.everything', 'Everything on the screen'));
        }
        case 'run_automation': return ref('automation', step.automationId, t('studio_apps_edit.action_flow.no_automation', 'No automation picked yet'));
        case 'send_email': return ref('connector', step.connectorId, t('studio_apps_edit.action_flow.no_mailbox', 'No mailbox picked yet'));
        case 'confirm': return plain(step.message || '');
        default: return plain(step.resultVar ? `→ vars.${step.resultVar}` : '');
    }
}

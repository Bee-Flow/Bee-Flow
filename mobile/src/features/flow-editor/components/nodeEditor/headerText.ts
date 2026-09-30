/**
 * What the node editor's header says — the web's NodeDetailView
 * `stepTypeLabel` / `headerTitle` (BFSF-333): the name is how the author
 * checks they opened the step they meant, so it is never a raw tool id or a
 * bare `trg`; the kind of step sits above it, with where it runs in the flow.
 */

import type { TranslateFn } from '@/core/i18n';
import type { FlowNode } from '@/features/flow-editor/bindings';
import { actionDisplayLabel, defaultTriggerLabel, nodeTypeLabel, triggerTypeLabel, type FlowPosition } from '@/features/flow-editor/model';

type CatalogLike = Parameters<typeof actionDisplayLabel>[1];

/** What KIND of step this is. */
export function stepTypeLabel(step: FlowNode | null, t: TranslateFn | null = null): string {
    if (!step) return '';
    if (step.type === 'trigger') return triggerTypeLabel(step);
    return nodeTypeLabel(String(step.type), t) || String(step.type || '').replace(/_/g, ' ');
}

/** What the header calls this step. */
export function headerTitle(step: FlowNode | null, catalog: CatalogLike = null): string {
    if (!step) return '';
    if (step.label) return step.label;
    if (step.type === 'trigger') return defaultTriggerLabel(step.kind || 'manual');
    if (step.tool) return actionDisplayLabel(step.tool, catalog);
    return stepTypeLabel(step) || step.id;
}

/** "AI STEP · Step 3 of 7" — the position only when there is more than one step. */
export function headerKicker(step: FlowNode | null, position: FlowPosition, t: TranslateFn): string {
    const kind = stepTypeLabel(step, t);
    if (position.total <= 1 || !position.index) return kind;
    return `${kind} · ${t('routines.ndv.step_of', 'Step {n} of {total}', { n: position.index, total: position.total })}`;
}

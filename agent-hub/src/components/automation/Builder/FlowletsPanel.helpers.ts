import React from 'react';
import { nodeTypeLabel } from './flow/nodeDefs';
import type { LayerAgentState, PreviewLayer, PreviewRow, PreviewStep } from './FlowletsPanel.types';

// Friendly, non-technical labels for the step-type chips in the preview.
const STEP_TYPE_LABELS: Record<string, string> = {
    integration_action: 'Action',
    ai_step: 'AI',
    data_extraction: 'Extract data',
    condition: 'Condition',
    loop: 'Loop',
    code: 'Code',
    notification: 'Notification',
    approval: 'Approval',
    http_request: 'HTTP Request',
    generate_document: 'Document',
    fill_document: 'Filled document',
    slide: 'Slide',
    presentation: 'Presentation',
    form_page: 'Form page',
    call_layer: 'Flowlet',
    set: 'Edit data',
    datetime: 'Date & time',
    knowledge_write: 'To knowledge base',
    wait: 'Wait',
    stop_error: 'Stop', return_to_app: 'Back to the app',
    // All three are the ONE deciding step — same name everywhere.
    switch: 'Condition',
    filter: 'Condition',
    limit: 'Limit',
    dedupe: 'Dedupe',
    flatten: nodeTypeLabel('flatten'),
    aggregate: 'Aggregate',
    summarize: 'Summarize',
};

/** Flatten a flowlet's steps (excluding the terminal Return) into preview rows. */
export function previewRows(layer: PreviewLayer | undefined): PreviewRow[] {
    const steps: PreviewStep[] = Array.isArray(layer?.steps) ? layer.steps : [];
    return steps
        .filter((s: PreviewStep) => s && s.type !== 'layer_output')
        .map((s: PreviewStep) => ({
            id: s.id,
            type: STEP_TYPE_LABELS[s.type as string] || s.type,
            label: s.label || s.tool || STEP_TYPE_LABELS[s.type as string] || s.type,
            layerKey: s.type === 'call_layer' ? (s.layerKey || null) : null,
        }));
}

/** Stop a control click from bubbling to a row's open-on-click handler. */
export const stop = (fn?: (e: React.SyntheticEvent) => void) => (e: React.SyntheticEvent) => { e.stopPropagation(); fn?.(e); };

/** One-line live-progress label for a running flowlet agent. */
export function agentProgressText(st: LayerAgentState | null) {
    if (!st || !st.running) return '';
    const n = Array.isArray(st.toolCalls) ? st.toolCalls.length : 0;
    const last = n ? st.toolCalls[n - 1]?.name : null;
    const pretty = last ? String(last).replace(/^builder_(add_)?/, '').replace(/_/g, ' ') : 'thinking';
    return `Working… ${n} step${n === 1 ? '' : 's'} · ${pretty}`;
}

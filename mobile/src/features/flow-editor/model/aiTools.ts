/**
 * An AI step's tools — `tools: string[]` of catalog function names on the
 * step itself — as three named states, and the attach/detach edits. A port of
 * the pure half of the web builder's flow/aiToolNodes.js, pinned by
 * layout.lockstep.test.ts. The canvas draws tools as chips under the step;
 * they are never steps or edges of their own.
 */

import type { FlowDefinition, FlowStep } from './types';

export interface ToolState {
    /** 'none' — no tools; 'explicit' — exactly `tools` (empty means none); 'all' — legacy, every tool. */
    mode: 'none' | 'explicit' | 'all';
    tools: string[];
}

export function toolStateOf(step: Partial<FlowStep> | null | undefined): ToolState {
    if (!step || step.type !== 'ai_step') return { mode: 'none', tools: [] };
    if (Array.isArray(step.tools)) return { mode: 'explicit', tools: (step.tools as string[]).filter(Boolean) };
    return step.allowTools ? { mode: 'all', tools: [] } : { mode: 'none', tools: [] };
}

function withTools<T extends Partial<FlowDefinition>>(definition: T, idx: number, tools: string[]): T {
    const steps = (definition.steps as FlowStep[]).slice();
    steps[idx] = { ...(steps[idx] as FlowStep), tools, allowTools: tools.length > 0 };
    return { ...definition, steps };
}

function aiStepIndex(definition: Partial<FlowDefinition> | null | undefined, stepId: string): number {
    const steps = definition?.steps || [];
    const idx = steps.findIndex((s) => s?.id === stepId);
    return idx >= 0 && steps[idx]?.type === 'ai_step' ? idx : -1;
}

/**
 * Add `tool` to a step's allowlist; the same object when nothing changes. A
 * legacy "all tools" step is first made explicit from `allToolNames`, so
 * attaching one tool never quietly removes the others.
 */
export function attachTool<T extends Partial<FlowDefinition> | null | undefined>(
    definition: T,
    stepId: string,
    tool: string,
    { allToolNames = [] as string[] } = {},
): T {
    if (!definition || !stepId || !tool) return definition;
    const idx = aiStepIndex(definition, stepId);
    if (idx < 0) return definition;
    const state = toolStateOf(definition.steps?.[idx]);
    const base = state.mode === 'all' ? [...allToolNames] : state.tools;
    if (base.includes(tool)) return definition;
    return withTools(definition, idx, [...base, tool]);
}

/** Remove `tool`; the last one leaves an explicit `[]` ("no tools"), never null. */
export function detachTool<T extends Partial<FlowDefinition> | null | undefined>(definition: T, stepId: string, tool: string): T {
    if (!definition || !stepId || !tool) return definition;
    const idx = aiStepIndex(definition, stepId);
    if (idx < 0) return definition;
    const state = toolStateOf(definition.steps?.[idx]);
    if (state.mode !== 'explicit' || !state.tools.includes(tool)) return definition;
    return withTools(definition, idx, state.tools.filter((t) => t !== tool));
}

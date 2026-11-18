/**
 * What the AI of an app is pointed at, counted from its definition: the knowledge bases its AI
 * steps choose, the AI steps that ask for web search, the browsing steps and the automations it
 * starts. Read for the "What the AI can do" panel (AiCapabilitiesPanel.tsx).
 *
 * Steps nest (branches, loop bodies, try/catch, switch cases), so the walk visits every object
 * under `actions` that carries a `kind`, wherever it sits.
 */

import type { AppDefinition } from './appDefinition';

export interface AiCapabilityUsage {
    knowledgeBases: number;
    webSearchSteps: number;
    browseSteps: number;
    automations: number;
}

const AI_KB_KINDS = new Set(['ai_generate', 'ai_extract', 'kb_query']);
const WEB_SEARCH_KINDS = new Set(['ai_generate', 'ai_extract']);

type Node = Record<string, unknown>;

function eachStep(value: unknown, visit: (step: Node) => void, depth = 0): void {
    if (depth > 40 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) eachStep(item, visit, depth + 1);
        return;
    }
    const node = value as Node;
    if (typeof node.kind === 'string') visit(node);
    for (const child of Object.values(node)) eachStep(child, visit, depth + 1);
}

export function aiCapabilityUsage(definition: AppDefinition | null | undefined): AiCapabilityUsage {
    const kbs = new Set<string>();
    const automations = new Set<string>();
    let webSearchSteps = 0;
    let browseSteps = 0;
    eachStep(definition?.actions, (step) => {
        if (AI_KB_KINDS.has(step.kind as string) && Array.isArray(step.knowledgeBaseIds)) {
            for (const id of step.knowledgeBaseIds) if (typeof id === 'string' && id) kbs.add(id);
        }
        if (WEB_SEARCH_KINDS.has(step.kind as string) && step.webSearch === true) webSearchSteps += 1;
        if (step.kind === 'ai_browse') browseSteps += 1;
        if (step.kind === 'run_automation' && typeof step.automationId === 'string' && step.automationId) automations.add(step.automationId);
    });
    return { knowledgeBases: kbs.size, webSearchSteps, browseSteps, automations: automations.size };
}

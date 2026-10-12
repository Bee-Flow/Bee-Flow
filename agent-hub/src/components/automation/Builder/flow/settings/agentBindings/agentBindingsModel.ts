// The pure part of "Who can call this": which ids a save sends, and which
// sentence a refusal gets. No React, no network.
import type { AgentBindings, BoundAgent } from '../../../../../../api/queries/automation/agentBindings';

/** The ids of the linked agents the viewer can edit (what a save sends). Missing ones are left out: that clears the dead row. */
export function editableIds(bindings: readonly BoundAgent[]): string[] {
    return bindings.filter((b) => b.canEdit && !b.missing && b.agentId).map((b) => b.agentId as string);
}

export function withAgent(bindings: readonly BoundAgent[], id: string): string[] {
    const ids = editableIds(bindings);
    return ids.includes(id) ? ids : [...ids, id];
}

export function withoutAgent(bindings: readonly BoundAgent[], id: string): string[] {
    return editableIds(bindings).filter((x) => x !== id);
}

/** The agents the picker still offers: editable by the viewer, not linked yet. */
export function pickableAgents(data: Pick<AgentBindings, 'bindings' | 'candidates'>) {
    const linked = new Set(editableIds(data.bindings));
    return (data.candidates || []).filter((c) => !linked.has(c.id));
}

/** Dictionary key (and English fallback) for a refused save, by the server's code. */
export function refusalText(code: string | null, status: number): { key: string; fallback: string } {
    switch (code) {
        case 'agent_not_linkable':
            return { key: 'automationAgentBindings.error.agent_not_linkable', fallback: 'You cannot link this automation to that agent. You need edit rights on the agent.' };
        case 'agent_owner_cannot_use':
            return { key: 'automationAgentBindings.error.agent_owner_cannot_use', fallback: 'The owner of this automation cannot use that agent, so it could not call the automation. Publish the agent, or pick one the owner can use.' };
        case 'tool_name_taken':
            return { key: 'automationAgentBindings.error.tool_name_taken', fallback: 'Another automation linked to that agent already uses this tool name. Rename the tool first.' };
        case 'not_agent_call':
            return { key: 'automationAgentBindings.error.not_agent_call', fallback: 'Set the trigger to "Agent tool" and save before linking agents.' };
        case 'automation_forbidden':
            return { key: 'automationAgentBindings.error.forbidden', fallback: 'You need edit rights on this automation to link agents.' };
        default:
            return status === 403
                ? { key: 'automationAgentBindings.error.forbidden', fallback: 'You need edit rights on this automation to link agents.' }
                : { key: 'automationAgentBindings.error.generic', fallback: 'The agents could not be saved. Try again.' };
    }
}

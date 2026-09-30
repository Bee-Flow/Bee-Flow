/**
 * Who may change an agent — the web's gating, fail-closed.
 *
 * Editing needs BOTH halves the server checks on PUT /agents/:id:
 *   - `requirePermission('manage_agents')` on the route, and
 *   - `canModifyAgent`, which the server hands back per agent as `can_edit`
 *     (owner, super admin, or manage_agents in the agent's own org — and an
 *     agent editor only on published agents).
 * An owner without manage_agents gets `can_edit: true` and still a 403 on
 * save, so the permission is asked here too. `=== true`, never `!== false`:
 * an unknown verdict must not paint an Edit button that ends in a refusal.
 *
 * Creating is `manage_agents` alone (POST /agents; the web's AgentStudio shows
 * "New agent" on the same condition).
 */

import type { Agent } from './types';

export function canEditAgent(agent: Pick<Agent, 'can_edit' | 'owner_id'>, manageAgents: boolean): boolean {
    if (agent.owner_id === 'system' || agent.owner_id === 'swarm') return false;
    return manageAgents && agent.can_edit === true;
}

export function canCreateAgents(manageAgents: boolean): boolean {
    return manageAgents;
}

// The requests the Studio agent grid (AgentStudio) sends itself. Each helper
// sends exactly the request the screen used to send inline and hands the
// Response back untouched.

import { API_BASE, authFetch } from '../utils/helpers';

/**
 * GET the agent list. `?usage=1` is opt-in because it is a pass over every
 * automation, app and page (routes/agents/published.js); `/agents/system`
 * does not know the parameter.
 */
export function fetchAgentList(systemMode: boolean, signal: AbortSignal): Promise<Response> {
    const endpoint = systemMode ? `${API_BASE}/agents/system` : `${API_BASE}/agents/all?usage=1`;
    return authFetch(endpoint, { signal });
}

/** DELETE /agents/:id, with `?confirm=1` when the person confirmed an in-use agent. */
export function deleteAgentRequest(agentId: string | number, force: boolean): Promise<Response> {
    return authFetch(`${API_BASE}/agents/${agentId}${force ? '?confirm=1' : ''}`, { method: 'DELETE' });
}

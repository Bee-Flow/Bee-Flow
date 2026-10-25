// The raw reads and writes behind the Agent Hub's data hook (useAgentHubData)
// and its "All Chats" aggregation (useDirectChatEvents). Thin on purpose: each
// returns the Response exactly as authFetch does, because the hooks order,
// race-guard (generation refs, cancelled flags) and interpret the answers
// themselves.

import { API_BASE, authFetch } from '../../utils/helpers';

/** GET the user's favourite agent ids. */
export function fetchAgentFavorites(): Promise<Response> {
    return authFetch(`${API_BASE}/agents/favorites`);
}

/** POST the legacy local favourites for the one-time server migration. */
export function postAgentFavoritesBulk(agentIds: string[]): Promise<Response> {
    return authFetch(`${API_BASE}/agents/favorites/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentIds }),
    });
}

/** GET the agents published in the user's org / groups (never cached). */
export function fetchPublishedAgents(): Promise<Response> {
    return authFetch(`${API_BASE}/agents/published?t=${Date.now()}`, { cache: 'no-store' });
}

/** GET the user's own agents, personal drafts included (never cached). */
export function fetchOwnAgents(): Promise<Response> {
    return authFetch(`${API_BASE}/agents?t=${Date.now()}`, { cache: 'no-store' });
}

/** GET one conversation of an agent, messages included. */
export function fetchAgentConversation(agentId: string, convId: string): Promise<Response> {
    return authFetch(`${API_BASE}/agents/${agentId}/conversations/${convId}`);
}

/** GET every agent conversation of the user (the "All Chats" list). */
export function fetchAllAgentConversations(): Promise<Response> {
    return authFetch(`${API_BASE}/agents/conversations/all`);
}

/** GET the user's direct (agentless) conversations. */
export function fetchDirectConversations(): Promise<Response> {
    return authFetch(`${API_BASE}/ai/direct/conversations`);
}

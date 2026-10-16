// The public embed's one read: the agent as the embed widget may show it.
import { API_BASE, authFetch } from './mutate';

export const fetchEmbedAgent = (agentId: string) => authFetch(`${API_BASE}/agents/${agentId}/embed`);

// What the settings shell reads to decide its rows and counters. Each call
// answers with the raw Response, exactly like authFetch.
import { API_BASE, authFetch } from './mutate';

export const settingsShellApi = {
    agents: () => authFetch(`${API_BASE}/agents/all`),
    memoryStats: () => authFetch(`${API_BASE}/agents/memory/stats`),
    organizations: () => authFetch(`${API_BASE}/auth/organizations`),
    userSettings: () => authFetch(`${API_BASE}/ai/user-settings`),
    linkedinStatus: () => authFetch(`${API_BASE}/api/integrations/linkedin/status`),
    appPasswordStatus: () => authFetch(`${API_BASE}/auth/app-password-status`),
    githubStatus: () => authFetch(`${API_BASE}/api/integrations/github/status`),
};

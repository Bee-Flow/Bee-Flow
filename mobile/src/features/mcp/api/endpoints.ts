/**
 * MCP endpoints, in two unrelated places with adjacent names:
 *
 *   /ai/mcp-servers    — the MCP *client* registry (routes/ai/config/
 *                        integrations.js; the AI router is mounted at /ai, NOT
 *                        /api/ai), behind requireFeature('mcp_marketplace').
 *   /api/mcp-server    — the token for Bee Flow's own MCP *server*
 *                        (routes/mcpServerTokens.js).
 */

import { api } from '@/core/api/client';

import { readMcpServers, readMintedToken, readTokenStatus } from './readers';
import type { McpMintedToken, McpServer, McpTokenStatus } from '../model/types';

/** The MCP servers this Bee Flow talks OUT to. */
export async function listMcpServers(signal?: AbortSignal): Promise<McpServer[]> {
    return readMcpServers(await api.get<unknown>('/ai/mcp-servers', { signal }));
}

/** Whether the caller holds a working token, and where to point a client. */
export async function getMcpTokenStatus(signal?: AbortSignal): Promise<McpTokenStatus> {
    return readTokenStatus(await api.get<unknown>('/api/mcp-server/token', { signal }));
}

/**
 * Mint — or rotate — the caller's token. There is no way to hold two, so this
 * revokes the previous one the instant it succeeds, and the value comes back
 * once. `retry: false` for that reason: a retried POST would mint a second
 * token and silently invalidate the one the first attempt returned.
 */
export async function mintMcpToken(): Promise<McpMintedToken | null> {
    return readMintedToken(await api.post<unknown>('/api/mcp-server/token', undefined, { retry: false }));
}

export async function revokeMcpToken(): Promise<void> {
    await api.delete('/api/mcp-server/token', { retry: false });
}

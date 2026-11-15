// How an MCP client reaches this server, for any client: the address of each
// MCP server, the Authorization header that carries the token, and the
// JSON block most clients read from their configuration file. The
// client-specific command (`claude mcp add`, mcpAccessLib.claudeAddCommand)
// is one tab next to this, never the only way shown. No React, no network.

import { API_BASE } from '../../utils/helpers';
import type { McpServerInfo } from './mcpAccessLib';

/** Stands in for a token the page does not have (the organisation page shows the shape, not a secret). */
export const TOKEN_PLACEHOLDER = '<token>';

const isAbsoluteHttp = (s: string) => {
    const lower = s.toLowerCase();
    return lower.startsWith('http://') || lower.startsWith('https://');
};

const trimSlashes = (s: string) => {
    let end = s.length;
    while (end > 0 && s[end - 1] === '/') end--;
    return s.slice(0, end);
};

/**
 * Where an MCP client reaches this server: what the server says, else the
 * API's own origin when it is absolute, else the page's. `pageOrigin` is
 * injectable for tests.
 */
export function mcpOrigin(fromServer?: string, apiBase: string = API_BASE, pageOrigin: string = window.location.origin): string {
    if (fromServer && isAbsoluteHttp(fromServer)) return trimSlashes(fromServer);
    if (isAbsoluteHttp(apiBase)) return trimSlashes(apiBase);
    return pageOrigin;
}

/** The address of one MCP server. */
export function serverUrl(server: McpServerInfo, origin: string): string {
    return `${trimSlashes(origin)}${server.path}`;
}

/** The header every request of the client carries. */
export function authHeader(token: string): string {
    return `Authorization: Bearer ${token}`;
}

/**
 * The `mcpServers` block of a client configuration file: one HTTP server per
 * entry, named as the command-line tab names it, with the token header.
 */
export function clientConfigJson(servers: readonly McpServerInfo[], origin: string, token: string): string {
    const mcpServers = Object.fromEntries(servers.map(s => [s.clientName, {
        type: 'http',
        url: serverUrl(s, origin),
        headers: { Authorization: `Bearer ${token}` },
    }]));
    return JSON.stringify({ mcpServers }, null, 2);
}

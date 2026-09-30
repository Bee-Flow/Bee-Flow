/** Turning MCP server state into the words and colours the MCP screen uses. */

import type { StatusToken } from '@/features/webpages';

import type { McpServer } from './types';

/**
 * How an MCP server is doing.
 *
 * 'disconnected' is the column default, so it means "never probed" far more
 * often than it means "was up, now down" — worth saying, because the fix is a
 * refresh rather than a call to whoever runs the server.
 */
export function mcpStatus(server: McpServer): StatusToken {
    if (!server.enabled) return { label: 'Disabled', tone: 'neutral' };
    switch (server.status) {
        case 'ready':
            return { label: 'Ready', tone: 'success' };
        case 'pending_credentials':
            return { label: 'Needs a key', tone: 'warning' };
        case 'error':
            return { label: 'Failing', tone: 'error' };
        default:
            return { label: 'Not checked', tone: 'neutral' };
    }
}

/** The one-line explanation under an MCP server's name. */
export function mcpSubtitle(server: McpServer): string {
    const where = server.transport === 'stdio' ? server.command || 'local command' : server.url || server.transport;
    const tools = server.toolCount === 1 ? '1 tool' : `${server.toolCount} tools`;
    return `${tools} · ${where}`;
}

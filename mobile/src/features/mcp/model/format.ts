/** Turning MCP server state into the words and colours the MCP screen uses. */

import { translate } from '@/core/i18n';
import type { StatusToken } from '@/features/webpages';
import { nOf } from '@/shared/lib/plural';

import type { McpServer } from './types';

/**
 * How an MCP server is doing.
 *
 * 'disconnected' is the column default, so it means "never probed" far more
 * often than it means "was up, now down" — worth saying, because the fix is a
 * refresh rather than a call to whoever runs the server.
 */
export function mcpStatus(server: McpServer): StatusToken {
    if (!server.enabled) return { label: translate('common.disabled', 'Disabled'), tone: 'neutral' };
    switch (server.status) {
        case 'ready':
            return { label: translate('skills.state_ready', 'Ready'), tone: 'success' };
        case 'pending_credentials':
            return { label: translate('mobile.mcp.status_needs_key', 'Needs a key'), tone: 'warning' };
        case 'error':
            return { label: translate('compliance.failing', 'Failing'), tone: 'error' };
        default:
            return { label: translate('solutions.card_health_unknown', 'Not checked'), tone: 'neutral' };
    }
}

/** The one-line explanation under an MCP server's name. */
export function mcpSubtitle(server: McpServer): string {
    const where = server.transport === 'stdio' ? server.command || translate('mobile.mcp.local_command', 'local command') : server.url || server.transport;
    const tools = nOf(translate, 'mobile.mcp.tools', server.toolCount, ['{count} tool', '{count} tools']);
    return `${tools} · ${where}`;
}

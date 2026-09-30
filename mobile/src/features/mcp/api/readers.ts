/**
 * Contract readers for the two MCP surfaces: the client registry
 * (`/ai/mcp-servers`, mcpStore.parseRow — raw snake_case, mapped here so
 * `tools_cache` never leaks into a screen) and Bee Flow's own server token
 * (`/api/mcp-server/token`).
 */

import { field, nullable, pick, shapeOf } from '@/core/api/contract';

import type { McpMintedToken, McpServer, McpTokenStatus } from '../model/types';

const readRow = shapeOf({
    id: field.str(''),
    name: field.str(''),
    description: field.str(''),
    icon: field.str(''),
    // Enabled unless the row says false: the column defaults to on.
    enabled: (value: unknown) => value !== false,
    status: field.str('disconnected'),
    error: field.strOrNull,
    transport: field.str('stdio'),
    url: field.strOrNull,
    command: field.strOrNull,
    category: field.strOrNull,
    tools_cache: field.list(shapeOf({ name: field.str(''), description: field.optStr })),
    updated_at: field.strOrNull,
});

function readMcpServer(raw: unknown): McpServer {
    const { tools_cache: tools, updated_at: updatedAt, ...row } = readRow(raw);
    return { ...row, toolCount: tools.length, tools, updatedAt };
}

export function readMcpServers(raw: unknown): McpServer[] {
    return field.list(readMcpServer)(pick(raw, 'servers'));
}

/** `exists` only when the server says exactly true: a stored secret proves nothing on its own. */
export const readTokenStatus: (raw: unknown) => McpTokenStatus = shapeOf({
    exists: field.bool(false),
    url: field.str('/mcp'),
    transport: field.str('streamable_http'),
});

export const readMintedToken: (raw: unknown) => McpMintedToken | null = nullable(
    shapeOf({
        token: field.str(''),
        url: field.str(''),
        transport: field.str(''),
        note: field.optStr,
    }),
);

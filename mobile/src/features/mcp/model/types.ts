/**
 * MCP shapes. McpServer is server/stores/mcpStore.js → parseRow, which is
 * `...row`: raw snake_case straight off the table, which api/readers.ts maps.
 */

/** One tool a server advertised at discovery time. */
export interface McpTool {
    name: string;
    description?: string;
}

/**
 * A configured MCP server, camelCased from the raw row.
 *
 * `status` is written by mcpManager as it probes: 'ready' once tools were
 * discovered, 'pending_credentials' when the server needs a secret nobody has
 * supplied yet, 'error' with `error` set, and 'disconnected' as the column
 * default for a row that has never been probed at all.
 */
export interface McpServer {
    id: string;
    name: string;
    description: string;
    icon: string;
    enabled: boolean;
    status: 'ready' | 'pending_credentials' | 'error' | 'disconnected' | string;
    error: string | null;
    /** 'stdio' for a local command, otherwise an HTTP transport with a url. */
    transport: string;
    url: string | null;
    command: string | null;
    category: string | null;
    toolCount: number;
    tools: McpTool[];
    updatedAt: string | null;
}

/**
 * GET /api/mcp-server/token.
 *
 * `exists` distinguishes "a secret is stored" from "the user holds a working
 * token": revoking overwrites the stored half with a value nobody has and sets
 * a revoke marker, so the presence of a secret proves nothing on its own.
 */
export interface McpTokenStatus {
    exists: boolean;
    /** Absolute when PUBLIC_BASE_URL is set on the server, else the bare '/mcp'. */
    url: string;
    transport: string;
}

/** POST /api/mcp-server/token. `token` is returned once and never again. */
export interface McpMintedToken {
    token: string;
    url: string;
    transport: string;
    note?: string;
}

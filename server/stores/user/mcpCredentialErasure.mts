/**
 * Account erasure, MCP part: the credentials a person entered for MCP servers
 * (`mcp_cred_<serverId>_<key>_user_<userId>`, core/mcpManager.js) and the server
 * processes that run with them.
 *
 * The keys are found by their exact `_user_<userId>` suffix, so another
 * person's credentials for the same server stay. Called from deleteUser
 * (./usersDelete.js).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface McpErasureDeps {
    listKeysWithPrefix: (prefix: string) => Promise<string[]>;
    deleteConfig: (key: string) => Promise<unknown>;
    disconnectUser: (userId: string) => Promise<void>;
}

function defaultDeps(): McpErasureDeps {
    const configStore = nodeRequire('../configStore.js') as Pick<McpErasureDeps, 'listKeysWithPrefix' | 'deleteConfig'>;
    return {
        listKeysWithPrefix: (prefix) => configStore.listKeysWithPrefix(prefix),
        deleteConfig: (key) => configStore.deleteConfig(key),
        disconnectUser: (userId) => (nodeRequire('../../core/mcpManager.js') as Pick<McpErasureDeps, 'disconnectUser'>).disconnectUser(userId),
    };
}

/** Delete one person's MCP credentials and close their MCP connections. Resolves to the number of keys deleted. */
export async function eraseMcpCredentials(userId: string, deps: McpErasureDeps = defaultDeps()): Promise<number> {
    if (typeof userId !== 'string' || !userId) return 0;
    const suffix = `_user_${userId}`;
    const keys = (await deps.listKeysWithPrefix('mcp_cred_')).filter((key) => key.endsWith(suffix));
    for (const key of keys) await deps.deleteConfig(key);
    await deps.disconnectUser(userId);
    return keys.length;
}

/**
 * mcpTokenIssued.mts: the issue record of a user's legacy MCP token, kept in
 * the config table next to the token's stored half as `<key>_issued` =
 * { fp, at }. auth/mcpToken.js decides the lifetime; this module only reads
 * and writes the per-user record.
 *
 * The config store is reached through its module object at call time, so a
 * test can swap its functions (testUtils/swaps).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface McpTokenIssued {
    fp?: string;
    at?: number;
}

interface ConfigStore {
    getConfig(key: string): Promise<unknown>;
    setConfig(key: string, value: unknown): Promise<unknown>;
    deleteConfig(key: string): Promise<unknown>;
}

const configStore = () => nodeRequire('../configStore') as ConfigStore;

/** The stored issue record under `key`, or null. */
export async function readIssued(key: string): Promise<McpTokenIssued | null> {
    return ((await configStore().getConfig(key)) as McpTokenIssued | null) ?? null;
}

/** Store the issue record under `key`. */
export async function writeIssued(key: string, record: { fp: string, at: number }): Promise<void> {
    await configStore().setConfig(key, record);
}

/** Remove the issue record under `key`. */
export async function deleteIssued(key: string): Promise<void> {
    await configStore().deleteConfig(key);
}

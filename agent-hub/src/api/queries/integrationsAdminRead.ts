// What the platform Integrations panel reads when it opens: the default
// integrations and the organisations, the AI config flags, the agent-search
// defaults and the MCP servers. Each group is read as the panel always read
// it: a group that fails is logged and left out, the others still arrive.

import { useQuery } from '@tanstack/react-query';
import { RefusedError } from '../mutate';
import { apiFetch, apiRequest } from '../typedRequest';
import { READ_ONCE } from './readOnce';

type Json = Record<string, unknown>;

export interface IntegrationsAdminRead {
    defaults: unknown;
    hasDefaults: boolean;
    organizations: unknown;
    hasOrganizations: boolean;
    config: Json | null;
    searchDefaults: Json | null;
    mcpServers: unknown[] | null;
}

/** The parsed body of a checked GET, or null when the server refused it. */
async function readRefusable(read: () => Promise<Response>): Promise<Json | null> {
    const res = await read().catch((err: unknown) => {
        if (err instanceof RefusedError) return null;
        throw err;
    });
    return res ? (await res.json()) as Json : null;
}

async function readAll(): Promise<IntegrationsAdminRead> {
    const out: IntegrationsAdminRead = {
        defaults: undefined, hasDefaults: false, organizations: undefined, hasOrganizations: false,
        config: null, searchDefaults: null, mcpServers: null,
    };
    // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
    try {
        const [defRes, orgsRes] = await Promise.all([
            apiFetch('GET /auth/default-integrations'),
            apiFetch('GET /auth/organizations'),
        ]);
        if (defRes.ok) { out.defaults = ((await defRes.json()) as Json).defaults; out.hasDefaults = true; }
        if (orgsRes.ok) { out.organizations = await orgsRes.json(); out.hasOrganizations = true; }
    } catch (e) { console.error(e); }
    // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
    try { out.config = await readRefusable(() => apiRequest('GET /ai/config')); } catch (e) { console.error(e); }
    // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
    try { out.searchDefaults = await readRefusable(() => apiRequest('GET /ai/agent-search/defaults')); } catch (e) { console.error(e); }
    // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed request; nothing reaches another user or a response
    try {
        const mcp = await readRefusable(() => apiRequest('GET /ai/mcp-servers'));
        if (mcp) out.mcpServers = (mcp.servers as unknown[] | undefined) || [];
    } catch (e) { console.error(e); }
    return out;
}

export function useIntegrationsAdminReadQuery() {
    return useQuery<IntegrationsAdminRead, Error>({
        queryKey: ['integrations-admin', 'panel'],
        ...READ_ONCE,
        queryFn: readAll,
    });
}

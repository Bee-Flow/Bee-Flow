/**
 * Everything the Apps picker needs: which apps this user can reach, which of
 * them are switched on, and how to switch one.
 *
 * Extracted from InputArea so the Cowork composer can have the same picker
 * rather than a second copy of it. The four sources are fetched here —
 * the user's integration status, n8n workflows, connected MCP servers and the
 * Reusable Steps published "in chat".
 *
 * `enabledApps` is a *user preference*, not a per-message selection: it is
 * stored server-side and nothing is sent along at submit time. That is why
 * this hook returns no "selected" value — a cowork brief and a chat message
 * draw on the same list, which is also how the backend sees it.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { API_BASE, authFetch } from '../utils/helpers';
import { useIntegrationStatus, type IntegrationStatus } from './useIntegrationStatus';
import { APP_DEFS, buildAppCatalog, filterAvailableApps } from '../components/apps/appCatalog';

/** One entry of the picker. Beside these, each entry carries its own gate
 *  flags (requiresGoogle, isMcp, stepId, …) that filterAvailableApps reads. */
export interface CatalogApp {
    id: string;
    label: string;
    description?: string;
    iconSvg?: (size?: string) => ReactNode;
    [key: string]: unknown;
}

interface N8nWorkflow {
    enabled?: boolean;
    allowKbIngestion?: boolean;
    [key: string]: unknown;
}

interface McpServer {
    toolCount?: number;
    [key: string]: unknown;
}

// appCatalog.jsx is still JavaScript, so TS reads each `= []` / `= null`
// default as that parameter's whole type and rejects every real argument.
// These views state the contract the module documents; they go away when it
// becomes TypeScript.
const buildCatalog = buildAppCatalog as (sources: {
    n8nWorkflows?: N8nWorkflow[];
    mcpServers?: McpServer[];
    exposedSteps?: unknown[];
}) => CatalogApp[];

const filterApps = filterAvailableApps as (apps: CatalogApp[], gates: {
    integrationStatus?: IntegrationStatus;
    orgEnabledIntegrations?: string[] | null;
    agentIntegrations?: string[] | null;
}) => CatalogApp[];

export interface UseAppsCatalogOptions {
    /** The agent's own integration allow-list, when a chat runs as an agent. */
    agentIntegrations?: string[] | null;
}

export interface UseAppsCatalogReturn {
    availableApps: CatalogApp[];
    isAppEnabled: (appId: string) => boolean;
    toggleApp: (appId: string) => void;
}

export default function useAppsCatalog(
    { agentIntegrations = null }: UseAppsCatalogOptions = {},
): UseAppsCatalogReturn {
    // The /ai/user-settings payload, module-cached by the shared hook so this
    // is not a third caller of that endpoint.
    const { integrationStatus } = useIntegrationStatus();

    const [n8nWorkflows, setN8nWorkflows] = useState<N8nWorkflow[]>([]);
    const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
    const [exposedSteps, setExposedSteps] = useState<unknown[]>([]);
    // null = every app enabled. Seeded from the cached settings payload and
    // then owned locally, so toggling never has to invalidate that cache.
    const [enabledApps, setEnabledApps] = useState<string[] | null>(null);
    const [seeded, setSeeded] = useState(false);

    useEffect(() => {
        if (seeded || !integrationStatus) return;
        if (integrationStatus.enabledApps) setEnabledApps(integrationStatus.enabledApps as string[]);
        setSeeded(true);
    }, [integrationStatus, seeded]);

    useEffect(() => {
        let alive = true;
        // All three are best-effort: a 403/404 (beta off, nothing configured)
        // just means that source contributes no apps.
        authFetch(`${API_BASE}/ai/n8n/config`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (alive && data?.workflows?.length) {
                    setN8nWorkflows(data.workflows.filter((w: N8nWorkflow) => w.enabled && !w.allowKbIngestion));
                }
            })
            .catch(() => { });
        authFetch(`${API_BASE}/ai/mcp-servers/user-credentials`)
            .then(r => r.ok ? r.json() : null)
            .then(data => {
                if (alive && data?.servers?.length) {
                    setMcpServers(data.servers.filter((s: McpServer) => (s.toolCount ?? 0) > 0));
                }
            })
            .catch(() => { });
        authFetch(`${API_BASE}/api/step/chat-tools`)
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (alive && Array.isArray(data?.tools)) setExposedSteps(data.tools); })
            .catch(() => { });
        return () => { alive = false; };
    }, []);

    const toggleApp = useCallback((appId: string) => {
        setEnabledApps(prev => {
            const defaults: string[] = APP_DEFS.filter(a => !a.requiresNone).map(a => a.id);
            const current = prev || defaults;
            const next = current.includes(appId)
                ? current.filter(id => id !== appId)
                : [...current, appId];
            // Persist to the server, fire-and-forget: the switch flipping
            // instantly matters more than confirming the write.
            authFetch(`${API_BASE}/ai/user-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabledApps: next }),
            }).catch(() => { });
            return next;
        });
    }, []);

    const isAppEnabled = useCallback(
        (appId: string) => (enabledApps ? enabledApps.includes(appId) : true),
        [enabledApps],
    );

    const availableApps = filterApps(
        buildCatalog({ n8nWorkflows, mcpServers, exposedSteps }),
        {
            integrationStatus: integrationStatus || {},
            orgEnabledIntegrations: (integrationStatus?.orgEnabledIntegrations as string[] | null) ?? null,
            agentIntegrations,
        },
    );

    return { availableApps, isAppEnabled, toggleApp };
}

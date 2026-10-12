import type { McpServerId } from '../../api/queries/mcpAccess';
import { useTranslation } from '../../hooks/useTranslation';

/** The word for an MCP server on screen, in the viewer's language. */
export function useServerName(): (id: McpServerId) => string {
    const { t } = useTranslation();
    return (id) => {
        switch (id) {
            case 'integrations': return t('mcp_access.server.integrations', 'Integrations');
            case 'automations': return t('mcp_access.server.automations', 'Automations');
            case 'studio': return t('mcp_access.server.studio', 'Studio');
            case 'cms': return t('mcp_access.server.cms', 'Website (CMS)');
        }
    };
}

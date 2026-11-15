// Global default-integrations logic of the IntegrationsAdminPanel — the
// combined integrations list, the default toggles and the save call. Each
// toggle saves at once and says so as the panel's toast.
import { useMemo } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { ALL_INTEGRATIONS } from './sections';
import { orderCategories } from '@/config/integrationCatalog';
import type { DefaultIntegration, SetMessage } from './adminPanel.types';
import { apiRequest } from '@/api/typedRequest';

interface McpServerRow {
    id: string;
    name: string;
    description?: string;
    tools_cache?: unknown[];
    icon?: string;
}

interface UseIntegrationDefaultsArgs {
    defaults: string[] | null;
    setDefaults: (defaults: string[] | null) => void;
    setSaving: (saving: boolean) => void;
    setMessage: SetMessage;
    mcpServers: McpServerRow[];
}

export default function useIntegrationDefaults({ defaults, setDefaults, setSaving, setMessage, mcpServers }: UseIntegrationDefaultsArgs) {
    const { t } = useTranslation();
    const saveDefaults = async (newDefaults: string[] | null) => {
        setDefaults(newDefaults);
        setSaving(true);
        try {
            await apiRequest('PUT /auth/default-integrations', { body: { defaults: newDefaults } });
            setMessage({ type: 'success', text: t('admin_platform.defaults_saved', 'Defaults for new organisations saved') });
        } catch {
            setMessage({ type: 'error', text: t('admin_platform.defaults_save_failed', 'Could not save the defaults') });
        }
        setSaving(false);
        setTimeout(() => setMessage(null), 3000);
    };

    // Build combined integrations list: built-in + installed MCP servers
    const allIntegrations = useMemo(() => {
        const mcpIntegrations: DefaultIntegration[] = mcpServers.map(s => {
            const tools = (s.tools_cache || []).length;
            return {
                id: `mcp:${s.id}`,
                label: s.name,
                description: s.description || (tools === 1
                    ? t('admin_platform.mcp_tools_one', '1 tool')
                    : t('admin_platform.mcp_tools_many', '{count} tools', { count: tools })),
                category: 'MCP',
                icon: s.icon || '🔌',
            };
        });
        return [...ALL_INTEGRATIONS, ...mcpIntegrations];
    }, [mcpServers, t]);

    const isDefaultEnabled = (id: string) => !defaults || defaults.includes(id);
    const toggleDefault = (id: string) => {
        if (defaults === null) {
            // Switch from "all enabled" to custom — enable all except this one
            saveDefaults(allIntegrations.map(i => i.id).filter(x => x !== id));
        } else {
            const newDefaults = defaults.includes(id)
                ? defaults.filter(x => x !== id)
                : [...defaults, id];
            // If all are enabled, switch back to null
            saveDefaults(newDefaults.length === allIntegrations.length ? null : newDefaults);
        }
    };

    const enableAllDefaults = () => saveDefaults(null);
    const disableAllDefaults = () => saveDefaults([]);

    const categories = orderCategories([...new Set(allIntegrations.map(i => i.category))]);

    return {
        saveDefaults,
        allIntegrations,
        isDefaultEnabled,
        toggleDefault,
        enableAllDefaults,
        disableAllDefaults,
        categories,
    };
}

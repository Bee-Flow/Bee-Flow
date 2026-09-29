// Global default-integrations logic of the IntegrationsAdminPanel — the
// combined integrations list, the default toggles and the save call, moved
// verbatim from IntegrationsAdminPanel.jsx.
import { useMemo } from 'react';
import { ALL_INTEGRATIONS } from './sections';
import { orderCategories } from '../../../config/integrationCatalog';
import { API_BASE, authFetch } from '../../../utils/helpers';

export default function useIntegrationDefaults({ defaults, setDefaults, setSaving, setMessage, mcpServers }) {
    const saveDefaults = async (newDefaults) => {
        setDefaults(newDefaults);
        setSaving(true);
        try {
            await authFetch(`${API_BASE}/auth/default-integrations`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ defaults: newDefaults }),
            });
            setMessage({ type: 'success', text: 'Default integrations updated' });
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to save' });
        }
        setSaving(false);
        setTimeout(() => setMessage(null), 3000);
    };

    // Build combined integrations list: built-in + installed MCP servers
    const allIntegrations = useMemo(() => {
        const mcpIntegrations = mcpServers.map(s => ({
            id: `mcp:${s.id}`,
            label: s.name,
            description: s.description || `${(s.tools_cache || []).length} tool(s)`,
            category: 'MCP',
            icon: s.icon || '🔌',
        }));
        return [...ALL_INTEGRATIONS, ...mcpIntegrations];
    }, [mcpServers]);

    const isDefaultEnabled = (id) => !defaults || defaults.includes(id);
    const toggleDefault = (id) => {
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

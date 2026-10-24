import React, { useEffect, useState, useCallback } from 'react';
import { Cloud, Save, Loader2, Check, AlertTriangle, ChevronRight, Users } from 'lucide-react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorMessage } from '../../../utils/caughtError';

interface NcCatalogItem {
    id: string;
    name: string;
    description: string;
}

interface NcIntegrationsConfig {
    ncCatalog?: NcCatalogItem[];
    enabled: string[];
    usingDefaults?: boolean;
}

interface NcGroup {
    id: string;
    name: string;
    disabledIntegrations?: string[];
    userCount: number;
}

interface FlashMessage {
    type: 'ok' | 'error';
    text: string | undefined;
}

interface OrgNcIntegrationsPanelProps {
    user?: { organizationId?: string } | null;
}

/**
 * Org-admin UI for toggling Nextcloud integrations org-wide and adding
 * per-group exceptions. Only rendered for NC-bound organisations (gated
 * by user.ncOrg upstream in IntegrationsSection / OrganisationSection).
 *
 * Conflict resolution at runtime is "enable wins" — see
 * server/core/integrationTools.js isAppOn().
 */
const OrgNcIntegrationsPanel = ({ user }: OrgNcIntegrationsPanelProps) => {
    const { t } = useTranslation();
    const orgId = user?.organizationId;
    const [config, setConfig] = useState<NcIntegrationsConfig | null>(null);          // { ncCatalog, enabled, usingDefaults }
    const [groups, setGroups] = useState<NcGroup[]>([]);             // [{ id, name, disabledIntegrations, userCount }]
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<FlashMessage | null>(null);
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!orgId) return;
        try {
            const [cfgRes, grpRes] = await Promise.all([
                authFetch(`${API_BASE}/auth/admin/${orgId}/nc-integrations`),
                authFetch(`${API_BASE}/auth/admin/${orgId}/nc-integrations/groups`),
            ]);
            if (cfgRes.ok) setConfig(await cfgRes.json());
            if (grpRes.ok) setGroups((await grpRes.json()).groups || []);
        } catch (e) {
            console.error('[NcIntegrations] load:', e);
        } finally { setLoading(false); }
    }, [orgId]);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (!message) return;
        const t = setTimeout(() => setMessage(null), 4000);
        return () => clearTimeout(t);
    }, [message]);

    const toggleOrgWide = (id: string) => {
        if (!config) return;
        const next = config.enabled.includes(id)
            ? config.enabled.filter((x: string) => x !== id)
            : [...config.enabled, id];
        setConfig({ ...config, enabled: next });
    };

    const handleSaveOrg = async () => {
        if (!config) return;
        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/auth/admin/${orgId}/nc-integrations`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: config.enabled }),
            });
            if (!res.ok) throw new Error('Save failed');
            setMessage({ type: 'ok', text: 'Saved' });
        } catch (e) {
            setMessage({ type: 'error', text: errorMessage(e) });
        } finally { setSaving(false); }
    };

    const toggleGroupDisable = async (groupId: string, integrationId: string) => {
        const group = groups.find((g: NcGroup) => g.id === groupId);
        if (!group) return;
        const cur = Array.isArray(group.disabledIntegrations) ? group.disabledIntegrations : [];
        const next = cur.includes(integrationId)
            ? cur.filter((x: string) => x !== integrationId)
            : [...cur, integrationId];
        // Optimistic
        setGroups((gs: NcGroup[]) => gs.map((g: NcGroup) => g.id === groupId ? { ...g, disabledIntegrations: next } : g));
        try {
            const res = await authFetch(`${API_BASE}/auth/admin/${orgId}/nc-integrations/groups/${encodeURIComponent(groupId)}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ disabledIntegrations: next }),
            });
            if (!res.ok) throw new Error('Save failed');
        } catch (e) {
            // Revert on failure
            setGroups((gs: NcGroup[]) => gs.map((g: NcGroup) => g.id === groupId ? { ...g, disabledIntegrations: cur } : g));
            setMessage({ type: 'error', text: errorMessage(e) });
        }
    };

    if (loading) {
        return <div className="p-6"><Loader2 className="w-5 h-5 animate-spin text-[var(--text-muted)]" /></div>;
    }
    if (!config) {
        return <div className="p-6 text-sm text-[var(--text-muted)]">{t('integ.org_nc_integrations_nextcloud_integrations_are_only', 'Nextcloud integrations are only available for organisations bound to a Nextcloud instance.')}</div>;
    }

    const catalog = config.ncCatalog || [];

    return (
        <div className="space-y-5">
            <header className="flex items-center gap-2">
                <Cloud className="w-5 h-5 [color:#0082C9]" />
                <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('integ.org_nc_integrations_nextcloud_integrations', 'Nextcloud integrations')}</h2>
            </header>
            <p className="text-sm text-[var(--text-muted)]">
                {t('integ.org_nc_integrations_choose_which_nextcloud_tools_your', 'Choose which Nextcloud tools your agents may use, and exclude specific groups. A user keeps a tool as long as at least one of their groups still allows it.')}
            </p>

            {/* Org-wide toggles */}
            <section className="rounded-2xl p-5 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                <div className="flex items-center justify-between mb-3">
                    <div>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('integ.org_nc_integrations_org_wide', 'Org-wide')}</h3>
                        <p className="text-xs text-[var(--text-muted)]">{t('integ.org_nc_integrations_default_for_every_member_of_this', 'Default for every member of this organisation.')}</p>
                    </div>
                    <button
                        onClick={handleSaveOrg}
                        disabled={saving}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[13px] font-medium text-white transition-opacity disabled:opacity-50 bg-[var(--accent-primary)]"
                    >
                        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                        {t('integ.org_nc_integrations_save', 'Save')}
                    </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {catalog.map((it: NcCatalogItem) => {
                        const on = config.enabled.includes(it.id);
                        return (
                            <label
                                key={it.id}
                                className="flex items-start gap-3 p-3 rounded-xl cursor-pointer transition-colors"
                                style={{ background: on ? 'rgba(0,130,201,0.06)' : 'var(--bg-tertiary)', border: `1px solid ${on ? 'rgba(0,130,201,0.30)' : 'var(--border-subtle)'}` }}
                            >
                                <input
                                    type="checkbox"
                                    checked={on}
                                    onChange={() => toggleOrgWide(it.id)}
                                    className="mt-0.5 accent-[#0082C9]"
                                />
                                <div className="min-w-0">
                                    <div className="text-[13px] font-medium text-[var(--text-primary)]">{it.name}</div>
                                    <div className="text-[11px] text-[var(--text-muted)]">{it.description}</div>
                                </div>
                            </label>
                        );
                    })}
                </div>
                {message && (
                    <p className={`mt-3 text-xs flex items-center gap-1.5 ${message.type === 'error' ? 'text-red-500' : 'text-green-600'}`}>
                        {message.type === 'error' ? <AlertTriangle className="w-3.5 h-3.5" /> : <Check className="w-3.5 h-3.5" />}
                        {message.text}
                    </p>
                )}
            </section>

            {/* Per-group exceptions */}
            <section className="rounded-2xl p-5 [background:var(--bg-secondary)] [border:1px_solid_var(--border-subtle)]">
                <div className="mb-3">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('integ.org_nc_integrations_per_group_exceptions', 'Per-group exceptions')}</h3>
                    <p className="text-xs text-[var(--text-muted)]">
                        {t('integ.org_nc_integrations_disable_specific_tools_for_a_nextcloud', 'Disable specific tools for a Nextcloud group. Groups inherit the org-wide settings unless something is checked below.')}
                    </p>
                </div>
                {groups.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">{t('integ.org_nc_integrations_no_nextcloud_groups_synced_yet_sync', 'No Nextcloud groups synced yet. Sync runs automatically every 6 hours, or use "Sync now" in Nextcloud Sync.')}</p>
                ) : (
                    <div className="space-y-1.5">
                        {groups.map((g: NcGroup) => {
                            const isOpen = expandedGroup === g.id;
                            const disabledCount = (g.disabledIntegrations || []).length;
                            return (
                                <div key={g.id} className="rounded-xl overflow-hidden [background:var(--bg-tertiary)] [border:1px_solid_var(--border-subtle)]">
                                    <button
                                        type="button"
                                        onClick={() => setExpandedGroup(isOpen ? null : g.id)}
                                        className="w-full flex items-center gap-3 px-4 py-2.5 text-left"
                                    >
                                        <ChevronRight className="w-3.5 h-3.5 transition-transform" style={{ color: 'var(--text-muted)', transform: isOpen ? 'rotate(90deg)' : 'none' }} />
                                        <span className="text-[13px] font-medium flex-1 truncate text-[var(--text-primary)]">{g.name}</span>
                                        <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                                            <Users className="w-3 h-3" /> {g.userCount}
                                        </span>
                                        {disabledCount > 0 && (
                                            <span className="text-[11px] px-1.5 py-0.5 rounded [background:rgba(245,158,11,0.15)] [color:#d97706]!">
                                                {t('integ.org_nc_integrations_disabled_count', '{count} disabled', { count: disabledCount })}
                                            </span>
                                        )}
                                    </button>
                                    {isOpen && (
                                        <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5 [border-top:1px_solid_var(--border-subtle)]">
                                            {catalog.map((it: NcCatalogItem) => {
                                                const orgOn = config.enabled.includes(it.id);
                                                const groupDisabled = (g.disabledIntegrations || []).includes(it.id);
                                                return (
                                                    <label
                                                        key={it.id}
                                                        className={`flex items-center gap-2 p-2 rounded-lg text-[12px] ${orgOn ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
                                                        title={orgOn ? `Block ${it.name} for this group` : 'Enable org-wide first'}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            disabled={!orgOn}
                                                            checked={groupDisabled}
                                                            onChange={() => orgOn && toggleGroupDisable(g.id, it.id)}
                                                            className="accent-amber-500"
                                                        />
                                                        <span className="text-[var(--text-primary)]">{t('integ.org_nc_integrations_disable_name', 'Disable {name}', { name: it.name })}</span>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );
};

export default OrgNcIntegrationsPanel;

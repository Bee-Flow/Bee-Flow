import React, { useState } from 'react';
import { TranslateParams, useTranslation } from '@/hooks/useTranslation';
import useConfirm from '../../shared/useConfirm';
import { RefusedError, errorBody } from '@/api/mutate';
import { useAdminOrgScope, withOrgIdParam } from '@/api/adminOrgScope';
import OrgGlobalTiersList from './OrgGlobalTiersList';
import { apiRequest } from '@/api/typedRequest';
import { useCustomTiersRead, type AvailableModel, type OrgTier } from './useCustomTiersRead';

interface PanelMessage {
    type: 'success' | 'warning' | 'error';
    text: string;
}

const TASK_TYPES = [
    { key: 'direct_chat', labelKey: 'admin_org.custom_tiers_direct_chat', label: 'Direct Chat' },
    { key: 'agent_chat', labelKey: 'admin_org.custom_tiers_agent_chat', label: 'Agent Chat' },
];

const slugifyTierLabel = (label: unknown) => {
    const slug = String(label || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/[\s_]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    return slug ? `custom:${slug}` : '';
};

/**
 * Org-admin-facing custom tier editor. Operates on /ai/config/org-custom-chat-models
 * — tiers saved here are scoped to the caller's organisation only. Global custom
 * tiers (created by the super admin) are shown read-only for reference.
 */
const OrgCustomTiersPanel = () => {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    // The organisation an AdminOrgScopeProvider names (the dashboard's choice), else the caller's own:
    // GET takes it as ?orgId, the save in its body.
    const scopeOrgId = useAdminOrgScope();
    const [orgTiers, setOrgTiers] = useState<OrgTier[]>([]);
    const [globalTiers, setGlobalTiers] = useState<OrgTier[]>([]);
    const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<PanelMessage | null>(null);
    const [expandedId, setExpandedId] = useState<string | null>(null);

    // Each answer seeds the working copy; the editor then changes it until it is saved.
    const loading = useCustomTiersRead(scopeOrgId, (d) => {
        if (d.orgTiers) setOrgTiers(d.orgTiers);
        if (d.globalTiers) setGlobalTiers(d.globalTiers);
        if (d.models) setAvailableModels(d.models);
        if (d.forbidden) setMessage({ type: 'error', text: 'You do not have permission to manage custom tiers for your organisation.' });
        if (d.failed) setMessage({ type: 'error', text: t('admin_org.custom_tiers_load_failed', 'Failed to load custom tiers.') });
    });

    const addTier = () => {
        let n = orgTiers.length + 1;
        let placeholderId = `custom:org-tier-${n}`;
        while (orgTiers.some(t => t.id === placeholderId)) { n += 1; placeholderId = `custom:org-tier-${n}`; }
        const next = [
            ...orgTiers,
            {
                id: placeholderId,
                label: `New tier ${n}`,
                icon: '✨',
                description: '',
                modelId: '',
                euModelId: '',
                maxTokens: 16384,
                temperature: 0.7,
                allowedTaskTypes: ['direct_chat', 'agent_chat'],
            },
        ];
        setOrgTiers(next);
        setExpandedId(placeholderId);
    };

    const patch = (id: string, patchObj: Partial<OrgTier>) => {
        setOrgTiers(prev => prev.map(t => t.id === id ? { ...t, ...patchObj } : t));
    };

    const rename = (currentId: string, newLabel: string) => {
        const slug = slugifyTierLabel(newLabel);
        // The id follows the name, but never onto another tier's id: every edit
        // finds its tier by id, so two tiers sharing one would be edited as one.
        const newId = slug && !orgTiers.some(t => t.id === slug && t.id !== currentId) ? slug : currentId;
        setOrgTiers(prev => prev.map(t => {
            if (t.id !== currentId) return t;
            return { ...t, label: newLabel, id: newId };
        }));
        if (newId !== currentId) setExpandedId(newId);
    };

    const remove = async (id: string) => {
        if (!(await confirm({ title: t('admin_org.custom_tiers_delete_title', 'Delete this custom tier?'), description: t('admin_org.custom_tiers_delete_desc', 'This cannot be undone.'), confirmLabel: t('admin_org.custom_tiers_delete', 'Delete'), destructive: true }))) return;
        setOrgTiers(prev => prev.filter(t => t.id !== id));
    };

    const toggleTaskType = (id: string, key: string) => {
        setOrgTiers(prev => prev.map(t => {
            if (t.id !== id) return t;
            const set = new Set(t.allowedTaskTypes || []);
            if (set.has(key)) set.delete(key);
            else set.add(key);
            return { ...t, allowedTaskTypes: Array.from(set) };
        }));
    };

    const save = async () => {
        setSaving(true);
        try {
            let res: Response | undefined;
            try {
                res = await apiRequest('POST /ai/config/org-custom-chat-models', { body: scopeOrgId ? { tiers: orgTiers, orgId: scopeOrgId } : { tiers: orgTiers } });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                setMessage({ type: 'error', text: body.error || t('admin_org.custom_tiers_save_failed', 'Failed to save') });
            }
            if (res) {
                const data = await res.json();
                if (Array.isArray(data.tiers)) setOrgTiers(data.tiers);
                const warn = Array.isArray(data.warnings) && data.warnings.length > 0
                    ? ` (${data.warnings.join('; ')})`
                    : '';
                setMessage({ type: warn ? 'warning' : 'success', text: t('admin_org.custom_tiers_saved', 'Org custom tiers saved{warn}', { warn }) });
            }
        } catch (e) {
            setMessage({ type: 'error', text: t('admin_org.custom_tiers_save_failed', 'Failed to save') });
        } finally {
            setSaving(false);
            setTimeout(() => setMessage(null), 4000);
        }
    };

    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_org.custom_tiers_loading', 'Loading custom tiers...')}</div>;

    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden">
            <div className="px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-center justify-between">
                <div>
                    <h3 className="text-base font-semibold text-[var(--text-primary)]">{t('admin_org.custom_tiers_title', 'Organisation Custom Tiers')}</h3>
                    <p className="text-xs text-[var(--text-muted)] mt-0.5">
                        {t('admin_org.custom_tiers_subtitle', 'Create tiers scoped to this organisation. They appear alongside global tiers for your members.')}
                    </p>
                </div>
                <button
                    onClick={addTier}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--accent-primary)] hover:opacity-90 transition-opacity"
                >
                    {t('admin_org.custom_tiers_add', '+ Add Tier')}
                </button>
            </div>

            {message && (
                <div className={`mx-5 mt-4 p-3 rounded-lg text-sm ${
                    message.type === 'success' ? 'bg-green-500/20 text-green-400' :
                    message.type === 'warning' ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-red-500/20 text-red-400'
                }`}>
                    {message.text}
                </div>
            )}

            <OrgCustomTiersPanelSection orgTiers={orgTiers} t={t} expandedId={expandedId} availableModels={availableModels} patch={patch} rename={rename} setExpandedId={setExpandedId} remove={remove} toggleTaskType={toggleTaskType} save={save} saving={saving} globalTiers={globalTiers} />
            {confirmDialog}
        </div>
    );
};

export default OrgCustomTiersPanel;

function OrgCustomTiersPanelSection({ orgTiers, t, expandedId, availableModels, patch, rename, setExpandedId, remove, toggleTaskType, save, saving, globalTiers }: { orgTiers: OrgTier[]; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; expandedId: string | null; availableModels: AvailableModel[]; patch: (id: string, patchObj: Partial<OrgTier>) => void; rename: (currentId: string, newLabel: string) => void; setExpandedId: React.Dispatch<React.SetStateAction<string | null>>; remove: (id: string) => Promise<void>; toggleTaskType: (id: string, key: string) => void; save: () => Promise<void>; saving: boolean; globalTiers: OrgTier[]; }) {
    return <div className="p-5 space-y-4">
        {orgTiers.length === 0 ? (
            <div className="p-4 rounded-lg border text-center text-xs border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                {t('admin_org.custom_tiers_none_a', 'No organisation-scoped tiers yet. Click')} <strong>{t('admin_org.custom_tiers_none_b', 'Add Tier')}</strong> {t('admin_org.custom_tiers_none_c', 'to create one.')}
            </div>
        ) : (
            orgTiers.map((tier, position) => {
                const isExpanded = expandedId === tier.id;
                const taskTypes = new Set(tier.allowedTaskTypes || []);
                const modelOption = availableModels.find(m => m.id === tier.modelId);
                const euOption = availableModels.find(m => m.id === tier.euModelId);
                return (
                    // Keyed by position: the id follows the name, and a key that changed on
                    // every keystroke remounted the card and took the focus out of the name field.
                    <div key={position} className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] overflow-hidden">
                        <div className="p-4">
                            <div className="flex items-center gap-3 mb-3">
                                <input
                                    type="text"
                                    value={tier.icon || ''}
                                    onChange={e => patch(tier.id, { icon: e.target.value.slice(0, 4) })}
                                    maxLength={4}
                                    className="w-12 text-center text-xl px-1 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] outline-none" />
                                <div className="flex-1 min-w-0">
                                    <input
                                        type="text"
                                        value={tier.label || ''}
                                        onChange={e => rename(tier.id, e.target.value)}
                                        placeholder={t('admin_org.custom_tiers_name_ph', 'Tier name')}
                                        className="w-full text-sm font-semibold px-2 py-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] outline-none" />
                                    <p className="text-[10px] mt-0.5 font-mono text-[var(--text-muted)]">{tier.id}</p>
                                </div>
                                <span className="text-[10px] px-2 py-0.5 rounded-full [background:rgba(234,179,8,0.2)] [color:#eab308]!">{t('admin_org.custom_tiers_org', 'org')}</span>
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : tier.id)}
                                    className="text-xs px-2 py-1 rounded-lg hover:bg-white/10 text-[var(--text-muted)]"
                                >
                                    {isExpanded ? '▲' : '▼'}
                                </button>
                                <button
                                    onClick={() => remove(tier.id)}
                                    className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-red-500/20 text-[var(--text-muted)]"
                                    title={t('admin_org.custom_tiers_delete', 'Delete')}
                                >✕</button>
                            </div>

                            <input
                                type="text"
                                value={tier.description || ''}
                                onChange={e => patch(tier.id, { description: e.target.value })}
                                placeholder={t('admin_org.custom_tiers_desc_ph', 'Short description (shown in tier picker)')}
                                className="w-full text-xs px-3 py-2 mb-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] outline-none" />

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)]">{t('admin_org.custom_tiers_model', 'Model')}</label>
                                    <select
                                        value={tier.modelId || ''}
                                        onChange={e => patch(tier.id, { modelId: e.target.value })}
                                        className="w-full px-3 py-2 mt-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] text-sm outline-none"
                                    >
                                        <option value="">{t('admin_org.custom_tiers_not_configured', 'Not configured')}</option>
                                        {availableModels.map(m => (
                                            <option key={m.id} value={m.id}>{m.name || m.id} ({m.providerName})</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)]">{t('admin_org.custom_tiers_eu_override', 'EU override (optional)')}</label>
                                    <select
                                        value={tier.euModelId || ''}
                                        onChange={e => patch(tier.id, { euModelId: e.target.value })}
                                        className="w-full px-3 py-2 mt-1 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] text-sm outline-none"
                                    >
                                        <option value="">{t('admin_org.custom_tiers_same_as_main', 'Same as main model')}</option>
                                        {availableModels.map(m => (
                                            <option key={m.id} value={m.id}>{m.name || m.id} ({m.providerName})</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="mt-3">
                                <div className="text-[10px] font-semibold uppercase tracking-wider mb-1.5 text-[var(--text-muted)]">
                                    {t('admin_org.custom_tiers_available_for', 'Available for')}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {TASK_TYPES.map(tt => {
                                        const active = taskTypes.has(tt.key);
                                        return (
                                            <button
                                                key={tt.key}
                                                type="button"
                                                onClick={() => toggleTaskType(tier.id, tt.key)}
                                                className="px-2.5 py-1 rounded-full text-xs font-medium"
                                                style={{
                                                    background: active ? 'var(--accent-primary)' : 'var(--bg-secondary)',
                                                    color: active ? '#fff' : 'var(--text-muted)',
                                                    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
                                                }}
                                            >
                                                {active ? '✓ ' : ''}{t(tt.labelKey, tt.label)}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>

                        {isExpanded && (
                            <div className="px-4 pb-4 pt-1 border-t border-[var(--border-subtle)] grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.custom_tiers_max_tokens', 'Max Tokens')}</label>
                                    <input
                                        type="number"
                                        value={tier.maxTokens ?? 16384}
                                        onChange={e => patch(tier.id, { maxTokens: parseInt(e.target.value) || 16384 })}
                                        min={256} max={131072} step={256}
                                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] text-sm outline-none" />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.custom_tiers_temperature', 'Temperature')}</label>
                                    <input
                                        type="number"
                                        value={tier.temperature ?? 0.7}
                                        onChange={e => patch(tier.id, { temperature: parseFloat(e.target.value) || 0.7 })}
                                        min={0} max={2} step={0.1}
                                        className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)] text-sm outline-none" />
                                </div>
                            </div>
                        )}
                    </div>
                );
            })
        )}

        <button
            onClick={save}
            disabled={saving}
            className="px-6 py-2.5 rounded-lg font-medium text-sm text-white bg-[var(--accent-primary)] hover:opacity-90 disabled:opacity-50"
        >
            {saving ? t('admin_org.custom_tiers_saving', 'Saving...') : t('admin_org.custom_tiers_save', 'Save Organisation Tiers')}
        </button>

        <OrgGlobalTiersList tiers={globalTiers} />
    </div>;
}

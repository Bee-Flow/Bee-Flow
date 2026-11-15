import React, { useState } from 'react';
import { TranslateParams, useTranslation } from '@/hooks/useTranslation';
import useConfirm from '../../shared/useConfirm';
import { RefusedError, errorBody } from '@/api/mutate';
import { useAdminOrgScope } from '@/api/adminOrgScope';
import OrgGlobalTiersList from './OrgGlobalTiersList';
import OrgServerTiersList from './OrgServerTiersList';
import SaveStatus from '@/components/shared/SaveStatus';
import { Plus } from 'lucide-react';
import { apiRequest } from '@/api/typedRequest';
import { useCustomTiersRead, type AvailableModel, type OrgTier } from './useCustomTiersRead';
import { Button } from '@/components/shared/Button';
import SaveFooter from '@/components/shared/SaveFooter';
import { ALERT_ERROR, ALERT_SUCCESS, ALERT_WARNING, CHIP } from '@/components/shared/adminUi';

/** A field of the tier cards: the theme's field look, a little smaller. */
const FIELD = 'w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]';
const ALERT_OF: Record<PanelMessage['type'], string> = { success: ALERT_SUCCESS, warning: ALERT_WARNING, error: ALERT_ERROR };

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
    // The tiers as last read or saved: the form is dirty while it differs, and Cancel goes back to it.
    const [baseline, setBaseline] = useState<OrgTier[]>([]);
    const [savedAt, setSavedAt] = useState<Date | null>(null);
    const [saveFailed, setSaveFailed] = useState(false);

    // Each answer seeds the working copy; the editor then changes it until it is saved.
    const loading = useCustomTiersRead(scopeOrgId, (d) => {
        if (d.orgTiers) { setOrgTiers(d.orgTiers); setBaseline(d.orgTiers); }
        if (d.globalTiers) setGlobalTiers(d.globalTiers);
        if (d.models) setAvailableModels(d.models);
        if (d.forbidden) setMessage({ type: 'error', text: t('admin_people.custom_tiers_forbidden', 'You do not have permission to manage custom tiers for this organisation.') });
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
        setSaveFailed(false);
        try {
            let res: Response | undefined;
            try {
                res = await apiRequest('POST /ai/config/org-custom-chat-models', { body: scopeOrgId ? { tiers: orgTiers, orgId: scopeOrgId } : { tiers: orgTiers } });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err) ?? {};
                setSaveFailed(true);
                setMessage({ type: 'error', text: body.error || t('admin_org.custom_tiers_save_failed', 'Failed to save') });
            }
            if (res) {
                const data = await res.json();
                const stored: OrgTier[] = Array.isArray(data.tiers) ? data.tiers : orgTiers;
                setOrgTiers(stored);
                setBaseline(stored);
                setSavedAt(new Date());
                const warn = Array.isArray(data.warnings) && data.warnings.length > 0
                    ? ` (${data.warnings.join('; ')})`
                    : '';
                setMessage({ type: warn ? 'warning' : 'success', text: t('admin_org.custom_tiers_saved', 'Org custom tiers saved{warn}', { warn }) });
            }
        } catch {
            setSaveFailed(true);
            setMessage({ type: 'error', text: t('admin_org.custom_tiers_save_failed', 'Failed to save') });
        } finally {
            setSaving(false);
            setTimeout(() => setMessage(m => (m?.type === 'error' ? m : null)), 4000);
        }
    };

    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_org.custom_tiers_loading', 'Loading custom tiers...')}</div>;

    const dirty = JSON.stringify(orgTiers) !== JSON.stringify(baseline);
    // Save appears once there is something to save (or a save to retry): never a disabled
    // button under an empty list. After a save the status line says so.
    const footer = dirty || saving || saveFailed ? (
        <SaveFooter
            onSave={() => void save()}
            onCancel={dirty ? () => setOrgTiers(baseline) : undefined}
            saving={saving}
            dirty={dirty}
            saveState={saving ? 'saving' : saveFailed ? 'error' : savedAt ? 'saved' : 'idle'}
            onRetry={() => void save()}
            lastSavedAt={savedAt}
        />
    ) : savedAt ? (
        <SaveStatus saveState="saved" lastSavedAt={savedAt} />
    ) : null;

    return (
        <div className="space-y-6">
            <OrgServerTiersList models={availableModels} />
            <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
                <div className="px-5 py-4 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] flex items-center justify-between gap-4">
                    <div>
                        <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('admin_polish.tiers_org_title', 'Organisation custom tiers')}</h3>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">
                            {t('admin_org.custom_tiers_subtitle', 'Create tiers scoped to this organisation. They appear alongside global tiers for your members.')}
                        </p>
                    </div>
                    <Button variant="primary" size="sm" onClick={addTier}>
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('admin_polish.tiers_add', 'Add tier')}
                    </Button>
                </div>

                {message && message.type !== 'success' && (
                    <div className={`mx-5 mt-4 ${ALERT_OF[message.type]}`} role={message.type === 'error' ? 'alert' : 'status'}>
                        {message.text}
                    </div>
                )}

                <OrgCustomTiersPanelSection orgTiers={orgTiers} t={t} expandedId={expandedId} availableModels={availableModels} patch={patch} rename={rename} setExpandedId={setExpandedId} remove={remove} toggleTaskType={toggleTaskType} footer={footer} globalTiers={globalTiers} />
                {confirmDialog}
            </div>
        </div>
    );
};

export default OrgCustomTiersPanel;

function OrgCustomTiersPanelSection({ orgTiers, t, expandedId, availableModels, patch, rename, setExpandedId, remove, toggleTaskType, footer, globalTiers }: { orgTiers: OrgTier[]; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; expandedId: string | null; availableModels: AvailableModel[]; patch: (id: string, patchObj: Partial<OrgTier>) => void; rename: (currentId: string, newLabel: string) => void; setExpandedId: React.Dispatch<React.SetStateAction<string | null>>; remove: (id: string) => Promise<void>; toggleTaskType: (id: string, key: string) => void; footer: React.ReactNode; globalTiers: OrgTier[]; }) {
    return <div className="p-5 space-y-4">
        {orgTiers.length === 0 ? (
            <div className="p-4 rounded-lg border border-dashed text-center text-xs border-[var(--border-default)] text-[var(--text-muted)]">
                {t('admin_polish.tiers_none', 'This organisation has no custom tiers yet. Add one to give your members a tier with a model you choose.')}
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
                    <div key={position} className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] overflow-hidden">
                        <div className="p-4">
                            <div className="flex items-center gap-3 mb-3">
                                <input
                                    type="text"
                                    value={tier.icon || ''}
                                    onChange={e => patch(tier.id, { icon: e.target.value.slice(0, 4) })}
                                    maxLength={4}
                                    aria-label={t('admin_people.custom_tiers_icon', 'Icon')}
                                    className={`w-12 text-center text-xl px-1 py-1 ${FIELD}`} />
                                <div className="flex-1 min-w-0">
                                    <input
                                        type="text"
                                        value={tier.label || ''}
                                        onChange={e => rename(tier.id, e.target.value)}
                                        placeholder={t('admin_org.custom_tiers_name_ph', 'Tier name')}
                                        className={`text-sm font-semibold px-2 py-1 ${FIELD}`} />
                                    <p className="text-[10px] mt-0.5 font-mono text-[var(--text-muted)]">{tier.id}</p>
                                </div>
                                <span className={CHIP}>{t('admin_org.custom_tiers_org', 'org')}</span>
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : tier.id)}
                                    aria-expanded={isExpanded}
                                    aria-label={t('admin_people.custom_tiers_more', 'More settings')}
                                    className="text-xs px-2 py-1 rounded-lg hover:bg-[var(--item-hover-bg)] text-[var(--text-muted)]"
                                >
                                    {isExpanded ? '▲' : '▼'}
                                </button>
                                <button
                                    onClick={() => remove(tier.id)}
                                    className="w-8 h-8 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error-ink)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)]"
                                    title={t('admin_org.custom_tiers_delete', 'Delete')}
                                    aria-label={t('admin_org.custom_tiers_delete', 'Delete')}
                                >✕</button>
                            </div>

                            <input
                                type="text"
                                value={tier.description || ''}
                                onChange={e => patch(tier.id, { description: e.target.value })}
                                placeholder={t('admin_org.custom_tiers_desc_ph', 'Short description (shown in tier picker)')}
                                className={`text-xs px-3 py-2 mb-3 ${FIELD}`} />

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label className="text-[10px] uppercase tracking-wider font-semibold text-[var(--text-muted)]">{t('admin_org.custom_tiers_model', 'Model')}</label>
                                    <select
                                        value={tier.modelId || ''}
                                        onChange={e => patch(tier.id, { modelId: e.target.value })}
                                        className={`px-3 py-2 mt-1 text-sm ${FIELD}`}
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
                                        className={`px-3 py-2 mt-1 text-sm ${FIELD}`}
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
                                                aria-pressed={active}
                                                className={`px-2.5 py-1 rounded-full border text-xs font-medium transition-colors ${active
                                                    ? 'bg-[var(--item-active-bg)] border-[var(--text-primary)] text-[var(--text-primary)]'
                                                    : 'bg-[var(--bg-primary)] border-[var(--border-subtle)] text-[var(--text-muted)] hover:border-[var(--border-default)]'}`}
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
                                        className={`px-3 py-2 text-sm ${FIELD}`} />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium mb-1 text-[var(--text-primary)]">{t('admin_org.custom_tiers_temperature', 'Temperature')}</label>
                                    <input
                                        type="number"
                                        value={tier.temperature ?? 0.7}
                                        onChange={e => patch(tier.id, { temperature: parseFloat(e.target.value) || 0.7 })}
                                        min={0} max={2} step={0.1}
                                        className={`px-3 py-2 text-sm ${FIELD}`} />
                                </div>
                            </div>
                        )}
                    </div>
                );
            })
        )}

        {footer}

        <OrgGlobalTiersList tiers={globalTiers} />
    </div>;
}

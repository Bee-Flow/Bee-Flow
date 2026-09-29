import React, { useEffect, useMemo, useState } from 'react';
import { Save } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import SettingsGroup from './settings/SettingsGroup';
import { SETTINGS_GROUPS, normaliseSettings, buildSettingsBody, groupIsInactive } from './settings/settingsFields';

/**
 * SettingsPage — the compliance settings form, grouped per framework.
 *
 * The form logic is the legacy page's (normalise → edit → one PUT), but the
 * fields now come from the table in `settings/settingsFields.js`, which names
 * every `compliance_settings` column of PLAN.md §1.3. The save body is built
 * from that allow-list, never from the form object minus a few keys — a column
 * added next year must be declared before it can travel.
 *
 * Framework relevance ("do we serve financial entities?") is NOT a settings
 * column: it goes to `data.frameworks.setRelevance(id, value)` the moment it is
 * answered, like everywhere else in the hub.
 *
 * Page props object per fe-1: `data.core.settings` / `data.core.saveSettings`,
 * `data.orgUsers`, `data.frameworks`.
 */

/** Groups that open by default — the rest is one click away. */
const DEFAULT_OPEN = Object.freeze(['general', 'ai_act']);

export default function SettingsPage({ data = {}, isMobile = false }) {
    const { t } = useTranslation();
    const core = data.core || {};
    const frameworks = data.frameworks || null;
    const orgUsers = data.orgUsers ?? null;
    const settings = core.settings;
    const ready = !!settings && typeof settings === 'object';

    const [form, setForm] = useState(() => normaliseSettings(settings));
    const [saving, setSaving] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [open, setOpen] = useState(() => {
        const o = {};
        for (const g of SETTINGS_GROUPS) o[g.id] = DEFAULT_OPEN.includes(g.id);
        return o;
    });

    useEffect(() => { setForm(normaliseSettings(settings)); setDirty(false); }, [settings]);

    const update = (name, value) => {
        setDirty(true);
        if (name === '__fill_dpo__') {
            const u = value || {};
            setForm(prev => ({ ...prev, dpo_name: u.displayName || prev.dpo_name, dpo_email: u.email || prev.dpo_email, dpo_phone: u.phone || prev.dpo_phone }));
            return;
        }
        setForm(prev => ({ ...prev, [name]: value }));
    };

    const relevanceOf = (id) => frameworks?.byId?.(id)?.relevance || 'unknown';
    const setRelevance = (id, value) => frameworks?.setRelevance?.(id, value);

    const save = async () => {
        if (!ready || saving) return;
        setSaving(true);
        try {
            await core.saveSettings?.(buildSettingsBody(form));
            setDirty(false);
        } catch { /* the hook owns the error toast */ }
        finally { setSaving(false); }
    };

    const publicDsrUrl = useMemo(() => {
        const base = String(form.public_base_url || '').trim().replace(/\/+$/, '')
            || (typeof window !== 'undefined' && window.location ? window.location.origin : '');
        return `${base}/privacy/requests`;
    }, [form.public_base_url]);

    const generalFooter = (
        <div className="rounded-[10px] bg-[var(--bg-tertiary)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]" data-testid="settings-dsr-hint">
            {t('compliance.public_dsr_hint', 'Data subjects can submit privacy requests without an account — link this page from your privacy notice:')}{' '}
            <code className="text-[11px] text-[var(--text-primary)] [overflow-wrap:anywhere]">{publicDsrUrl}</code>
        </div>
    );

    return (
        <div className={`h-full min-h-0 overflow-y-auto p-3.5 flex flex-col gap-3 ${isMobile ? '' : 'max-w-[860px]'}`} data-testid="settings-page">
            {!ready && (
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]" data-testid="settings-loading">
                    {t('compliance.set_loading', 'Reading your compliance settings…')}
                </div>
            )}

            {SETTINGS_GROUPS.map(group => (
                <SettingsGroup
                    key={group.id}
                    group={group}
                    form={form}
                    onChange={update}
                    orgUsers={orgUsers}
                    inactive={groupIsInactive(group, frameworks)}
                    open={!!open[group.id]}
                    onToggle={(next) => setOpen(prev => ({ ...prev, [group.id]: next }))}
                    relevanceOf={relevanceOf}
                    onRelevance={setRelevance}
                    footer={group.id === 'general' ? generalFooter : null}
                />
            ))}

            <div className="sticky bottom-0 -mx-3.5 px-3.5 py-2.5 flex items-center gap-2 bg-[var(--bg-secondary)] border-t border-[var(--border-default)]">
                <button
                    type="button"
                    onClick={save}
                    disabled={!ready || saving}
                    style={PRIMARY_ACTION_STYLE}
                    className="h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="settings-save"
                >
                    <Save size={13} aria-hidden="true" />
                    {saving ? t('compliance.saving', 'Saving…') : t('compliance.save', 'Save')}
                </button>
                {dirty && !saving && (
                    <span className="text-[11px] text-[var(--text-tertiary)]" data-testid="settings-dirty">
                        {t('compliance.set_unsaved', 'Unsaved changes')}
                    </span>
                )}
            </div>
        </div>
    );
}

export { SETTINGS_GROUPS, buildSettingsBody, normaliseSettings };

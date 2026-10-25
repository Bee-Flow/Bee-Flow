import { useState, useEffect, useRef } from 'react';
import { Sparkles, X, Users, Lock } from 'lucide-react';
import { readOrgGroups, type OrgGroup } from '../../api/queries/orgGroups';
import { API_BASE, authFetch } from '../../utils/helpers';
import useTranslation from '../../hooks/useTranslation';
import { managedOf, managedRefusalOf, type ManagedBannerInfo, type ManagedPart } from '../shared/managedPart';
import ManagedPartBanner from '../shared/ManagedPartBanner';
import Modal from '../shared/Modal';
import type { TranslateParams } from '../../hooks/useTranslation';
import type { Skill } from '../../hooks/useSkills';
import type { SkillRecord } from './SkillCard';
import type { TextTab, FormState, CharCountProps, SkillFormModalProps } from './SkillFormModal.types';
import { logger } from '../../utils/logger';
import { ICONS, INSTRUCTION_LIMIT, TABS, STRUCTURE_WARNING, STRUCTURED_TEXT_FIELDS } from './SkillFormModal.constants';
export { ICONS, INSTRUCTION_LIMIT } from './SkillFormModal.constants';

const emptyForm = (): FormState => ({
    name: '',
    description: '',
    instructions: '',
    workflow: '',
    rules: '',
    examples: '',
    icon: '⚡',
    isShared: false,
    dynamicActivation: false,
    sharedGroups: [],
});

/**
 * The body for `onSave`: everything the modal edits, minus the structured
 * text fields that are byte-identical to the ones it opened with.
 *
 * A NEW skill sends all of them — there is no stored structure to protect,
 * and an omitted field on a create would just leave the column empty.
 *
 * Module-private on purpose: the tests reach it the way a user does — fill
 * the form, press Update, read what `onSave` got — and a second non-component
 * export from this file would cost the whole module its fast refresh.
 *
 * @param {object} form     the current field values
 * @param {object|null} initial  the values the modal opened with; null = create
 */
function payloadOf(form: FormState, initial: FormState | null, locked: boolean = false) {
    // A managed skill: who sees it is the only thing that can change.
    if (locked) return { isShared: form.isShared, sharedGroups: form.sharedGroups };
    const out = { ...form };
    if (!initial) return out;
    for (const field of STRUCTURED_TEXT_FIELDS) {
        if (out[field] === initial[field]) delete out[field];
    }
    return out;
}

function CharCount({ value, limit, t }: CharCountProps) {
    const len = value?.length || 0;
    const pct = len / limit;
    const color = pct > 0.9 ? 'var(--error-ink)' : pct > 0.75 ? 'var(--warning-ink)' : 'var(--text-tertiary)';
    return (
        <span className="text-[11px] tabular-nums" style={{ color }}>
            {t('skill_form.chars_left', '{count} left', { count: limit - len })}
        </span>
    );
}

export default function SkillFormModal({ skill, onSave, onCancel, saving, groups = [], orgId = null, user = null }: SkillFormModalProps) {
    const { t } = useTranslation();
    // Captured ONCE, and kept beside the live form: it is the only thing
    // that can answer "did the person actually change this text?".
    const [initial] = useState<FormState | null>(() => (skill ? {
        name: skill.name || '',
        description: skill.description || '',
        instructions: (skill.instructions as string | undefined) || '',
        workflow: (skill.workflow as string | undefined) || '',
        rules: (skill.rules as string | undefined) || '',
        examples: (skill.examples as string | undefined) || '',
        icon: (skill.icon as string | undefined) || '⚡',
        isShared: (skill.isShared as boolean | undefined) ?? false,
        dynamicActivation: (skill.dynamicActivation as boolean | undefined) ?? false,
        sharedGroups: Array.isArray(skill.sharedGroups) ? skill.sharedGroups : [],
    } : null));
    const [form, setForm] = useState(() => initial || emptyForm());
    const [refusal, setRefusal] = useState<ManagedBannerInfo | null>(null);
    // The list rows the callers hand in do not carry `managed` (only GET
    // /api/skills/:id does), so an existing skill is asked once on open.
    const [fetchedManaged, setFetchedManaged] = useState<ManagedPart | null>(null);
    const skillId = skill?.id || null;
    useEffect(() => {
        if (!skillId || managedOf(skill)) return undefined;
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/skills/${encodeURIComponent(skillId)}`);
                if (!cancelled && res.ok) setFetchedManaged(managedOf(await res.json()));
            } catch (err) { logger.debug('non-fatal: the 409 on save still turns the form read-only', err); }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- once per skill id
    }, [skillId]);
    const managedPart = managedOf(skill) ?? fetchedManaged ?? refusal?.managed ?? null;
    const locked = !!managedPart || refusal != null;
    const save = () => Promise.resolve(onSave(payloadOf(form, initial, locked))).catch((err) => {
        const info = managedRefusalOf(err);
        if (!info) throw err;
        setRefusal(info);
    });
    // Auto-fetch groups if not supplied by parent
    const [fetchedGroups, setFetchedGroups] = useState<OrgGroup[] | null>(null);
    useEffect(() => {
        if (groups && groups.length > 0) return;
        let cancelled = false;
        readOrgGroups()
            .then((list) => { if (!cancelled && list) setFetchedGroups(list); })
            .catch(() => { /* non-fatal */ });
        return () => { cancelled = true; };
    }, [groups]);
    const effectiveGroups = (groups && groups.length > 0) ? groups : (fetchedGroups || []);
    const effectiveOrgId = orgId || user?.organizationId || null;
    const orgGroups = effectiveGroups.filter(g => !effectiveOrgId || g.organizationId === effectiveOrgId);
    const toggleGroup = (gid: string) => setForm(f => {
        const cur = f.sharedGroups || [];
        return { ...f, sharedGroups: cur.includes(gid) ? cur.filter(x => x !== gid) : [...cur, gid] };
    });
    const [showIconPicker, setShowIconPicker] = useState(false);
    const [activeTab, setActiveTab] = useState<TextTab>('instructions');

    const setField = (k: string, v: string | boolean) => setForm(f => ({ ...f, [k]: v }));

    // The name field comes after the icon-picker button in DOM order, so
    // Modal's own "focus the first control" would land on that button
    // instead. Modal's initialFocus names the field.
    const nameRef = useRef<HTMLInputElement>(null);

    const currentTab = TABS.find(tab => tab.id === activeTab) as (typeof TABS)[number];
    const canSave = form.name.trim() && !saving;

    // How many structured rows the text on THIS tab would replace, if any.
    const structured = currentTab.structureField ? skill?.[currentTab.structureField] : null;
    const structuredCount = Array.isArray(structured) ? structured.length : 0;
    const warnPair = structuredCount > 0 ? STRUCTURE_WARNING[currentTab.structureField as string] : null;
    const warning = warnPair && (structuredCount === 1 ? warnPair.one : warnPair.many);

    const sharedTitle = form.isShared
        ? ((form.sharedGroups || []).length > 0
            ? t('skill_form.shared_groups_title', 'Shared with {count} groups', { count: form.sharedGroups.length })
            : t('skill_form.shared_org_title', 'Shared with all members of your organisation'))
        : t('skill_form.private_title', 'Only visible to you');

    return (
        <Modal
            open
            onClose={onCancel}
            variant="bare"
            size="auto"
            zIndex={1000}
            initialFocus={nameRef}
            label={skill
                ? t('skill_form.edit_title', 'Edit skill')
                : t('skill_form.new_title', 'New skill')}
            className="max-w-2xl"
        >
            <div
                className="w-full max-h-[90vh] flex flex-col overflow-hidden rounded-2xl border shadow-2xl animate-in fade-in zoom-in-95 duration-150 bg-[var(--bg-secondary)] border-[var(--border-subtle)]"
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b flex-shrink-0 border-[var(--border-subtle)]">
                    <div className="relative flex-shrink-0">
                        <button
                            onClick={() => setShowIconPicker(v => !v)}
                            disabled={locked}
                            title={t('skill_form.choose_icon', 'Choose icon')}
                            aria-label={t('skill_form.choose_icon', 'Choose icon')}
                            className="w-11 h-11 rounded-xl border-[1.5px] flex items-center justify-center text-[22px] transition-colors bg-[var(--bg-tertiary)] border-[var(--border-default)]"
                        >
                            {form.icon}
                        </button>
                        {showIconPicker && (
                            <div
                                className="absolute top-[52px] left-0 z-10 p-2 rounded-xl border shadow-xl grid grid-cols-5 gap-1 w-[180px] bg-[var(--bg-primary)] border-[var(--border-subtle)]"
                            >
                                {ICONS.map(ic => (
                                    <button
                                        key={ic}
                                        onClick={() => { setField('icon', ic); setShowIconPicker(false); }}
                                        className={`w-8 h-8 rounded-lg flex items-center justify-center text-[18px] transition-colors ${form.icon === ic ? 'bg-[var(--accent-primary)]/15' : 'hover:bg-[var(--bg-tertiary)]'}`}
                                    >
                                        {ic}
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="flex-1 min-w-0">
                        <input
                            value={form.name}
                            onChange={e => setField('name', e.target.value)}
                            readOnly={locked}
                            placeholder={t('skill_form.name_placeholder', 'Skill name (e.g. meeting-summary)')}
                            aria-label={t('skill_form.name', 'Skill name')}
                            ref={nameRef}
                            className="w-full text-base font-bold bg-transparent outline-none border-none [color:var(--text-primary)]!"
                        />
                        <input
                            value={form.description}
                            onChange={e => setField('description', e.target.value)}
                            readOnly={locked}
                            placeholder={t('skill_form.description_placeholder', 'Short description…')}
                            aria-label={t('skill_form.description', 'Description')}
                            className="w-full text-[13px] bg-transparent outline-none border-none mt-0.5 [color:var(--text-secondary)]!"
                        />
                    </div>

                    <button
                        onClick={onCancel}
                        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors hover:bg-[var(--bg-tertiary)] [color:var(--text-secondary)] [background:var(--bg-tertiary)]!"
                        title={t('skill_form.close', 'Close')}
                        aria-label={t('skill_form.close', 'Close')}
                    >
                        <X size={16} />
                    </button>
                </div>

                {locked && <ManagedPartBanner managed={managedPart} notDeployed={refusal?.reason === 'not_deployed'} />}

                {/* Tab bar */}
                <div className="flex border-b px-6 flex-shrink-0 border-[var(--border-subtle)]">
                    {TABS.map(tab => (
                        <button
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            aria-pressed={activeTab === tab.id}
                            className={`px-3.5 py-2.5 text-[13px] transition-all -mb-px border-b-2 ${activeTab === tab.id
                                ? 'font-semibold border-[var(--accent-primary)] text-[var(--accent-primary)]'
                                : 'font-normal border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                                }`}
                        >
                            {t(tab.labelKey, tab.labelEn)}
                        </button>
                    ))}
                </div>

                {/* Tab body */}
                <div className="flex-1 overflow-auto px-6 py-4">
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] text-[var(--text-tertiary)]">
                            {t(currentTab.hintKey, currentTab.hintEn)}
                        </span>
                        {activeTab === 'instructions' && <CharCount value={form.instructions} limit={INSTRUCTION_LIMIT} t={t} />}
                    </div>
                    {warning && !locked && (
                        <p
                            className="text-[11px] mb-1.5 m-0 text-[var(--warning-ink)]"
                            data-testid="skill-form-structure-warning"
                        >
                            {t(warning.key, warning.en, { count: structuredCount })}
                        </p>
                    )}
                    <textarea
                        value={form[activeTab]}
                        readOnly={locked}
                        onChange={e => {
                            if (activeTab === 'instructions' && e.target.value.length > INSTRUCTION_LIMIT) return;
                            setField(activeTab, e.target.value);
                        }}
                        placeholder={t(currentTab.phKey, currentTab.phEn)}
                        aria-label={t(currentTab.labelKey, currentTab.labelEn)}
                        className="w-full min-h-[200px] text-[13px] leading-relaxed rounded-xl border-[1.5px] p-3.5 resize-y outline-none transition-colors focus:border-[var(--accent-primary)] [color:var(--text-primary)]! [background:var(--bg-tertiary)] [border-color:var(--border-subtle)]! [font-family:inherit]"
                    />
                </div>

                {/* Sharing scope (groups) — only when shared and groups exist for the org */}
                {form.isShared && orgGroups.length > 0 && (
                    <div className="px-6 pb-3 pt-1 border-t flex-shrink-0 border-[var(--border-subtle)]">
                        <label className="text-[11px] mb-1.5 block text-[var(--text-tertiary)]">
                            {t('skill_form.groups_label', 'Share with specific groups (leave empty for all org members)')}
                        </label>
                        <div className="space-y-1 max-h-32 overflow-auto">
                            {orgGroups.map(group => (
                                <label key={group.id} className="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-[var(--bg-tertiary)] cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={(form.sharedGroups || []).includes(group.id)}
                                        onChange={() => toggleGroup(group.id)}
                                        className="rounded"
                                    />
                                    <span className="text-[13px] text-[var(--text-primary)]">{group.name}</span>
                                    {(group.description as string | undefined) && <span className="text-[11px] text-[var(--text-tertiary)]">— {group.description as string}</span>}
                                </label>
                            ))}
                        </div>
                    </div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 border-t flex-shrink-0 border-[var(--border-subtle)]">
                    <button
                        onClick={() => setField('isShared', !form.isShared)}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border-[1.5px] text-[13px] font-medium transition-all ${form.isShared
                            ? 'border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]'
                            : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                            }`}
                        title={sharedTitle}
                    >
                        {form.isShared ? <Users size={14} /> : <Lock size={14} />}
                        {form.isShared
                            ? ((form.sharedGroups || []).length > 0
                                ? t('skill_form.shared_groups', 'Shared ({count} groups)', { count: form.sharedGroups.length })
                                : t('skill_form.shared_org', 'Shared with org'))
                            : t('skill_form.private', 'Private')}
                    </button>

                    <div className="flex gap-2">
                        <button
                            onClick={onCancel}
                            className="px-4 py-2 rounded-lg border text-[13px] font-medium transition-colors hover:bg-[var(--bg-tertiary)] [border-color:var(--border-subtle)] [color:var(--text-secondary)]! [background:transparent]!"
                        >
                            {t('skill_form.cancel', 'Cancel')}
                        </button>
                        <button
                            onClick={save}
                            disabled={!canSave}
                            className={`flex items-center gap-1.5 px-5 py-2 rounded-lg text-[13px] font-semibold transition-opacity ${canSave ? 'hover:opacity-90' : 'opacity-50 cursor-not-allowed'} [background:var(--accent-primary)] [color:var(--accent-primary-fg)]!`}
                        >
                            {saving
                                ? t('skill_form.saving', 'Saving…')
                                : (
                                    <>
                                        <Sparkles size={14} />
                                        {skill ? t('skill_form.update', 'Update skill') : t('skill_form.create', 'Create skill')}
                                    </>
                                )}
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}

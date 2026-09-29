import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, X, Users, Lock } from 'lucide-react';
import { API_BASE, authFetch } from '../../utils/helpers';
import { SKILL_EMOJI_ICONS } from '../../constants/icons';
import useTranslation from '../../hooks/useTranslation';
import Modal from '../shared/Modal';

/**
 * The LIGHT skill maker — the one that opens from a chat surface and from
 * the agent's Skills tab, next to the full editor in Studio.
 *
 * It stays deliberately light: a name, a description and the four text
 * fields. Studio owns the structured shape (steps as cards, rules with a
 * polarity, examples as question/answer pairs, the fields a skill delivers);
 * this modal exists so somebody who is in the middle of a conversation can
 * write a skill down without leaving it.
 *
 * ── TEXT IS THE SOURCE HERE, AND THAT IS A REAL CONSEQUENCE ─────────
 * S1's write precedence (server/core/skills/skillStructure.resolveBodyWrite)
 * says: a body that carries `workflow`/`rules`/`examples` and NO structure
 * stores the text and re-parses the structure FROM it. So editing the
 * workflow text of a skill that has steps in Studio replaces those steps —
 * ids, references and all.
 *
 * That is the right precedence (the person is looking at the text they are
 * editing), but it must not be a surprise, so a skill that HAS structure
 * says so above the field. Hiding the field instead would leave a skill
 * nobody can fix from here; saying nothing is how a step's references
 * disappear without anyone noticing.
 *
 * ── AND THE COMPARISON IS THIS FILE'S JOB, NOT THE SERVER'S ─────────
 * `resolveBodyWrite` compares nothing with what is stored: any `workflow`
 * that ARRIVES is re-parsed, and `parseWorkflowToSteps` mints a fresh id
 * per line with `refs: []`. So "unchanged text leaves the structure alone"
 * is only true if the unchanged text is never sent — which is what
 * `payloadOf` below does. Renaming a skill from this modal used to
 * re-mint every step id and drop every reference pill of a skill somebody
 * had built in Studio, and nothing on screen said so.
 *
 * Everything this modal does not send is left alone by the server
 * (`undefined` = "leave as-is"), so a skill's steps, output fields, grants
 * and dynamic activation survive a save from here untouched.
 */

// Re-export for callers that already import ICONS from this module.
export const ICONS = SKILL_EMOJI_ICONS;
export const INSTRUCTION_LIMIT = 4000;

const emptyForm = () => ({
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
 * The four text tabs. Labels, hints and placeholders go through t() at
 * render time — the list itself is static data, so the keys stay literal
 * (i18nGuard's rule) and a translator sees them all in one place.
 */
const TABS = [
    {
        id: 'instructions',
        labelKey: 'skill_form.tab.instructions', labelEn: 'Instructions',
        hintKey: 'skill_form.hint.instructions', hintEn: 'What should the AI do? Be specific and detailed.',
        phKey: 'skill_form.ph.instructions',
        phEn: 'e.g. When asked to summarize a meeting, extract all key decisions, action items with owners, and open questions...',
    },
    {
        id: 'workflow',
        labelKey: 'skill_form.tab.workflow', labelEn: 'Workflow',
        hintKey: 'skill_form.hint.workflow', hintEn: 'Step-by-step process to follow.',
        phKey: 'skill_form.ph.workflow',
        phEn: 'e.g.\n1. Read the transcript\n2. Extract action items\n3. List decisions made\n4. Output in structured format...',
        structureField: 'steps',
    },
    {
        id: 'rules',
        labelKey: 'skill_form.tab.rules', labelEn: 'Rules',
        hintKey: 'skill_form.hint.rules', hintEn: "Tone, format rules, dos and don'ts.",
        phKey: 'skill_form.ph.rules',
        phEn: 'e.g.\n- Always use bullet points\n- Keep summaries under 300 words\n- Highlight action items in bold...',
        structureField: 'rulesV2',
    },
    {
        id: 'examples',
        labelKey: 'skill_form.tab.examples', labelEn: 'Examples',
        hintKey: 'skill_form.hint.examples', hintEn: 'Example outputs or input/output pairs.',
        phKey: 'skill_form.ph.examples',
        phEn: 'e.g. Input: "Meeting transcript..."\nOutput: "## Summary\n..."',
        structureField: 'examplesV2',
    },
];

/**
 * The one warning about rewriting text over a structure Studio owns.
 *
 * One step is an ordinary skill, so the count really can be 1 — and the
 * house convention (I18N-CONVENTIES §2) puts the ternary around the KEY,
 * never around a letter in the sentence: base key = singular,
 * `<key>_plural` = many, so a translator sees the pair side by side.
 */
const STRUCTURE_WARNING = {
    steps: {
        one: { key: 'skill_form.replaces_steps', en: 'This skill has {count} step in Studio. Rewriting the text here replaces it, references and all.' },
        many: { key: 'skill_form.replaces_steps_plural', en: 'This skill has {count} steps in Studio. Rewriting the text here replaces them, references and all.' },
    },
    rulesV2: {
        one: { key: 'skill_form.replaces_rules', en: 'This skill has {count} rule in Studio. Rewriting the text here replaces it.' },
        many: { key: 'skill_form.replaces_rules_plural', en: 'This skill has {count} rules in Studio. Rewriting the text here replaces them.' },
    },
    examplesV2: {
        one: { key: 'skill_form.replaces_examples', en: 'This skill has {count} example in Studio. Rewriting the text here replaces it.' },
        many: { key: 'skill_form.replaces_examples_plural', en: 'This skill has {count} examples in Studio. Rewriting the text here replaces them.' },
    },
};

/**
 * The three text fields that OVERWRITE a structure Studio owns. Any other
 * field this modal edits (name, description, instructions, icon, sharing)
 * has no structured counterpart, so sending it unchanged costs nothing.
 */
const STRUCTURED_TEXT_FIELDS = Object.freeze(['workflow', 'rules', 'examples']);

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
function payloadOf(form, initial) {
    const out = { ...form };
    if (!initial) return out;
    for (const field of STRUCTURED_TEXT_FIELDS) {
        if (out[field] === initial[field]) delete out[field];
    }
    return out;
}

function CharCount({ value, limit, t }) {
    const len = value?.length || 0;
    const pct = len / limit;
    const color = pct > 0.9 ? 'var(--error-ink)' : pct > 0.75 ? 'var(--warning-ink)' : 'var(--text-tertiary)';
    return (
        <span className="text-[11px] tabular-nums" style={{ color }}>
            {t('skill_form.chars_left', '{count} left', { count: limit - len })}
        </span>
    );
}

export default function SkillFormModal({ skill, onSave, onCancel, saving, groups = [], orgId = null, user = null }) {
    const { t } = useTranslation();
    // Captured ONCE, and kept beside the live form: it is the only thing
    // that can answer "did the person actually change this text?".
    const [initial] = useState(() => (skill ? {
        name: skill.name || '',
        description: skill.description || '',
        instructions: skill.instructions || '',
        workflow: skill.workflow || '',
        rules: skill.rules || '',
        examples: skill.examples || '',
        icon: skill.icon || '⚡',
        isShared: skill.isShared ?? false,
        dynamicActivation: skill.dynamicActivation ?? false,
        sharedGroups: Array.isArray(skill.sharedGroups) ? skill.sharedGroups : [],
    } : null));
    const [form, setForm] = useState(() => initial || emptyForm());
    // Auto-fetch groups if not supplied by parent
    const [fetchedGroups, setFetchedGroups] = useState(null);
    useEffect(() => {
        if (groups && groups.length > 0) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/auth/groups`);
                if (!cancelled && res.ok) setFetchedGroups(await res.json());
            } catch (_) { /* non-fatal */ }
        })();
        return () => { cancelled = true; };
    }, [groups]);
    const effectiveGroups = (groups && groups.length > 0) ? groups : (fetchedGroups || []);
    const effectiveOrgId = orgId || user?.organizationId || null;
    const orgGroups = effectiveGroups.filter(g => !effectiveOrgId || g.organizationId === effectiveOrgId);
    const toggleGroup = (gid) => setForm(f => {
        const cur = f.sharedGroups || [];
        return { ...f, sharedGroups: cur.includes(gid) ? cur.filter(x => x !== gid) : [...cur, gid] };
    });
    const [showIconPicker, setShowIconPicker] = useState(false);
    const [activeTab, setActiveTab] = useState('instructions');

    const setField = (k, v) => setForm(f => ({ ...f, [k]: v }));

    // The name field comes after the icon-picker button in DOM order, so
    // Modal's own "focus the first control" would land on that button
    // instead. Modal's initialFocus names the field.
    const nameRef = useRef(null);

    const currentTab = TABS.find(tab => tab.id === activeTab);
    const canSave = form.name.trim() && !saving;

    // How many structured rows the text on THIS tab would replace, if any.
    const structured = currentTab.structureField ? skill?.[currentTab.structureField] : null;
    const structuredCount = Array.isArray(structured) ? structured.length : 0;
    const warnPair = structuredCount > 0 ? STRUCTURE_WARNING[currentTab.structureField] : null;
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
                className="w-full max-h-[90vh] flex flex-col overflow-hidden rounded-2xl border shadow-2xl animate-in fade-in zoom-in-95 duration-150"
                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)' }}
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b flex-shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="relative flex-shrink-0">
                        <button
                            onClick={() => setShowIconPicker(v => !v)}
                            title={t('skill_form.choose_icon', 'Choose icon')}
                            aria-label={t('skill_form.choose_icon', 'Choose icon')}
                            className="w-11 h-11 rounded-xl border-[1.5px] flex items-center justify-center text-[22px] transition-colors"
                            style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)' }}
                        >
                            {form.icon}
                        </button>
                        {showIconPicker && (
                            <div
                                className="absolute top-[52px] left-0 z-10 p-2 rounded-xl border shadow-xl grid grid-cols-5 gap-1 w-[180px]"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-subtle)' }}
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
                            placeholder={t('skill_form.name_placeholder', 'Skill name (e.g. meeting-summary)')}
                            aria-label={t('skill_form.name', 'Skill name')}
                            ref={nameRef}
                            className="w-full text-base font-bold bg-transparent outline-none border-none"
                            style={{ color: 'var(--text-primary)' }}
                        />
                        <input
                            value={form.description}
                            onChange={e => setField('description', e.target.value)}
                            placeholder={t('skill_form.description_placeholder', 'Short description…')}
                            aria-label={t('skill_form.description', 'Description')}
                            className="w-full text-[13px] bg-transparent outline-none border-none mt-0.5"
                            style={{ color: 'var(--text-secondary)' }}
                        />
                    </div>

                    <button
                        onClick={onCancel}
                        className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors hover:bg-[var(--bg-tertiary)]"
                        style={{ color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}
                        title={t('skill_form.close', 'Close')}
                        aria-label={t('skill_form.close', 'Close')}
                    >
                        <X size={16} />
                    </button>
                </div>

                {/* Tab bar */}
                <div className="flex border-b px-6 flex-shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
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
                        <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                            {t(currentTab.hintKey, currentTab.hintEn)}
                        </span>
                        {activeTab === 'instructions' && <CharCount value={form.instructions} limit={INSTRUCTION_LIMIT} t={t} />}
                    </div>
                    {warning && (
                        <p
                            className="text-[11px] mb-1.5 m-0"
                            style={{ color: 'var(--warning-ink)' }}
                            data-testid="skill-form-structure-warning"
                        >
                            {t(warning.key, warning.en, { count: structuredCount })}
                        </p>
                    )}
                    <textarea
                        value={form[activeTab]}
                        onChange={e => {
                            if (activeTab === 'instructions' && e.target.value.length > INSTRUCTION_LIMIT) return;
                            setField(activeTab, e.target.value);
                        }}
                        placeholder={t(currentTab.phKey, currentTab.phEn)}
                        aria-label={t(currentTab.labelKey, currentTab.labelEn)}
                        className="w-full min-h-[200px] text-[13px] leading-relaxed rounded-xl border-[1.5px] p-3.5 resize-y outline-none transition-colors focus:border-[var(--accent-primary)]"
                        style={{
                            color: 'var(--text-primary)',
                            background: 'var(--bg-tertiary)',
                            borderColor: 'var(--border-subtle)',
                            fontFamily: 'inherit',
                        }}
                    />
                </div>

                {/* Sharing scope (groups) — only when shared and groups exist for the org */}
                {form.isShared && orgGroups.length > 0 && (
                    <div className="px-6 pb-3 pt-1 border-t flex-shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
                        <label className="text-[11px] mb-1.5 block" style={{ color: 'var(--text-tertiary)' }}>
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
                                    <span className="text-[13px]" style={{ color: 'var(--text-primary)' }}>{group.name}</span>
                                    {group.description && <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>— {group.description}</span>}
                                </label>
                            ))}
                        </div>
                    </div>
                )}

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 border-t flex-shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
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
                            className="px-4 py-2 rounded-lg border text-[13px] font-medium transition-colors hover:bg-[var(--bg-tertiary)]"
                            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', background: 'transparent' }}
                        >
                            {t('skill_form.cancel', 'Cancel')}
                        </button>
                        <button
                            onClick={() => onSave(payloadOf(form, initial))}
                            disabled={!canSave}
                            className={`flex items-center gap-1.5 px-5 py-2 rounded-lg text-[13px] font-semibold transition-opacity ${canSave ? 'hover:opacity-90' : 'opacity-50 cursor-not-allowed'}`}
                            style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
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

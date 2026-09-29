import React, { useMemo, useState } from 'react';
import { Sparkles, Plus, Search, Users, Lock, Edit2, Check, Zap } from 'lucide-react';
import { useSkills } from '../../hooks/useSkills';
import useTranslation from '../../hooks/useTranslation';
import { kindColorVar } from '../shared/kindColors';
import { toast } from '../shared/Toast';
import SkillFormModal from '../skills/SkillFormModal';

/**
 * The agent's "Attached skills" tab.
 *
 * Two things changed with the Skills redesign (Sep 2026, plan S2), and
 * neither is cosmetic:
 *
 *   1. IT SPEAKS THE PRODUCT'S LANGUAGE. Every string went through t():
 *      this tab had zero of them, so a Dutch account read a Dutch agent
 *      builder with an English panel in the middle of it.
 *
 *   2. IT SAYS WHAT A SKILL COSTS. A skill attached here is applied to
 *      EVERY turn of every conversation with this agent — unless it is a
 *      dynamic one, which the agent picks up only when it decides to. Those
 *      are two very different prompts, and the row now says which it is
 *      rather than leaving both looking like a checkbox.
 *
 * Colours come from the shared kind legend (`--kind-skill`), so a skill is
 * the same colour here, on the Studio rail and in a reference pill.
 */
export default function AgentSkillsTab({ user, attachedSkillIds = [], onChangeAttached }) {
    const { t } = useTranslation();
    const { skills, loading, error, create, update, refresh } = useSkills();
    const [search, setSearch] = useState('');
    const [showForm, setShowForm] = useState(false);
    const [editingSkill, setEditingSkill] = useState(null);
    const [saving, setSaving] = useState(false);

    const attachedSet = useMemo(() => new Set(attachedSkillIds), [attachedSkillIds]);

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return skills;
        return skills.filter(s => s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q));
    }, [skills, search]);

    const toggle = (id) => {
        const next = attachedSet.has(id)
            ? attachedSkillIds.filter(x => x !== id)
            : [...attachedSkillIds, id];
        onChangeAttached(next);
    };

    const handleSave = async (form) => {
        setSaving(true);
        try {
            if (editingSkill) {
                await update(editingSkill.id, form);
            } else {
                const created = await create(form);
                if (created?.id) onChangeAttached([...attachedSkillIds, created.id]);
            }
            setShowForm(false);
            setEditingSkill(null);
        } catch (err) {
            toast.error(err.message || t('agent_skills.err_save', 'Could not save the skill.'));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="max-w-2xl space-y-4" data-testid="agent-skills-tab">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <div className="flex items-center gap-2">
                        <Sparkles size={16} style={{ color: kindColorVar('skill') }} aria-hidden="true" />
                        <h3 className="text-sm font-semibold m-0" style={{ color: 'var(--text-primary)' }}>
                            {t('agent_skills.title', 'Attached skills')}
                        </h3>
                    </div>
                    <p className="text-xs m-0 mt-1" style={{ color: 'var(--text-secondary)' }}>
                        {t('agent_skills.help', 'A skill attached here applies to every conversation with this agent.')}
                    </p>
                </div>
                <button
                    onClick={() => { setEditingSkill(null); setShowForm(true); }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold shadow-sm transition-opacity hover:opacity-90"
                    style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                >
                    <Plus size={13} aria-hidden="true" /> {t('agent_skills.new', 'New skill')}
                </button>
            </div>

            <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
                <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={t('agent_skills.search', 'Search skills…')}
                    aria-label={t('agent_skills.search', 'Search skills…')}
                    className="w-full pl-9 pr-3 py-2 text-[13px] rounded-lg border outline-none transition-colors focus:border-[var(--accent-primary)]"
                    style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                />
            </div>

            {loading && (
                <div className="flex items-center justify-center py-10">
                    <div className="w-5 h-5 rounded-full border-[2.5px] border-[var(--border-subtle)] border-t-[var(--accent-primary)] animate-spin" />
                    <span className="sr-only">{t('agent_skills.loading', 'Loading skills…')}</span>
                </div>
            )}

            {error && (
                <div className="py-3 text-center text-sm" style={{ color: 'var(--error)' }} role="status">
                    {error} —{' '}
                    <button onClick={refresh} className="underline text-[var(--accent-primary)]">
                        {t('agent_skills.retry', 'retry')}
                    </button>
                </div>
            )}

            {!loading && !error && filtered.length === 0 && (
                <div className="py-8 text-center rounded-xl border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}>
                    <Zap size={26} className="mx-auto mb-2" style={{ color: kindColorVar('skill') }} aria-hidden="true" />
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {search
                            ? t('agent_skills.no_match', 'No skills match your search')
                            : t('agent_skills.none', 'No skills yet')}
                    </div>
                    <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)' }}>
                        {search
                            ? t('agent_skills.no_match_help', 'Try a different search term.')
                            : t('agent_skills.none_help', 'Create one to get started.')}
                    </p>
                </div>
            )}

            {!loading && !error && filtered.length > 0 && (
                <div
                    className="rounded-xl border divide-y overflow-hidden"
                    style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-secondary)' }}
                >
                    {filtered.map(skill => (
                        <SkillRow
                            key={skill.id}
                            skill={skill}
                            attached={attachedSet.has(skill.id)}
                            canEdit={skill.canEdit ?? (skill.userId === user?.id || !!user?.isAdmin)}
                            onToggle={() => toggle(skill.id)}
                            onEdit={() => { setEditingSkill(skill); setShowForm(true); }}
                            t={t}
                        />
                    ))}
                </div>
            )}

            {attachedSkillIds.length > 0 && (
                <div className="flex items-center gap-2 text-[12px] pt-1" style={{ color: 'var(--text-secondary)' }}>
                    <Check size={13} style={{ color: 'var(--success)' }} aria-hidden="true" />
                    {t('agent_skills.attached_count', '{count} skills attached', { count: attachedSkillIds.length })}
                </div>
            )}

            {showForm && (
                <SkillFormModal
                    skill={editingSkill}
                    onSave={handleSave}
                    onCancel={() => { setShowForm(false); setEditingSkill(null); }}
                    saving={saving}
                    user={user}
                />
            )}
        </div>
    );
}

function SkillRow({ skill, attached, canEdit, onToggle, onEdit, t }) {
    return (
        <div
            className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-[var(--bg-tertiary)] cursor-pointer"
            onClick={onToggle}
            data-testid="agent-skill-row"
            data-skill-id={skill.id}
        >
            <div
                className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 text-[16px]"
                style={{ background: 'var(--bg-tertiary)' }}
            >
                {skill.icon || '⚡'}
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                        {skill.name}
                    </span>
                    {skill.isShared
                        ? <Users size={10} style={{ color: 'var(--text-tertiary)' }} aria-label={t('skill_form.shared_org', 'Shared with org')} />
                        : <Lock size={10} style={{ color: 'var(--text-tertiary)' }} aria-label={t('skill_form.private', 'Private')} />}
                </div>
                <div className="text-[11px] truncate" style={{ color: 'var(--text-tertiary)' }}>
                    {/* What attaching this actually costs: a static skill is in
                        every prompt; a dynamic one only when the agent asks. */}
                    {skill.dynamicActivation
                        ? t('agent_skills.dynamic', 'only when the agent needs it')
                        : (skill.description || t('agent_skills.always', 'applied to every message'))}
                </div>
            </div>
            {canEdit && (
                <button
                    onClick={(e) => { e.stopPropagation(); onEdit(); }}
                    className="w-7 h-7 rounded-md flex items-center justify-center transition-colors hover:bg-[var(--bg-primary)]"
                    style={{ color: 'var(--text-tertiary)' }}
                    title={t('agent_skills.edit', 'Edit skill')}
                    aria-label={t('agent_skills.edit', 'Edit skill')}
                >
                    <Edit2 size={13} aria-hidden="true" />
                </button>
            )}
            <label
                className="relative inline-flex items-center cursor-pointer flex-shrink-0"
                onClick={e => e.stopPropagation()}
            >
                <input
                    type="checkbox"
                    checked={attached}
                    onChange={onToggle}
                    aria-label={t('agent_skills.attach', 'Attach {name}', { name: skill.name })}
                    className="sr-only peer"
                />
                <div className="w-9 h-5 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-default)] peer after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-[var(--text-tertiary)] after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:after:translate-x-4 peer-checked:after:bg-[var(--accent-primary-fg)] peer-checked:bg-[var(--accent-primary)] peer-checked:border-[var(--accent-primary)]" />
            </label>
        </div>
    );
}

import React, { useMemo, useState } from 'react';
import { Sparkles, Plus, X, Search, Zap } from 'lucide-react';
import SkillCard from './SkillCard';
import type { SkillRecord } from './SkillCard';
import useTranslation from '../../hooks/useTranslation';
import { nOf } from '../admin/Studio/KnowledgeStudio/plural';

// The filter labels travel as DATA, so each row carries its key next to the
// English instead of a bare string: the i18n guard only sees literal t() call
// sites, and a table like this one is exactly how an English label ships
// unnoticed. `en` is the fallback argument, never the rendered default.
const FILTERS = [
    { id: 'all', key: 'skills.filter_all', en: 'All' },
    { id: 'mine', key: 'skills.filter_mine', en: 'Mine' },
    { id: 'shared', key: 'skills.filter_shared', en: 'Shared' },
    { id: 'attached', key: 'skills.filter_attached', en: 'Attached' },
];

interface SkillsGridProps {
    user?: { id?: string; isAdmin?: boolean } | null;
    skills: SkillRecord[];
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    onCreate?: () => void;
    onEdit?: (skill: SkillRecord) => void;
    onDelete?: (id: string) => void;
    onClose?: () => void;
    activeSkillIds?: string[];
    onToggleSkill?: (id: string) => void;
    attachedCountBySkillId?: Record<string, number>;
    showHeader?: boolean;
}

export default function SkillsGrid({
    user,
    skills,
    loading,
    error,
    onRetry,
    onCreate,
    onEdit,
    onDelete,
    onClose,
    activeSkillIds = [],
    onToggleSkill,
    attachedCountBySkillId = {},
    showHeader = true,
}: SkillsGridProps) {
    const { t } = useTranslation();
    const [search, setSearch] = useState<string>('');
    const [filter, setFilter] = useState<string>('all');

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return skills.filter((s: SkillRecord) => {
            if (q && !(s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q))) return false;
            if (filter === 'mine' && s.userId !== user?.id) return false;
            if (filter === 'shared' && !s.isShared) return false;
            if (filter === 'attached' && !(attachedCountBySkillId[s.id] > 0)) return false;
            return true;
        });
    }, [skills, search, filter, user?.id, attachedCountBySkillId]);

    return (
        <div className="h-full flex flex-col overflow-hidden bg-[var(--bg-primary)]">
            {showHeader && (
                <div className="flex-shrink-0 px-7 pt-5 border-b border-[var(--border-subtle)]">
                    <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-3">
                            <div
                                className="w-10 h-10 rounded-xl flex items-center justify-center border-[1.5px] [background:linear-gradient(135deg,rgba(245,158,11,.3)_0%,rgba(251,191,36,.15)_100%)] [border-color:rgba(245,158,11,.25)]!"
                            >
                                <Sparkles size={20} color="#f59e0b" />
                            </div>
                            <div>
                                <div className="flex items-center gap-2">
                                    <h2 className="m-0 text-lg font-bold text-[var(--text-primary)]">{t('skills.title', 'Skills')}</h2>
                                </div>
                                <p className="m-0 mt-0.5 text-[13px] text-[var(--text-secondary)]">
                                    {t('skills.subtitle', 'Reusable instruction packs for consistent AI task execution')}
                                </p>
                            </div>
                        </div>
                        <div className="flex gap-2 items-center">
                            <button
                                onClick={onCreate}
                                data-tour="skill-create"
                                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-[13px] font-semibold text-white shadow-md transition-opacity hover:opacity-90 bg-[var(--accent-primary)]"
                            >
                                <Plus size={15} /> {t('agent_skills.new', 'New skill')}
                            </button>
                            {onClose && (
                                <button
                                    onClick={onClose}
                                    className="w-9 h-9 rounded-xl border flex items-center justify-center transition-colors hover:bg-[var(--bg-tertiary)] [border-color:var(--border-subtle)] [color:var(--text-secondary)] [background:transparent]!"
                                >
                                    <X size={16} />
                                </button>
                            )}
                        </div>
                    </div>

                    {activeSkillIds.length > 0 && (
                        <div className="flex items-center gap-2 px-3.5 py-2 rounded-xl mb-3 border [background:rgba(245,158,11,.1)] [border-color:rgba(245,158,11,.25)]">
                            <Zap size={13} color="#f59e0b" />
                            <span className="text-[12px] font-medium text-amber-600">
                                {/* One or many is a choice of KEY, not a letter glued on in
                                    JavaScript: a translator gets both whole sentences. */}
                                {nOf(t, 'skills.active_in_chat', activeSkillIds.length,
                                    '{count} skill active in chat', '{count} skills active in chat')}
                            </span>
                        </div>
                    )}

                    <div className="flex items-center gap-3 mb-4">
                        <div className="relative flex-1">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)]" />
                            <input
                                value={search}
                                onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
                                placeholder={t('agent_skills.search', 'Search skills…')}
                                className="w-full pl-9 pr-3 py-2 text-[13px] rounded-xl border-[1.5px] outline-none transition-colors focus:border-[var(--accent-primary)] [background:var(--bg-secondary)] [border-color:var(--border-subtle)]! [color:var(--text-primary)]!"
                            />
                        </div>
                        <div className="flex gap-1 p-1 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                            {FILTERS.map((f: { id: string; key: string; en: string }) => (
                                <button
                                    key={f.id}
                                    onClick={() => setFilter(f.id)}
                                    className={`text-[12px] font-medium px-3 py-1 rounded-lg transition-colors ${filter === f.id
                                        ? 'bg-[var(--accent-primary)] text-white'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                                        }`}
                                >
                                    {t(f.key, f.en)}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            <div className="flex-1 overflow-auto px-7 py-5">
                {loading && (
                    <div className="flex items-center justify-center h-32">
                        <div className="w-6 h-6 rounded-full border-[2.5px] border-[var(--border-subtle)] border-t-[var(--accent-primary)] animate-spin" />
                    </div>
                )}

                {!loading && error && (
                    <div className="py-5 text-center text-red-500 text-sm">
                        {error} — <button onClick={onRetry} className="underline text-[var(--accent-primary)]">{t('agent_skills.retry', 'retry')}</button>
                    </div>
                )}

                {!loading && !error && filtered.length === 0 && (
                    <div className="text-center py-12">
                        <div className="text-5xl mb-3">⚡</div>
                        <h3 className="m-0 mb-2 font-bold text-base text-[var(--text-primary)]">
                            {search
                                ? t('agent_skills.no_match', 'No skills match your search')
                                : t('agent_skills.none', 'No skills yet')}
                        </h3>
                        <p className="m-0 mb-5 text-[13px] leading-relaxed text-[var(--text-secondary)]">
                            {search
                                ? t('agent_skills.no_match_help', 'Try a different search term.')
                                : t('skills.none_help', 'Create your first skill to teach the AI how to handle specific tasks consistently.')}
                        </p>
                        {!search && (
                            <button
                                onClick={onCreate}
                                className="inline-flex items-center gap-1.5 px-5 py-2 rounded-xl text-[13px] font-semibold text-white bg-[var(--accent-primary)]"
                            >
                                <Plus size={14} /> {t('skills.create_first', 'Create your first skill')}
                            </button>
                        )}
                    </div>
                )}

                {!loading && !error && filtered.length > 0 && (
                    <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                        {filtered.map((skill: SkillRecord) => (
                            <SkillCard
                                key={skill.id}
                                skill={skill}
                                isOwner={skill.userId === user?.id || user?.isAdmin}
                                isActive={activeSkillIds.includes(skill.id)}
                                onToggle={onToggleSkill}
                                onEdit={onEdit}
                                onDelete={onDelete}
                                attachedAgentCount={attachedCountBySkillId[skill.id] || 0}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

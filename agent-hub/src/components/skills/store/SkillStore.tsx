import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Copy, ExternalLink, Heart, Layers, Search, X, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import SkillCard from '@/components/skills/SkillCard';
import type { SkillRecord } from '@/components/skills/SkillCard';
import { toast } from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';
import { skillKeys, useSkillsQuery } from '@/api/queries/skills';
import { copySkill, fetchSkillStoreStats } from '@/api/skillStoreApi';
import scopedStorage from '@/utils/scopedStorage';
import AddToAgentMenu from './AddToAgentMenu';
import { categoryTab, isDynamic, storeSkills, type StoreSkill } from './skillStoreModel';

/**
 * The Skill store, the Agent store's neighbour (reached through the "Skills"
 * tab above the Agent store, StoreSwitch.tsx).
 *
 * It shows the skills this account may SEE (`GET /api/skills`: its own, and
 * those shared with the organisation or one of its groups) with the Agent
 * store's search and tabs: Popular and Recently used come from
 * `GET /api/skills/store-stats` (skill_activations), Favourites are kept per
 * browser. Each card is the skills panel's own SkillCard, with the store's
 * badges and actions in its two slots:
 *
 *   Open           the skill in Studio → Skills (read-only when not yours to edit)
 *   Add to agent   one of your own agents, through the agent editor's save
 *   Make a copy    for a skill of someone else: your private copy to change
 *
 * No new rights: what is shown is what the list already returns, a copy is
 * `POST /api/skills/:id/copy` behind `manage_skills`, and attaching is
 * `PUT /agents/:id` behind `manage_agents` and the agent's edit grade.
 */
export interface SkillStoreProps {
    user: { id?: string; isAdmin?: boolean; permissions?: string[] | null } | null | undefined;
    onClose: () => void;
    onNavigate?: ((to: string) => void) | null;
}

const FAVORITES_KEY = 'skill_store_favorites';
const STATIC_TABS = [
    { key: 'popular', tKey: 'skillStore.tab_popular', en: 'Popular' },
    { key: 'lastused', tKey: 'skillStore.tab_last_used', en: 'Recently used' },
    { key: 'favorites', tKey: 'skillStore.tab_favorites', en: 'Favourites' },
    { key: 'all', tKey: 'skillStore.tab_all', en: 'All' },
];

function holds(user: SkillStoreProps['user'], permission: string): boolean {
    return !!user && (user.isAdmin === true || (user.permissions || []).some((p) => p === 'all' || p === permission));
}

export default function SkillStore({ user, onClose, onNavigate = null }: SkillStoreProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [query, setQuery] = useState('');
    const [tab, setTab] = useState('popular');
    const [favorites, setFavorites] = useState<string[]>(() => scopedStorage.getJSON<string[]>(FAVORITES_KEY, []) ?? []);
    const list = useSkillsQuery();
    const stats = useQuery({ queryKey: [...skillKeys.all, 'store', 'stats'], queryFn: fetchSkillStoreStats, retry: false, staleTime: 30_000 });
    const skills = useMemo(() => (list.data || []) as StoreSkill[], [list.data]);
    const categories = useMemo(() => [...new Set(skills.map((s) => (s.category || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [skills]);
    if (tab.startsWith('cat:') && !categories.some((c) => categoryTab(c) === tab)) setTab('popular');
    const shown = useMemo(() => storeSkills(skills, { tab, query, stats: stats.data, favorites }), [skills, tab, query, stats.data, favorites]);

    const canManageSkills = holds(user, 'manage_skills');
    const canManageAgents = holds(user, 'manage_agents');
    const open = (id: string) => { onClose(); onNavigate?.(`studio/skills/${id}`); };

    const toggleFavorite = (id: string) => {
        const next = favorites.includes(id) ? favorites.filter((x) => x !== id) : [...favorites, id];
        scopedStorage.setJSON(FAVORITES_KEY, next);
        setFavorites(next);
    };

    const copy = useMutation({
        mutationFn: (s: StoreSkill) => copySkill(s.id, t('skillStore.copy_name', '{name} (copy)', { name: s.name || '' })),
        onSuccess: async (created) => {
            await queryClient.invalidateQueries({ queryKey: skillKeys.all });
            toast.success(t('skillStore.copy_done', 'Copy made. It is yours: change it without changing the original.'));
            if (created?.id && onNavigate) open(created.id);
        },
        onError: (e) => { toast.error((e as Error)?.message || t('skillStore.copy_failed', 'Could not make a copy.')); },
    });

    const tabs = [...STATIC_TABS.slice(0, 3).map((x) => ({ key: x.key, label: t(x.tKey, x.en) })),
        ...categories.map((c) => ({ key: categoryTab(c), label: c })),
        { key: 'all', label: t('skillStore.tab_all', 'All') }];

    return (
        <div className="flex-1 flex flex-col overflow-hidden w-full h-full bg-[var(--bg-secondary)]" data-testid="skill-store">
            <StoreHeader t={t} shown={shown.length} total={skills.length} query={query} setQuery={setQuery} tabs={tabs} tab={tab} setTab={setTab} onClose={onClose} />
            <div className="flex-1 overflow-auto px-6 py-5">
                {list.isLoading && <p className="text-xs text-[var(--text-tertiary)]">{t('skillStore.loading', 'Loading skills…')}</p>}
                {list.isError && <p role="status" className="text-xs text-[var(--warning)]">{t('skillStore.err_list', 'The skills could not be read.')}</p>}
                {list.isSuccess && shown.length === 0 && (
                    <p className="py-12 text-center text-sm text-[var(--text-secondary)]" data-testid="skill-store-empty">
                        {query.trim() ? t('skillStore.none_match', 'No skill matches your search.') : t('skillStore.none_here', 'Nothing here yet.')}
                    </p>
                )}
                <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                    {shown.map((s) => (
                        <SkillCard
                            key={s.id}
                            skill={s as SkillRecord}
                            badges={<StoreBadges skill={s} t={t} />}
                            actions={(
                                <CardActions
                                    skill={s}
                                    t={t}
                                    favorite={favorites.includes(s.id)}
                                    onFavorite={() => toggleFavorite(s.id)}
                                    onOpen={canManageSkills && onNavigate ? () => open(s.id) : null}
                                    attachAs={canManageAgents && user?.id ? user.id : null}
                                    onCopy={canManageSkills && s.userId !== user?.id ? () => copy.mutate(s) : null}
                                    copying={copy.isPending}
                                />
                            )}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}

type T = ReturnType<typeof useTranslation>['t'];

function StoreBadges({ skill, t }: { skill: StoreSkill; t: T }) {
    const chip = 'flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded';
    return (
        <>
            {isDynamic(skill)
                ? <span className={`${chip} text-violet-500 bg-violet-500/10`}><Zap size={9} /> {t('skillStore.badge_dynamic', 'dynamic')}</span>
                : <span className={`${chip} bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]`}><Layers size={9} /> {t('skillStore.badge_static', 'always on')}</span>}
            {skill.agentOnly === true && (
                <span className={`${chip} text-amber-600 bg-amber-500/10`} data-testid={`skill-store-agent-only-${skill.id}`}>
                    <Bot size={9} /> {t('skillStore.badge_agent_only', 'only through agents')}
                </span>
            )}
            {skill.category && <span className={`${chip} bg-[var(--bg-tertiary)] text-[var(--text-secondary)]`}>{skill.category}</span>}
        </>
    );
}

function StoreAction({ onClick, Icon, label, testid, disabled = false }: { onClick: () => void; Icon: typeof Copy; label: string; testid: string; disabled?: boolean }) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            data-testid={testid}
            className="h-7 px-2.5 rounded-lg text-[12px] font-medium inline-flex items-center gap-1 bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
            <Icon size={12} aria-hidden="true" /> {label}
        </button>
    );
}

interface StoreHeaderProps {
    t: T;
    shown: number;
    total: number;
    query: string;
    setQuery: (q: string) => void;
    tabs: { key: string; label: string }[];
    tab: string;
    setTab: (k: string) => void;
    onClose: () => void;
}

function StoreHeader({ t, shown, total, query, setQuery, tabs, tab, setTab, onClose }: StoreHeaderProps) {
    return (
        <div className="px-6 pt-5 pb-4 border-b bg-[var(--bg-primary)] border-[var(--border-subtle)]">
            <div className="flex items-center justify-between mb-3">
                <div>
                    <h1 className="text-xl font-bold text-[var(--text-primary)]">{t('skillStore.title', 'Skill store')}</h1>
                    <p className="text-xs mt-0.5 text-[var(--text-muted)]">
                        {t('skillStore.count', '{visible} of {total} skills', { visible: shown, total })}
                    </p>
                </div>
                <button type="button" onClick={onClose} aria-label={t('skillStore.close', 'Close')} className="p-2 rounded-lg text-[var(--text-muted)]">
                    <X className="w-5 h-5" />
                </button>
            </div>
            <div className="relative mb-3">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                <input
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('skillStore.search', 'Search skills…')}
                    aria-label={t('skillStore.search', 'Search skills…')}
                    data-testid="skill-store-search"
                    className="w-full pl-9 pr-4 py-2 rounded-lg border text-sm focus:outline-none [background:var(--bg-secondary)] [border-color:var(--border-subtle)] [color:var(--text-primary)]!"
                />
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto py-1 [scrollbar-width:none]" role="tablist">
                {tabs.map((x) => (
                    <button
                        key={x.key}
                        type="button"
                        role="tab"
                        aria-selected={tab === x.key}
                        onClick={() => setTab(x.key)}
                        data-testid={`skill-store-tab-${x.key}`}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium shrink-0 border transition-all ${tab === x.key
                            ? 'bg-[var(--text-primary)] text-[var(--text-on-ink)] border-[var(--text-primary)]'
                            : 'bg-transparent text-[var(--text-secondary)] border-[var(--border-subtle)]'}`}
                    >
                        {x.label}
                    </button>
                ))}
            </div>
        </div>
    );
}

interface CardActionsProps {
    skill: StoreSkill;
    t: T;
    favorite: boolean;
    onFavorite: () => void;
    onOpen: (() => void) | null;
    attachAs: string | null;
    onCopy: (() => void) | null;
    copying: boolean;
}

function CardActions({ skill: s, t, favorite, onFavorite, onOpen, attachAs, onCopy, copying }: CardActionsProps) {
    return (
        <span className="flex items-center gap-1 flex-wrap">
            <button
                type="button"
                onClick={onFavorite}
                aria-pressed={favorite}
                aria-label={t('skillStore.favorite', 'Favourite')}
                title={t('skillStore.favorite', 'Favourite')}
                className="w-7 h-7 rounded-md grid place-items-center hover:bg-[var(--bg-tertiary)]"
            >
                <Heart size={13} className={favorite ? 'text-red-500 fill-red-500' : 'text-[var(--text-tertiary)]'} />
            </button>
            {onOpen && (
                <StoreAction onClick={onOpen} Icon={ExternalLink} testid={`skill-store-open-${s.id}`}
                    label={s.canEdit ? t('skillStore.open', 'Open') : t('skillStore.view', 'View')} />
            )}
            {attachAs && <AddToAgentMenu skillId={s.id} skillName={s.name || ''} userId={attachAs} />}
            {onCopy && (
                <StoreAction onClick={onCopy} Icon={Copy} testid={`skill-store-copy-${s.id}`}
                    disabled={copying} label={t('skillStore.copy', 'Make a copy')} />
            )}
        </span>
    );
}

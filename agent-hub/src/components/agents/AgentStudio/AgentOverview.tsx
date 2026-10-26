import { Bot, Loader2, Plus, Search } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import AgentCard from './AgentCard';
import { NO_CATEGORY, categoryChipsOf, filterAgents } from './agentCardFacts';
import type { AgentListRow, CategoryLike } from './agentCardFacts';
import EmptyState from '../../shared/EmptyState';
import { PRIMARY_ACTION_STYLE } from '../../shared/StudioSectionHeader';
import { useAgentEditorBootstrap } from '../AgentWizard/AgentEditorBootstrapContext';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { OrgGroup } from '../AgentDesigner/PublishMenu';

export interface AgentOverviewProps<T extends AgentListRow> {
    t: TranslateFn;
    agents?: readonly T[] | null;
    loading?: boolean;
    error?: string | null;
    onRetry?: (() => void) | null;
    onOpen: (agent: T) => void;
    onDelete?: ((agent: T | null | undefined) => void) | null;
    onCreate?: (() => void) | null;
    selectedId?: string | null;
    systemMode?: boolean;
    viewerId?: string | null;
}

/** One shared empty list, so that a missing source is not a new identity on every render. */
const EMPTY = Object.freeze([]);

/**
 * The agent overview: heading with count, category chips, search field, "New agent" and a card grid of three columns (Bee Flow Builder redesign, Sept 2026; Agents artboard 1a, A5 part C).
 *
 * This replaced the 264px sidebar with text lines. An agent is not a line in a list but a thing with a status, an audience and an equipment, and those four questions did not fit beside each other.
 *
 * ── THE FOUR BRANCHES ARE IN ONE aria-live BLOCK ──────────────────
 * The pattern of Studio/Datatables/DatatablesStudio.jsx:177-198: one `<div aria-live="polite">` around the WHOLE changing block, with loading → error → empty → rows inside it as one ternary chain. The spinner is `aria-hidden` with an `sr-only` label next to it. And the "empty" sentence is NOT drawn when there was an error: "loaded but empty" and "the read failed" must not contradict each other on screen.
 *
 * ── THE CHIPS FILTER, THEY CLAIM NOTHING ──────────────────────────
 * Only categories that also actually have an agent get a chip, plus "No category" if there is an agent without one (categoryChipsOf). An agent whose category could not be read ends up in NO chip — it does not belong under "no category" — and stays visible as long as no chip is active; its card itself says that the category is unknown.
 */
export default function AgentOverview<T extends AgentListRow>({
    t,
    agents,
    loading = false,
    error = null,
    onRetry = null,
    onOpen,
    onDelete = null,
    onCreate = null,
    selectedId = null,
    systemMode = false,
    viewerId = null,
}: AgentOverviewProps<T>) {
    const bootstrap = useAgentEditorBootstrap();
    // useMemo, not a ternary in the body: a fresh `[]` per render would invalidate every memo below on each render.
    const categories = useMemo<readonly CategoryLike[]>(
        () => (Array.isArray(bootstrap?.categories) ? bootstrap.categories : EMPTY),
        [bootstrap?.categories],
    );
    const orgGroups: readonly OrgGroup[] = Array.isArray(bootstrap?.orgGroups) ? bootstrap.orgGroups : EMPTY;

    const [query, setQuery] = useState('');
    const [categoryId, setCategoryId] = useState<string | null | undefined>(null);

    const rows = useMemo<readonly T[]>(() => (Array.isArray(agents) ? agents : EMPTY), [agents]);
    const chips = useMemo(() => categoryChipsOf(rows, categories), [rows, categories]);

    // A chip that disappears from the list (the last agent of it removed, or the category list arriving later) may not linger as an invisible filter — then there is an empty grid with no way to see why.
    const effectiveCategoryId = categoryId && chips.some(c => c.id === categoryId) ? categoryId : null;
    const visible = useMemo(
        () => filterAgents(rows, { query, categoryId: effectiveCategoryId, categories }),
        [rows, query, effectiveCategoryId, categories],
    );

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto px-6 py-8 space-y-4 max-w-[1100px]">
                    <div className="flex items-end gap-3 flex-wrap">
                        <div className="flex-1 min-w-0">
                            <h2 className="text-[18px] font-semibold text-[var(--text-primary)]">
                                {systemMode
                                    ? t('agent_studio.title_system', 'System Agents')
                                    : t('agent_studio.title', 'Agents')}
                                {!loading && !error && rows.length > 0 && (
                                    <span className="ml-2 font-medium text-[var(--text-tertiary)]" data-testid="agent-overview-count">
                                        {rows.length}
                                    </span>
                                )}
                            </h2>
                            <p className="text-sm mt-1 text-[var(--text-secondary)]">
                                {t('agent_studio.intro', 'An agent answers in your words, from the knowledge and tools you give it. Open one to change what it knows and what it may do.')}
                            </p>
                        </div>
                        <SearchBox t={t} value={query} onChange={setQuery} />
                        {onCreate && (
                            <button
                                type="button"
                                onClick={onCreate}
                                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                                style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                            >
                                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                                {t('agent_studio.new_agent', 'New agent')}
                            </button>
                        )}
                    </div>

                    {chips.length > 0 && (
                        <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label={t('agent_studio.filter_category', 'Filter by category')}>
                            <Chip
                                label={t('agent_studio.filter_all', 'All')}
                                count={rows.length}
                                active={!effectiveCategoryId}
                                onClick={() => setCategoryId(null)}
                            />
                            {chips.map(c => (
                                <Chip
                                    key={c.id}
                                    label={c.id === NO_CATEGORY ? t('agent_studio.filter_no_category', 'No category') : c.name}
                                    count={c.count}
                                    active={effectiveCategoryId === c.id}
                                    onClick={() => setCategoryId(effectiveCategoryId === c.id ? null : c.id)}
                                />
                            ))}
                        </div>
                    )}

                    {/* ONE live region, with roleless children. `role="status"` on the spinner and `role="alert"` on the error were two live regions nested in this: the screen reader then announced the error twice (assertive AND polite), and with every keystroke in the search field read the whole changed content out again. Same shape as components/admin/Studio/Datatables/DatatablesStudio.jsx. */}
                    <div aria-live="polite">
                        {loading ? (
                            <div className="flex items-center justify-center py-12 text-[var(--text-tertiary)]" aria-busy="true">
                                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                                <span className="sr-only">{t('agent_studio.loading', 'Loading agents')}</span>
                            </div>
                        ) : error ? (
                            <div
                                className="px-3 py-2.5 rounded-lg text-sm flex flex-col gap-2 items-start bg-[var(--bg-secondary)] text-[var(--warning)]"
                                data-testid="agent-overview-error"
                            >
                                <span>{t('agent_studio.load_error', 'Failed to load agents')}: {error}</span>
                                {onRetry && (
                                    <button
                                        type="button"
                                        onClick={onRetry}
                                        className="px-2 py-1 rounded-md text-xs border border-[var(--border-default)] text-[var(--text-secondary)]"
                                    >
                                        {t('agent_studio.retry', 'Retry')}
                                    </button>
                                )}
                            </div>
                        ) : rows.length === 0 ? (
                            <EmptyState
                                icon={<Bot className="w-10 h-10" aria-hidden="true" />}
                                title={t('agent_studio.empty_title', 'No agents yet')}
                                description={t('agent_studio.empty_body', 'An agent answers questions in your own words, using the knowledge and tools you give it.')}
                                action={onCreate ? {
                                    label: t('agent_studio.new_agent', 'New agent'),
                                    onClick: onCreate,
                                    icon: <Plus className="w-4 h-4" aria-hidden="true" />,
                                } : undefined}
                            />
                        ) : visible.length === 0 ? (
                            <p className="text-sm text-[var(--text-secondary)]" data-testid="agent-overview-no-match">
                                {t('agent_studio.search_empty', 'No agent matches that.')}
                            </p>
                        ) : (
                            <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 list-none p-0 m-0">
                                {visible.map(a => (
                                    <AgentCard
                                        key={a.id || a.name}
                                        t={t}
                                        agent={a}
                                        categories={categories}
                                        orgGroups={orgGroups}
                                        viewerId={viewerId}
                                        selected={!!selectedId && a.id === selectedId}
                                        onOpen={() => onOpen(a)}
                                        onDelete={onDelete}
                                    />
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

/** Het zoekveld, op elke lijstlengte aanwezig — zie DatatablesStudio's SearchBox. */
function SearchBox({ t, value, onChange }: { t: TranslateFn; value: string; onChange: (value: string) => void }) {
    return (
        <label className="relative block shrink-0 w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)]" aria-hidden="true" />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('agent_studio.search_short', 'Search an agent…')}
                aria-label={t('agent_studio.search', 'Search agents by name, purpose or category')}
                className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 [background:var(--bg-card)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline-color:var(--accent-primary)]!"
            />
        </label>
    );
}

/** One filter chip. `aria-pressed` because it is a toggle, not navigation. */
function Chip({ label, count, active, onClick }: { label: string | null | undefined; count: number | undefined; active: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={!!active}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-xs border transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
            style={{
                borderColor: active ? 'var(--accent-primary)' : 'var(--border-default)',
                background: active ? 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' : 'var(--bg-card)',
                color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
                outlineColor: 'var(--accent-primary)',
            }}
        >
            <span className="truncate max-w-[12rem]">{label}</span>
            <span className="text-[var(--text-tertiary)]">{count}</span>
        </button>
    );
}

import { CircleAlert, Loader2, Plus, Search } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { freshnessOf, TONE, type FreshnessKb } from './freshness';
import { knowledgeApi, type KbSuggestion, type KbUsageSummary, type KnowledgeBase } from './knowledgeApi';
import { nOf } from './plural';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import { kindColorVar, kindIcon, kindOf, kindTileStyle } from '../../../shared/kindColors';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { RelativeTimeInput } from '../../../../hooks/useRelativeTime';
import type { KnowledgeOverviewProps, CategoryChipsProps, SearchBoxProps, KbRowProps, UsagePillsProps, FreshnessCellProps, NoKnowledgeYetProps, SuggestionBannerProps } from './KnowledgeOverview.types';

export default function KnowledgeOverview({
    hasPermission = () => true,
    onOpen,
    onCreate,
    usageByKb = null,
    suggestion = null,
    onAcceptSuggestion = null,
    onDismissSuggestion = null,
    createError = null,
}: KnowledgeOverviewProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [kbs, setKbs] = useState<KnowledgeBase[]>([]);
    const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
    const [categoryFilter, setCategoryFilter] = useState('all');
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const canCreate = hasPermission('manage_knowledge');

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [list, cats] = await Promise.all([
                knowledgeApi.list(),
                knowledgeApi.categories().catch(() => null),
            ]);
            setKbs(Array.isArray(list) ? list : (list?.kbs || []));
            if (cats) setCategories(Array.isArray(cats) ? cats : []);
        } catch (e) {
            setError((e as Error).message || t('knowledge.err_list', 'Could not load your knowledge bases'));
            setKbs([]);
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => { load(); }, [load]);

    const UNCATEGORISED = 'none';
    const hasUncategorised = useMemo(() => kbs.some(kb => !kb.category_id), [kbs]);
    const visibleCategories = useMemo(() => {
        const used = new Set(kbs.map(kb => kb.category_id).filter(Boolean));
        return categories.filter(c => used.has(c.id));
    }, [kbs, categories]);

    // A filter whose chip is gone strands the person on an empty list with
    // no way back that they can see.
    useEffect(() => {
        if (categoryFilter === 'all') return;
        if (categoryFilter === UNCATEGORISED ? hasUncategorised : visibleCategories.some(c => c.id === categoryFilter)) return;
        setCategoryFilter('all');
    }, [categoryFilter, hasUncategorised, visibleCategories]);

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return kbs.filter((kb) => {
            if (categoryFilter === UNCATEGORISED && kb.category_id) return false;
            if (categoryFilter !== 'all' && categoryFilter !== UNCATEGORISED && kb.category_id !== categoryFilter) return false;
            if (!q) return true;
            return [kb.name, kb.description].some(v => String(v || '').toLowerCase().includes(q));
        });
    }, [kbs, categoryFilter, query]);

    const categoryName = useCallback(
        (id: string | null | undefined) => categories.find(c => c.id === id)?.name || null,
        [categories],
    );

    return (
        <div className="h-full flex flex-col overflow-hidden" data-testid="kb-overview">
            <StudioSectionHeader
                kind="kb"
                title={t('knowledge.title', 'Knowledge bases')}
                statusChip={!loading && !error && kbs.length > 0 ? String(kbs.length) : null}
                primary={canCreate ? (
                    <button
                        type="button"
                        onClick={onCreate}
                        data-tour="knowledge-create"
                        data-testid="kb-create"
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    >
                        <Plus className="w-3 h-3" aria-hidden="true" />
                        {t('knowledge.new', 'New knowledge base')}
                    </button>
                ) : null}
            />

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto px-4 py-4 flex flex-col gap-2.5 max-w-[884px]">
                    <div className="flex items-center gap-2 flex-wrap">
                        <CategoryChips
                            t={t}
                            value={categoryFilter}
                            onChange={setCategoryFilter}
                            categories={visibleCategories}
                            hasUncategorised={hasUncategorised}
                        />
                        {/* The box appears past four, the DatatablesStudio
                            threshold — under that the eye is faster. */}
                        {kbs.length > 4 && <SearchBox t={t} value={query} onChange={setQuery} />}
                    </div>

                    {createError && (
                        <p className="px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--error)]" role="alert">
                            {createError}
                        </p>
                    )}

                    <div aria-live="polite" className="flex flex-col gap-2.5">
                        {loading ? (
                            <div className="flex items-center justify-center py-12 text-[var(--text-tertiary)]">
                                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                                <span className="sr-only">{t('knowledge.loading', 'Loading…')}</span>
                            </div>
                        ) : error ? (
                            <p className="px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--warning)]">
                                {error}
                            </p>
                        ) : kbs.length === 0 ? (
                            <NoKnowledgeYet t={t} canCreate={canCreate} onCreate={onCreate} />
                        ) : shown.length === 0 ? (
                            <p className="text-sm text-[var(--text-secondary)]">
                                {t('knowledge.search_empty', 'No knowledge base matches that.')}
                            </p>
                        ) : shown.map(kb => (
                            <KbRow
                                key={kb.id}
                                t={t}
                                rel={rel}
                                kb={kb}
                                categoryName={categoryName(kb.category_id)}
                                usage={usageByKb?.[kb.id] || null}
                                onOpen={() => onOpen?.(kb.id)}
                            />
                        ))}
                    </div>

                    {suggestion && (
                        <SuggestionBanner t={t} suggestion={suggestion} onAccept={onAcceptSuggestion} onDismiss={onDismissSuggestion} />
                    )}
                </div>
            </div>
        </div>
    );
}

function CategoryChips({ t, value, onChange, categories, hasUncategorised }: CategoryChipsProps) {
    const chips = [
        { id: 'all', label: t('knowledge.filter_all', 'All') },
        ...categories.map(c => ({ id: c.id, label: c.name })),
        ...(hasUncategorised ? [{ id: 'none', label: t('knowledge.filter_uncategorised', 'Uncategorised') }] : []),
    ];
    return (
        <div role="group" aria-label={t('knowledge.filter_label', 'Filter by category')} className="flex gap-1 flex-wrap">
            {chips.map(c => {
                const on = value === c.id;
                return (
                    <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => onChange(c.id)}
                        className="px-2 py-0.5 rounded-full text-[11px] font-medium border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                        style={on
                            ? { background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)', borderColor: 'transparent', outlineColor: 'var(--accent-primary)' }
                            : { background: 'transparent', color: 'var(--text-secondary)', borderColor: 'var(--border-default)', outlineColor: 'var(--accent-primary)' }}
                    >
                        {c.label}
                    </button>
                );
            })}
        </div>
    );
}

function SearchBox({ t, value, onChange }: SearchBoxProps) {
    return (
        <label className="relative block shrink-0 ml-auto w-[200px]">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-tertiary)]" aria-hidden="true" />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('knowledge.search', 'Search a knowledge base…')}
                aria-label={t('knowledge.search_label', 'Search knowledge bases by name or purpose')}
                className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 [background:var(--bg-card)] [border-color:var(--border-default)] [color:var(--text-primary)]! [outline-color:var(--accent-primary)]!"
            />
        </label>
    );
}

function KbRow({ t, rel, kb, categoryName, usage, onOpen }: KbRowProps) {
    const { tile, glyph } = kindTileStyle('kb', 36);
    const Icon = kindIcon('kb');
    const meta = [
        categoryName || t('knowledge.uncategorised', 'uncategorised'),
        nOf(t, 'knowledge.n_sources', kb.sourceCount ?? kb.source_count, '{count} source', '{count} sources'),
        nOf(t, 'knowledge.n_documents', kb.documentCount ?? kb.document_count, '{count} document', '{count} documents'),
        audienceWord(t, kb),
    ].filter(Boolean).join(' · ');

    return (
        <button
            type="button"
            onClick={onOpen}
            data-testid="kb-row"
            data-kb-id={kb.id}
            className="w-full text-left grid gap-3 items-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [grid-template-columns:1fr_200px_160px] [border-radius:12px] [background:var(--bg-card)] [border:1px_solid_var(--border-default)] [box-shadow:var(--shadow-sm)] [padding:14px] [outline-color:var(--accent-primary)]!"
        >
            <span className="flex items-center gap-2.5 min-w-0">
                <span style={tile} aria-hidden="true">{Icon && <Icon style={glyph} />}</span>
                <span className="min-w-0">
                    <span className="block text-[13px] font-semibold truncate text-[var(--text-primary)]">{kb.name}</span>
                    <span className="block text-[12px] truncate text-[var(--text-tertiary)]">{meta}</span>
                </span>
            </span>
            <UsagePills t={t} usage={usage} />
            <FreshnessCell t={t} rel={rel} kb={kb} usage={usage} />
        </button>
    );
}

/** "persoonlijk" · "organisatie" · "groepen X, Y" — the same words as the capsule. */
function audienceWord(t: TranslateFn, kb: KnowledgeBase) {
    const groups = Array.isArray(kb.shared_groups) ? kb.shared_groups : [];
    if (groups.length > 0) return t('visibility.groups', 'Groups').toLowerCase();
    if (kb.is_published) return t('visibility.entire_org', 'Entire organisation').toLowerCase();
    return t('visibility.personal', 'Personal').toLowerCase();
}

function UsagePills({ t, usage }: UsagePillsProps) {
    if (!usage) return <span aria-hidden="true" />;
    const counts = usage.counts || {};
    const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
    if (entries.length === 0) {
        return (
            <span className="flex gap-1 flex-wrap">
                <span
                    data-testid="kb-usage-none"
                    className="inline-flex items-center gap-1 px-1.5 rounded-full text-[11px] font-semibold [border:1px_dashed_var(--warning)] [color:var(--warning-ink)]!"
                >
                    {t('knowledge.used_by_nobody', 'used by nothing')}
                </span>
            </span>
        );
    }
    return (
        <span className="flex gap-1 flex-wrap">
            {entries.map(([rawKind, n]) => {
                const kind = kindOf(rawKind) || rawKind;
                const colour = kindColorVar(kind);
                const Icon = kindIcon(kind);
                const count = Number(n);
                // usage.kind_* is Track 0's vocabulary, singular and plural,
                // already translated — the same words the Used-by tab uses.
                const noun = t(`usage.kind_${kind}${count === 1 ? '' : '_plural'}`, kind);
                return (
                    <span
                        key={rawKind}
                        className="inline-flex items-center gap-1 px-1.5 rounded-full text-[11px] font-semibold"
                        style={{ background: `color-mix(in srgb, ${colour} 14%, transparent)`, color: colour }}
                    >
                        {Icon && <Icon className="w-2.5 h-2.5" aria-hidden="true" />}
                        {count} {noun}
                    </span>
                );
            })}
        </span>
    );
}

function FreshnessCell({ t, rel, kb, usage }: FreshnessCellProps) {
    const usageCount = usage ? Object.values(usage.counts || {}).reduce((a, b) => a + Number(b || 0), 0) : 0;
    const v = freshnessOf(kb, { usageCount });
    if (v.tone === TONE.PROBLEM) {
        return (
            <span className="inline-flex items-center gap-1.5 justify-self-end text-[12px] text-[var(--error)]" data-testid="kb-freshness" data-tone={v.tone}>
                <CircleAlert className="w-3 h-3" aria-hidden="true" />
                {t('knowledge.freshness.empty_in_use', 'empty, but in use')}
            </span>
        );
    }
    const dot = v.tone === TONE.OK ? 'var(--success)' : 'var(--text-tertiary)';
    return (
        <span className="inline-flex items-center gap-1.5 justify-self-end text-[12px] text-[var(--text-secondary)]" data-testid="kb-freshness" data-tone={v.tone}>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} aria-hidden="true" />
            {v.key === 'knowledge.freshness.updated'
                ? t('knowledge.freshness.updated', 'updated {when}', { when: rel(v.at) })
                : t(v.key, freshnessFallback(v.key), v.params)}
        </span>
    );
}

/** English of last resort, for the handful of verdict keys freshness.js emits. */
function freshnessFallback(key: string) {
    switch (key) {
        case 'knowledge.refresh.live': return 'live';
        case 'knowledge.refresh.on_change': return 'on change';
        case 'knowledge.refresh.after_meeting': return 'after every meeting';
        case 'knowledge.refresh.schedule': return 'on a schedule';
        case 'knowledge.refresh.manual': return 'manual';
        case 'knowledge.freshness.auto': return 'refreshes on its own';
        case 'knowledge.freshness.no_sources': return 'no sources yet';
        default: return 'nothing yet';
    }
}

function NoKnowledgeYet({ t, canCreate, onCreate }: NoKnowledgeYetProps) {
    const { tile, glyph } = kindTileStyle('kb', 48);
    const Icon = kindIcon('kb');
    return (
        <div className="flex flex-col items-center text-center gap-3 py-12">
            <span style={tile} aria-hidden="true">{Icon && <Icon style={glyph} />}</span>
            <div className="text-[15px] font-semibold text-[var(--text-primary)]">
                {t('knowledge.empty_title', 'No knowledge bases yet')}
            </div>
            <p className="text-sm max-w-md text-[var(--text-secondary)]">
                {t('knowledge.empty_body', 'A knowledge base is the material your AI may quote from: a folder, a table, a page, meeting notes. Add sources once and they keep themselves up to date.')}
            </p>
            {canCreate && (
                <button
                    type="button"
                    onClick={onCreate}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold"
                    style={PRIMARY_ACTION_STYLE}
                >
                    <Plus className="w-3 h-3" aria-hidden="true" />
                    {t('knowledge.new', 'New knowledge base')}
                </button>
            )}
        </div>
    );
}

function SuggestionBanner({ t, suggestion, onAccept, onDismiss }: SuggestionBannerProps) {
    return (
        <div
            data-testid="kb-suggestion"
            className="flex items-center gap-2.5 px-3.5 py-3 text-[12px] [border-radius:12px] [border:1px_dashed_var(--border-default)] [color:var(--text-secondary)]!"
        >
            <span>{suggestion.text}</span>
            {onAccept && (
                <button
                    type="button"
                    onClick={() => onAccept(suggestion)}
                    className="ml-auto px-2.5 py-1 rounded-lg font-semibold"
                    style={PRIMARY_ACTION_STYLE}
                >
                    {t('knowledge.suggestion_link', 'Link them')}
                </button>
            )}
            {onDismiss && (
                <button
                    type="button"
                    onClick={() => onDismiss(suggestion)}
                    data-testid="kb-suggestion-dismiss"
                    className={`px-2.5 py-1 rounded-lg ${onAccept ? '' : 'ml-auto'} [color:var(--text-tertiary)]`}
                >
                    {t('knowledge.suggestion_hide', 'Not now')}
                </button>
            )}
        </div>
    );
}

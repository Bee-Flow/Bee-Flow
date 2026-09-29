import { CircleAlert, Loader2, Plus, Search } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { freshnessOf, TONE } from './freshness';
import { knowledgeApi } from './knowledgeApi';
import { nOf } from './plural';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import { kindColorVar, kindIcon, kindOf, kindTileStyle } from '../../../shared/kindColors';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * Studio → Knowledge: every knowledge base, with how current it is and what
 * uses it (Knowledge artboard 1c-right, 884×640).
 *
 * ── THE LIST ANSWERS "IS THIS WORKING", NOT "HOW BIG IS IT" ─────────
 * The old sidebar showed a name and a document count. A document count is
 * the one number that cannot tell you whether a knowledge base is doing its
 * job: 140 documents nobody reads and 0 documents three agents depend on
 * look equally fine. So each row carries the two facts that DO answer it —
 * who uses this (the pills, K5) and when content last arrived (the
 * freshness cell) — and the count moves into the meta line where it belongs.
 *
 * ── "ZONDER CATEGORIE" IS A BUCKET, NOT A GAP ───────────────────────
 * The old chip row was built from `usedCategoryIds`, so a KB with no
 * category was reachable only through "Alle" — invisible the moment someone
 * filtered. Uncategorised is where a KB lands by default, which makes it the
 * bucket most likely to hold the one nobody has looked after. It gets its
 * own chip, and only when at least one KB is actually in it.
 *
 * ── A FAILING /categories MUST NOT TAKE THE LIST DOWN ────────────────
 * Kept from KBsStudio, deliberately: categories are chrome, the list is the
 * page. The catch is on the categories call alone so a 500 there costs the
 * chips and nothing else.
 */
export default function KnowledgeOverview({
    hasPermission = () => true,
    onOpen,
    onCreate,
    usageByKb = null,
    suggestion = null,
    onAcceptSuggestion = null,
    onDismissSuggestion = null,
    createError = null,
}) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [kbs, setKbs] = useState([]);
    const [categories, setCategories] = useState([]);
    const [categoryFilter, setCategoryFilter] = useState('all');
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

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
            setError(e.message || t('knowledge.err_list', 'Could not load your knowledge bases'));
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
        (id) => categories.find(c => c.id === id)?.name || null,
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
                <div className="mx-auto px-4 py-4 flex flex-col gap-2.5" style={{ maxWidth: 884 }}>
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
                        <p className="px-3 py-2.5 rounded-lg text-sm" role="alert"
                            style={{ background: 'var(--bg-secondary)', color: 'var(--error)' }}>
                            {createError}
                        </p>
                    )}

                    <div aria-live="polite" className="flex flex-col gap-2.5">
                        {loading ? (
                            <div className="flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }}>
                                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                                <span className="sr-only">{t('knowledge.loading', 'Loading…')}</span>
                            </div>
                        ) : error ? (
                            <p className="px-3 py-2.5 rounded-lg text-sm" style={{ background: 'var(--bg-secondary)', color: 'var(--warning)' }}>
                                {error}
                            </p>
                        ) : kbs.length === 0 ? (
                            <NoKnowledgeYet t={t} canCreate={canCreate} onCreate={onCreate} />
                        ) : shown.length === 0 ? (
                            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
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

/** `Alle · <cat> · Zonder categorie` — the artboard's chip row. */
function CategoryChips({ t, value, onChange, categories, hasUncategorised }) {
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

function SearchBox({ t, value, onChange }) {
    return (
        <label className="relative block shrink-0 ml-auto" style={{ width: 200 }}>
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('knowledge.search', 'Search a knowledge base…')}
                aria-label={t('knowledge.search_label', 'Search knowledge bases by name or purpose')}
                className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)' }}
            />
        </label>
    );
}

/**
 * One row: `grid 1fr 200px 160px`, radius 12, bg-card, border, shadow-sm,
 * padding 14 — the artboard's measurements literally.
 */
function KbRow({ t, rel, kb, categoryName, usage, onOpen }) {
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
            className="w-full text-left grid gap-3 items-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{
                gridTemplateColumns: '1fr 200px 160px',
                borderRadius: 12,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-sm)',
                padding: 14,
                outlineColor: 'var(--accent-primary)',
            }}
        >
            <span className="flex items-center gap-2.5 min-w-0">
                <span style={tile} aria-hidden="true">{Icon && <Icon style={glyph} />}</span>
                <span className="min-w-0">
                    <span className="block text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{kb.name}</span>
                    <span className="block text-[12px] truncate" style={{ color: 'var(--text-tertiary)' }}>{meta}</span>
                </span>
            </span>
            <UsagePills t={t} usage={usage} />
            <FreshnessCell t={t} rel={rel} kb={kb} usage={usage} />
        </button>
    );
}

/** "persoonlijk" · "organisatie" · "groepen X, Y" — the same words as the capsule. */
function audienceWord(t, kb) {
    const groups = Array.isArray(kb.shared_groups) ? kb.shared_groups : [];
    if (groups.length > 0) return t('visibility.groups', 'Groups').toLowerCase();
    if (kb.is_published) return t('visibility.entire_org', 'Entire organisation').toLowerCase();
    return t('visibility.personal', 'Personal').toLowerCase();
}

/**
 * "3 agents · 1 skill", or the dashed warning pill when nothing uses it.
 *
 * `usage === null` means K5's summary has not loaded (or has not shipped):
 * the cell stays EMPTY rather than claiming "door niemand gebruikt", which
 * would be a wrong accusation dressed as a fact.
 */
function UsagePills({ t, usage }) {
    if (!usage) return <span aria-hidden="true" />;
    const counts = usage.counts || {};
    const entries = Object.entries(counts).filter(([, n]) => Number(n) > 0);
    if (entries.length === 0) {
        return (
            <span className="flex gap-1 flex-wrap">
                <span
                    data-testid="kb-usage-none"
                    className="inline-flex items-center gap-1 px-1.5 rounded-full text-[11px] font-semibold"
                    style={{ border: '1px dashed var(--warning)', color: 'var(--warning-ink)' }}
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

/** The right-hand cell: a dot and a sentence, or the red "leeg, wel in gebruik". */
function FreshnessCell({ t, rel, kb, usage }) {
    const usageCount = usage ? Object.values(usage.counts || {}).reduce((a, b) => a + Number(b || 0), 0) : 0;
    const v = freshnessOf(kb, { usageCount });
    if (v.tone === TONE.PROBLEM) {
        return (
            <span className="inline-flex items-center gap-1.5 justify-self-end text-[12px]" style={{ color: 'var(--error)' }} data-testid="kb-freshness" data-tone={v.tone}>
                <CircleAlert className="w-3 h-3" aria-hidden="true" />
                {t('knowledge.freshness.empty_in_use', 'empty, but in use')}
            </span>
        );
    }
    const dot = v.tone === TONE.OK ? 'var(--success)' : 'var(--text-tertiary)';
    return (
        <span className="inline-flex items-center gap-1.5 justify-self-end text-[12px]" style={{ color: 'var(--text-secondary)' }} data-testid="kb-freshness" data-tone={v.tone}>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} aria-hidden="true" />
            {v.key === 'knowledge.freshness.updated'
                ? t('knowledge.freshness.updated', 'updated {when}', { when: rel(v.at) })
                : t(v.key, freshnessFallback(v.key), v.params)}
        </span>
    );
}

/** English of last resort, for the handful of verdict keys freshness.js emits. */
function freshnessFallback(key) {
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

function NoKnowledgeYet({ t, canCreate, onCreate }) {
    const { tile, glyph } = kindTileStyle('kb', 48);
    const Icon = kindIcon('kb');
    return (
        <div className="flex flex-col items-center text-center gap-3 py-12">
            <span style={tile} aria-hidden="true">{Icon && <Icon style={glyph} />}</span>
            <div className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                {t('knowledge.empty_title', 'No knowledge bases yet')}
            </div>
            <p className="text-sm max-w-md" style={{ color: 'var(--text-secondary)' }}>
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

/**
 * "This knowledge base fits that agent" (K5).
 *
 * A suggestion on a front page has to be dismissible, or it is an
 * instruction. "Not now" is remembered per person in scopedStorage — never
 * shared, because one colleague deciding a pairing is wrong is not the
 * organisation deciding it.
 */
function SuggestionBanner({ t, suggestion, onAccept, onDismiss }) {
    return (
        <div
            data-testid="kb-suggestion"
            className="flex items-center gap-2.5 px-3.5 py-3 text-[12px]"
            style={{ borderRadius: 12, border: '1px dashed var(--border-default)', color: 'var(--text-secondary)' }}
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
                    className={`px-2.5 py-1 rounded-lg ${onAccept ? '' : 'ml-auto'}`}
                    style={{ color: 'var(--text-tertiary)' }}
                >
                    {t('knowledge.suggestion_hide', 'Not now')}
                </button>
            )}
        </div>
    );
}

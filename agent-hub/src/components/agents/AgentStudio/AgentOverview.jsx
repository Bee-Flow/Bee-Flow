import { Bot, Loader2, Plus, Search } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import AgentCard from './AgentCard';
import { NO_CATEGORY, categoryChipsOf, filterAgents } from './agentCardFacts';
import EmptyState from '../../shared/EmptyState';
import { PRIMARY_ACTION_STYLE } from '../../shared/StudioSectionHeader';
import { useAgentEditorBootstrap } from '../AgentWizard/AgentEditorBootstrapContext';

/** Eén gedeelde lege lijst, zodat een ontbrekende bron geen nieuwe identiteit per render is. */
const EMPTY = Object.freeze([]);

/**
 * Het agentoverzicht: kop met teller, categoriechips, zoekveld, "New agent"
 * en een kaartraster van drie kolommen (Bee Flow Builder-herontwerp, sep 2026;
 * Agents-artboard 1a, A5 deel C).
 *
 * Dit verving de 264px zijbalk met tekstregels. Een agent is geen regel in een
 * lijst maar een ding met een status, een publiek en een uitrusting, en die
 * vier vragen pasten er niet naast elkaar in.
 *
 * ── DE VIER TAKKEN STAAN IN ÉÉN aria-live-BLOK ──────────────────────
 * Het patroon van Studio/Datatables/DatatablesStudio.jsx:177-198: één
 * `<div aria-live="polite">` om het HELE wisselende blok, met daarbinnen
 * laden → fout → leeg → rijen als één ternary-ketting. De spinner is
 * `aria-hidden` met een `sr-only` label ernaast. En de "leeg"-zin wordt NIET
 * getekend als er een fout was: "geladen maar leeg" en "de lezing faalde"
 * mogen elkaar niet op het scherm tegenspreken.
 *
 * ── DE CHIPS FILTEREN, ZE BEWEREN NIETS ─────────────────────────────
 * Alleen categorieën die ook echt een agent hebben krijgen een chip, plus
 * "No category" als er een agent zonder is (categoryChipsOf). Een agent
 * waarvan de categorie niet gelezen kon worden komt in GEEN chip terecht —
 * hij hoort niet bij "no category" — en blijft zichtbaar zolang er geen chip
 * actief is; zijn kaart zegt zelf dat de categorie onbekend is.
 */
export default function AgentOverview({
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
}) {
    const bootstrap = useAgentEditorBootstrap();
    // useMemo, niet een ternary in de body: een verse `[]` per render maakt elke
    // memo hieronder elke render opnieuw ongeldig.
    const categories = useMemo(
        () => (Array.isArray(bootstrap?.categories) ? bootstrap.categories : EMPTY),
        [bootstrap?.categories],
    );
    const orgGroups = Array.isArray(bootstrap?.orgGroups) ? bootstrap.orgGroups : EMPTY;

    const [query, setQuery] = useState('');
    const [categoryId, setCategoryId] = useState(null);

    const rows = useMemo(() => (Array.isArray(agents) ? agents : EMPTY), [agents]);
    const chips = useMemo(() => categoryChipsOf(rows, categories), [rows, categories]);

    // Een chip die uit de lijst verdwijnt (de laatste agent eruit gehaald, de
    // categorielijst kwam pas later binnen) mag niet als onzichtbaar filter
    // blijven hangen — dan staat er een leeg raster met geen enkele manier om
    // te zien waarom.
    const effectiveCategoryId = categoryId && chips.some(c => c.id === categoryId) ? categoryId : null;
    const visible = useMemo(
        () => filterAgents(rows, { query, categoryId: effectiveCategoryId, categories }),
        [rows, query, effectiveCategoryId, categories],
    );

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto px-6 py-8 space-y-4" style={{ maxWidth: 1100 }}>
                    <div className="flex items-end gap-3 flex-wrap">
                        <div className="flex-1 min-w-0">
                            <h2 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                                {systemMode
                                    ? t('agent_studio.title_system', 'System Agents')
                                    : t('agent_studio.title', 'Agents')}
                                {!loading && !error && rows.length > 0 && (
                                    <span className="ml-2 font-medium" style={{ color: 'var(--text-tertiary)' }} data-testid="agent-overview-count">
                                        {rows.length}
                                    </span>
                                )}
                            </h2>
                            <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
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

                    {/* ÉÉN live region, met rolloze kinderen. `role="status"` op de
                        spinner en `role="alert"` op de fout waren twee live
                        regions genest in deze: de schermlezer kondigde de fout
                        dan twee keer aan (assertief én polite) en las bij elke
                        aanslag in het zoekveld de hele gewijzigde inhoud
                        opnieuw voor. Zelfde vorm als
                        components/admin/Studio/Datatables/DatatablesStudio.jsx. */}
                    <div aria-live="polite">
                        {loading ? (
                            <div className="flex items-center justify-center py-12" style={{ color: 'var(--text-tertiary)' }} aria-busy="true">
                                <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                                <span className="sr-only">{t('agent_studio.loading', 'Loading agents')}</span>
                            </div>
                        ) : error ? (
                            <div
                                className="px-3 py-2.5 rounded-lg text-sm flex flex-col gap-2 items-start"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--warning)' }}
                                data-testid="agent-overview-error"
                            >
                                <span>{t('agent_studio.load_error', 'Failed to load agents')}: {error}</span>
                                {onRetry && (
                                    <button
                                        type="button"
                                        onClick={onRetry}
                                        className="px-2 py-1 rounded-md text-xs border"
                                        style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
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
                            <p className="text-sm" style={{ color: 'var(--text-secondary)' }} data-testid="agent-overview-no-match">
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
function SearchBox({ t, value, onChange }) {
    return (
        <label className="relative block shrink-0" style={{ width: 200 }}>
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
                style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('agent_studio.search_short', 'Search an agent…')}
                aria-label={t('agent_studio.search', 'Search agents by name, purpose or category')}
                className="w-full pl-8 pr-2 py-1.5 rounded-lg text-xs border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
                style={{
                    background: 'var(--bg-card)', borderColor: 'var(--border-default)',
                    color: 'var(--text-primary)', outlineColor: 'var(--accent-primary)',
                }}
            />
        </label>
    );
}

/** Eén filterchip. `aria-pressed` omdat het een schakelaar is, geen navigatie. */
function Chip({ label, count, active, onClick }) {
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
            <span style={{ color: 'var(--text-tertiary)' }}>{count}</span>
        </button>
    );
}

import React, { useId, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import IntegrationLogo from './nodes/IntegrationLogo';
import { buildStepGroups, buildSearchResults, gated } from './stepPalette';
import { stepDragProps } from './stepDrag';
import type { AddFn, AddStepMenuProps, RecoGroup } from './AddStepMenu.types';
import type { SearchCandidate } from './stepPalette.types';
import type { StepPayload } from './ribbon/ribbonCategories';
import { denseInputClass } from './settings/formStyles';
import { useTranslation } from '../../../../hooks/useTranslation';
import { GroupBlock } from './GroupBlock';

/**
 * Shared "add step" list content — rows, the apps category→app→action tree,
 * and search. Presentation only; positioning/outside-click are owned by the
 * caller (AddStepRibbon dropdown or the edge-drop popover in BuilderShell).
 */
export default function AddStepMenu({ scope = {}, group = null, showSearch, onAdd, onAfterAdd, autoFocus = false }: AddStepMenuProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const searchRef = useRef<HTMLInputElement>(null);
    const searchable = showSearch ?? !group;

    const add = (payload?: StepPayload | null) => { if (!payload) return; onAdd?.(payload); onAfterAdd?.(); };

    const results = useMemo(
        () => (query ? buildSearchResults(query, scope) : []),
        [query, scope],
    );
    const groups = useMemo(
        () => (group ? [group] : buildStepGroups(scope)),
        [group, scope],
    );
    // Smart sections (full menu only): context "Suggested next" + personal
    // "Frequently used", supplied by the caller via scope.
    //
    // Two things happen here that the caller (BuildTab) can't do, because it
    // builds the two lists independently and neither knows about the other:
    //
    //  · DEDUP (BFSF-361). The same step turning up in both blocks read as two
    //    different offers stacked on top of each other. "Suggested next" wins
    //    the tie and keeps its place: it is derived from what THIS graph needs
    //    next, so it is the more specific of the two, and it renders first —
    //    dropping the later copy leaves the rows the eye already scanned
    //    exactly where they were.
    //  · GATING (BFSF-348). These rows bypassed `gated()` entirely, so the
    //    "add a form step without a form trigger → guaranteed validation
    //    error" path was still fully reachable through them.
    //
    // Neither block belongs on the empty canvas (BFSF-367): with no trigger
    // yet, a "next step" cannot be placed at all, so suggesting one — above the
    // triggers, which is all the menu can accept — was noise the user had to
    // scroll past on their very first action.
    const recoGroups = useMemo(() => {
        if (group || scope.mode === 'trigger') return [];
        const out: RecoGroup[] = [];
        const seen = new Set<string>();
        const take = (items?: SearchCandidate[] | null) => (Array.isArray(items) ? items : [])
            .filter((r) => {
                const id = recoIdentity(r);
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
            })
            .map(r => gated(r, scope.hasFormTrigger));

        const suggested = take(scope.suggested);
        if (suggested.length) out.push({ key: '__suggested', title: 'Suggested next', accent: true, items: suggested });
        const frequent = take(scope.frequent);
        if (frequent.length) out.push({ key: '__frequent', title: 'Frequently used', accent: false, items: frequent });
        return out;
    }, [group, scope]);

    return (
        <div className="flex flex-col min-h-0">
            {searchable && (
                <div className="p-2 border-b border-[var(--border-default)]">
                    <div className="relative">
                        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                        <input
                            ref={searchRef}
                            type="text"
                            autoFocus={autoFocus}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={t('automations.add_step_menu.search_steps', 'Search steps…')}
                            className={denseInputClass('w-full pl-7 pr-2')}
                        />
                    </div>
                </div>
            )}
            <div className="flex-1 overflow-y-auto custom-scrollbar min-h-0">
                {query ? (
                    <SearchResults results={results} q={query} onAdd={add} />
                ) : (
                    <>
                        {recoGroups.map(g => (
                            <RecoBlock key={g.key} title={g.title} accent={g.accent} items={g.items} onAdd={add} />
                        ))}
                        {groups.map(g => (
                            <GroupBlock key={g.key} group={g} singleGroup={!!group} onAdd={add} />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

/**
 * What makes two reco rows THE SAME offer. Compared on the payload rather than
 * the row's `key`, because the two lists are built by different resolvers and
 * a step id ('set') and a flowlet key can collide there — the payload is what
 * actually gets added, so payloads that would add the same thing are the same
 * thing.
 */
function recoIdentity(r: SearchCandidate) {
    const p: Partial<StepPayload> = r?.payload || {};
    const what = p.tool || p.layerKey || p.blockId || p.triggerKind || p.mode || '';
    return `${p.kind || ''}:${what}:${what ? '' : (r?.key || '')}`;
}

/** Smart "Suggested next" / "Frequently used" section (search-result rows). */
function RecoBlock({ title, accent, items, onAdd }: { title: string; accent: boolean; items: SearchCandidate[]; onAdd: AddFn }) {
    return (
        <div className="border-b border-[var(--border-default)] last:border-b-0">
            <div className={`px-3 pt-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wide ${accent ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'}`}>
                {title}
            </div>
            <div className="py-1">
                {items.map((r, idx) => <SearchResultRow key={`${r.key}:${idx}`} result={r} q="" onAdd={onAdd} />)}
            </div>
        </div>
    );
}

function SearchResults({ results, q, onAdd }: { results: SearchCandidate[]; q: string; onAdd: AddFn }) {
    const { t } = useTranslation();
    if (results.length === 0) {
        return <div className="px-3 py-6 text-xs text-[var(--text-tertiary)] italic text-center">{t('automations.add_step_menu.no_matches_for', 'No matches for “{query}”', { query: q })}</div>;
    }
    return (
        <div className="py-1">
            {results.map((r, i) => <SearchResultRow key={`${r.key}:${i}`} result={r} q={q} onAdd={onAdd} />)}
        </div>
    );
}

function SearchResultRow({ result, q, onAdd }: { result: SearchCandidate; q: string; onAdd: AddFn }) {
    const descId = useId();
    const Icon = result.Icon;
    // Same rule as SimpleRow: a result the graph can't accept is findable and
    // explains itself rather than not being a result at all.
    const disabled = !!result.disabled;
    const add = () => { if (!disabled) onAdd(result.payload); };
    return (
        <div
            {...(disabled ? null : stepDragProps(result.payload))}
            onClick={add}
            role="button"
            aria-label={result.label}
            aria-describedby={disabled || result.secondary ? descId : undefined}
            aria-disabled={disabled || undefined}
            tabIndex={0}
            title={disabled ? result.disabledReason : undefined}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); add(); } }}
            className={`group flex items-center gap-3 px-3 py-2 select-none focus:outline-none ${
                disabled
                    ? 'cursor-not-allowed opacity-55'
                    : 'cursor-pointer hover:bg-[var(--bg-secondary)] focus:bg-[var(--bg-secondary)]'
            }`}
        >
            <div className="shrink-0 h-8 w-8 rounded-lg bg-[var(--bg-secondary)] flex items-center justify-center text-[var(--text-secondary)]">
                {Icon ? <Icon size={16} /> : <IntegrationLogo integrationId={result.integrationId} tool={result.tool} size={16} />}
            </div>
            <div className="min-w-0 flex-1">
                <div className="text-sm text-[var(--text-primary)] truncate">{highlightMatch(result.label, q)}</div>
                {disabled
                    ? <div id={descId} className="text-xs text-[var(--text-tertiary)] italic line-clamp-2">{result.disabledReason}</div>
                    : result.secondary && <div id={descId} className="text-xs text-[var(--text-tertiary)] truncate">{result.secondary}</div>}
            </div>
            {result.context && <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{result.context}</span>}
        </div>
    );
}

function highlightMatch(text: string, q: string) {
    if (!q || !text) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return text;
    return (
        <>
            {text.slice(0, idx)}
            <mark className="bg-transparent font-semibold text-[var(--text-primary)]">{text.slice(idx, idx + q.length)}</mark>
            {text.slice(idx + q.length)}
        </>
    );
}

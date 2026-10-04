import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InlineButton } from './ribbon/jsComponents';
import type { MutableRefObject } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { TRIGGERS } from './stepPalette';
import { stepDragProps } from './stepDrag';
import scopedStorage from '../../../../utils/scopedStorage';
import useTranslation from '../../../../hooks/useTranslation';
import { presentingCategory } from './ribbon/ribbonCategories';
import type { RibbonCategoryId, StepPayload } from './ribbon/ribbonCategories';
import { searchRibbon } from './ribbon/ribbonSearch';
import type { RibbonAnchor } from './ribbon/ribbonAnchor';
import { useRibbonData, useCloseOnOutside, useSlashToFocus } from './ribbon/useRibbonData';
import type { RibbonScope } from './ribbon/useRibbonData';
import CategoryTabs, { AddsAfterPill } from './ribbon/CategoryTabs';
import RibbonSearchField from './ribbon/RibbonSearchField';
import RibbonPanel from './ribbon/RibbonPanel';

/**
 * The "Add step" ribbon (design 5a): ONE 44px row — search · category tabs ·
 * "Adds after [step n · label]" · collapse — and, expanded, the one category
 * that is chosen underneath it. Never all categories at once. Every category
 * is one compact row of pills (flow/ribbon/PillRow.tsx): a command of its own
 * adds on click, a group opens a dropdown, and what does not fit folds into
 * "More".
 *
 * Every command adds on click (after the anchor BuildTab resolves: the step
 * open in the drawer, else the last step) and is a drag source for the canvas
 * (flow/stepDrag.js). Commands, tabs and the root carry `data-ribbon-origin`
 * stamps so the build film can deal each card from where it would have been
 * added (flow/ribbonOrigin.js, flow/useRibbonFlight.js).
 *
 * Presenting (the AI is building): inert but not dimmed, expanded on the apps
 * tab. Derived only, so the author's own tab and expanded state return when
 * the build ends.
 *
 * The row folds by its OWN width (`@container/ribbon`): below 1440px the
 * anchor pill keeps only "step n", below 1180px inactive tabs keep only their
 * icon, below 820px the anchor pill goes and the search narrows.
 */

interface Props {
    scope?: RibbonScope;
    hasTrigger?: boolean;
    disabled?: boolean;
    onAddNode?: (payload: StepPayload) => void;
    presenting?: boolean;
    rootRef?: MutableRefObject<HTMLElement | null> | null;
    /** Where a click lands (flow/ribbon/ribbonAnchor.js). */
    anchor?: RibbonAnchor | null;
    /** Bumps after every add, so personal usage is read again. */
    usageVersion?: number;
}

const EXPANDED_KEY = 'automationsRibbonExpanded';
const CATEGORY_KEY = 'automationsRibbonCategory';

export default function AddStepRibbon({
    scope = {},
    hasTrigger = true,
    disabled = false,
    onAddNode,
    presenting = false,
    rootRef = null,
    anchor = null,
    usageVersion = 0,
}: Props) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(() => scopedStorage.getItem(EXPANDED_KEY) === '1');
    useEffect(() => { scopedStorage.setItem(EXPANDED_KEY, expanded ? '1' : '0'); }, [expanded]);
    const [chosen, setChosen] = useState<RibbonCategoryId>(() => (scopedStorage.getItem(CATEGORY_KEY) as RibbonCategoryId) || 'ai');
    useEffect(() => { scopedStorage.setItem(CATEGORY_KEY, chosen); }, [chosen]);
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement | null>(null);
    useSlashToFocus(inputRef, hasTrigger && !disabled && !presenting);

    // Which dropdown (an app's actions, a folded category, the agent list) is open.
    const [openKey, setOpenKey] = useState<string | null>(null);
    const rowRef = useRef<HTMLDivElement | null>(null);
    const closeMenu = useCallback(() => setOpenKey(null), []);
    useCloseOnOutside(openKey, closeMenu, rowRef);
    // A menu left open when the build starts would cover the cards dealt from behind it.
    useEffect(() => { if (presenting) setOpenKey(null); }, [presenting]);
    const setRoot = useCallback((el: HTMLDivElement | null) => {
        rowRef.current = el;
        if (rootRef) rootRef.current = el;
    }, [rootRef]);

    const { sections, categories, agents, skills, frequent, cards } = useRibbonData(scope, anchor, usageVersion, hasTrigger);
    const ids = categories.map(c => c.id);
    // A remembered tab that is not offered (e.g. 'suggested', switched off by
    // design; see SUGGESTED_TAB_ENABLED) falls back to the first one that is.
    const category: RibbonCategoryId = presenting
        ? presentingCategory(categories)
        : (ids.includes(chosen) ? chosen : (ids[0] || 'ai'));
    const open = expanded || presenting;

    const results = useMemo(
        () => (query.trim() ? searchRibbon(query, scope, { agents: agents || [], skills }) : []),
        [query, scope, agents, skills],
    );

    const add = (payload: StepPayload) => { onAddNode?.(payload); setOpenKey(null); setExpanded(false); };
    const select = (id: RibbonCategoryId) => {
        if (id === category && expanded) { setExpanded(false); return; }
        setChosen(id);
        setExpanded(true);
    };

    // No trigger yet: the ribbon offers the ways to start, and nothing else.
    if (!hasTrigger) {
        return (
            <div className={`flex items-center gap-1.5 flex-wrap px-3.5 min-h-11 py-1.5 border-b border-[var(--border-default)] bg-[var(--bg-card)] ${disabled ? 'opacity-50 pointer-events-none' : ''}`}>
                <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)] mr-1">
                    {t('automations.ribbon.start_with_trigger', 'Start with a trigger')}
                </span>
                {TRIGGERS.map(tr => (
                    <InlineButton key={tr.id} icon={tr.icon} label={tr.label} onClick={() => add(tr.payload)} {...stepDragProps(tr.payload)} />
                ))}
            </div>
        );
    }

    return (
        <div
            ref={setRoot}
            // Presenting is inert but NOT dimmed: the ring on a command and the ghost leaving it are the show.
            className={`@container/ribbon relative shrink-0 flex flex-col border-b border-[var(--border-default)] bg-[var(--bg-card)] ${
                presenting ? 'pointer-events-none' : (disabled ? 'opacity-50 pointer-events-none' : '')
            }`}
            data-testid="add-step-ribbon"
            data-ribbon-origin="ribbon"
            data-presenting={presenting ? '' : undefined}
            aria-disabled={(disabled || presenting) ? true : undefined}
        >
            <div className="h-11 flex items-center gap-1 px-3.5 text-[12px] text-[var(--text-primary)]">
                <RibbonSearchField query={query} onQueryChange={setQuery} results={results} onAdd={add} inputRef={inputRef} />
                <CategoryTabs categories={categories} active={category} expanded={open} onSelect={select} />
                <div className="ml-auto flex items-center gap-1.5 shrink-0 pl-2 text-[var(--text-tertiary)]">
                    {anchor && <AddsAfterPill anchor={anchor} />}
                    <button
                        type="button"
                        onClick={() => setExpanded(o => !o)}
                        aria-expanded={open}
                        aria-label={open ? t('automations.ribbon.collapse', 'Collapse the ribbon') : t('automations.ribbon.expand', 'Show this category')}
                        title={open ? t('automations.ribbon.collapse', 'Collapse the ribbon') : t('automations.ribbon.expand', 'Show this category')}
                        className="w-7 h-7 grid place-items-center rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    </button>
                </div>
            </div>
            {open && (
                <div className="px-3.5 pt-2 pb-3 text-[12px]" data-testid="ribbon-panel" data-category={category}>
                    <RibbonPanel
                        category={category}
                        sections={sections}
                        anchor={anchor}
                        cards={cards}
                        frequent={frequent}
                        agents={agents}
                        skills={skills}
                        open={open}
                        onAdd={add}
                        openKey={openKey}
                        setOpenKey={setOpenKey}
                    />
                </div>
            )}
        </div>
    );
}

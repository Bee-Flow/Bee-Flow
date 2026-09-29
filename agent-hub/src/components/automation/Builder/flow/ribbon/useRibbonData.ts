import { useEffect, useMemo } from 'react';
import type { RefObject } from 'react';
import { readUsage } from '../stepUsage';
import useTranslation from '../../../../../hooks/useTranslation';
import { useOrgStepUsageQuery } from '../../../../../api/queries/automation/usage';
import { useSkillsQuery } from '../../../../../api/queries/skills';
import { ribbonSections, availableCategories, SUGGESTED_TAB_ENABLED } from './ribbonCategories';
import { fitsAfterCards, mergeFrequentKeys, resolveFrequent } from './fitsAfter';
import type { AgentRow, SkillRow } from './ribbonSearch';
import type { RibbonAnchor } from './ribbonAnchor';

export type RibbonScope = Record<string, unknown> & {
    catalog?: Record<string, unknown> | null;
    layers?: unknown[];
    hasFormTrigger?: boolean | null;
};

/** The agent rows from the catalog; null when the server said the read failed. */
function agentRows(catalog: Record<string, unknown> | null | undefined): AgentRow[] | null {
    if (!catalog || catalog.agentsError) return null;
    return Array.isArray(catalog.agents) ? (catalog.agents as AgentRow[]) : [];
}

/**
 * Everything the ribbon shows that is not its own UI state: the palette split
 * into tabs, the agents and skills, the "Fits after" cards for the anchor and
 * the blended "Frequently used" list.
 */
export function useRibbonData(scope: RibbonScope, anchor: RibbonAnchor | null, usageVersion: number, enabled: boolean) {
    const { t } = useTranslation();
    const catalog = scope.catalog || null;
    const sections = useMemo(() => ribbonSections(scope, t), [scope, t]);
    const categories = useMemo(() => availableCategories(sections), [sections]);
    // The org usage only feeds the Suggested tab, which is switched off by
    // design (SUGGESTED_TAB_ENABLED); don't fetch it while it is off.
    const orgUsage = useOrgStepUsageQuery(enabled && SUGGESTED_TAB_ENABLED).data;
    const skills = (useSkillsQuery().data || []) as SkillRow[];
    const agents = useMemo(() => agentRows(catalog), [catalog]);
    // usageVersion bumps after every add; readUsage() reads scopedStorage.
    const personalUsage = useMemo(() => readUsage() as Record<string, unknown>, [usageVersion]);
    const frequent = useMemo(
        () => resolveFrequent(mergeFrequentKeys(orgUsage, personalUsage), {
            catalog, layers: scope.layers || [], hasFormTrigger: scope.hasFormTrigger ?? null,
        }),
        [orgUsage, personalUsage, catalog, scope.layers, scope.hasFormTrigger],
    );
    const cards = useMemo(
        () => fitsAfterCards(anchor?.step || null, catalog, { hasFormTrigger: scope.hasFormTrigger ?? null }),
        [anchor, catalog, scope.hasFormTrigger],
    );
    return { sections, categories, agents, skills, frequent, cards };
}

/**
 * Close the open dropdown on an outside click or Escape. Dropdown panels are
 * portalled to <body>, so a click inside one is not "outside". Capture phase:
 * the canvas stops mousedown propagation.
 */
export function useCloseOnOutside(openKey: string | null, close: () => void, rootRef: RefObject<HTMLElement | null>) {
    useEffect(() => {
        if (!openKey) return undefined;
        const onDown = (e: MouseEvent) => {
            const target = e.target as Element | null;
            if (rootRef.current && target && rootRef.current.contains(target)) return;
            if (target?.closest?.('[data-ribbon-dropdown]')) return;
            close();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey); };
    }, [openKey, close, rootRef]);
}

/** True when a key press belongs to whatever has focus (a field, an editor). */
function isTypingTarget(el: Element | null): boolean {
    if (!el || !(el instanceof HTMLElement)) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

/**
 * "/" focuses the ribbon search from anywhere in the editor, unless the key
 * is being typed into something. A DOM listener, not data fetching: the
 * effect only wires the keyboard.
 */
export function useSlashToFocus(inputRef: RefObject<HTMLInputElement | null>, enabled: boolean) {
    useEffect(() => {
        if (!enabled) return undefined;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
            if (isTypingTarget(document.activeElement)) return;
            e.preventDefault();
            inputRef.current?.focus();
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [inputRef, enabled]);
}

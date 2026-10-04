/**
 * The Content tab, decided: what is IN a Solution, grouped by what it is FOR
 * (the three bands), each row carrying only what the payloads actually say —
 * a port of the row logic in the web's projects/SolutionContentTable.jsx.
 *
 *   depends on  edges the graph drew to nodes it also drew; an edge out of
 *               the Solution is a finding, not a pill
 *   finding     the worst the checks raised about it; absent when they said
 *               nothing or did not answer — never an all-clear tick
 *   sub-line    facts the listing carries: live or paused, a draft, public,
 *               reachable through a public form
 */

import type { TranslateFn } from '@/core/i18n';

import { findingKind, worstByEntity } from './checks';
import { dependenciesByNode, formTriggeredAutomations, nodeIdFor } from './graph';
import { BANDS, SECTIONS, mayRemove, type BandKey, type SectionDef } from './sections';
import type { Completeness, Finding, GraphNode, SolutionGraph } from './solution';
import type { FiledItem, ProjectResources } from './types';

export interface ContentRow {
    section: SectionDef;
    item: FiledItem;
    dependsOn: GraphNode[];
    finding: Finding | null;
    formTriggered: boolean;
    removable: boolean;
}

export type SectionState =
    | { section: SectionDef; state: 'unavailable' }
    | { section: SectionDef; state: 'rows'; rows: ContentRow[] };

export interface BandContent {
    band: BandKey;
    sections: SectionState[];
    /** Every section in the band answered, and none holds anything. */
    empty: boolean;
}

export interface ContentInput {
    resources: ProjectResources;
    graph: SolutionGraph | null | undefined;
    completeness: Completeness | null | undefined;
    meId: string | undefined;
    canEdit: boolean;
}

function rowsFor(section: SectionDef, items: FiledItem[], input: ContentInput, derived: Derived): ContentRow[] {
    return items.map((item) => ({
        section,
        item,
        dependsOn: derived.deps.get(nodeIdFor(section.kind, item.id)) ?? [],
        finding: derived.worst.get(`${findingKind(section.kind)}:${item.id}`) ?? null,
        formTriggered: section.key === 'automations' && derived.forms.has(nodeIdFor('automation', item.id)),
        removable: mayRemove(section, item, input.meId, input.canEdit),
    }));
}

interface Derived {
    deps: Map<string, GraphNode[]>;
    worst: Map<string, Finding>;
    forms: Set<string>;
}

/** The three bands, each with its sections in the registry's order. */
export function contentBands(input: ContentInput): BandContent[] {
    const derived: Derived = {
        deps: dependenciesByNode(input.graph),
        worst: worstByEntity(input.completeness?.findings),
        forms: formTriggeredAutomations(input.graph),
    };
    return BANDS.map(({ key, sections }) => {
        const states: SectionState[] = SECTIONS.filter((s) => sections.includes(s.key)).map((section) => {
            const items = input.resources[section.key];
            return items === null
                ? { section, state: 'unavailable' as const }
                : { section, state: 'rows' as const, rows: rowsFor(section, items, input, derived) };
        });
        return {
            band: key,
            sections: states,
            empty: states.every((s) => s.state === 'rows' && s.rows.length === 0),
        };
    });
}

/** The facts a listing row carries about itself — nothing derived, nothing guessed. */
export function subLines(row: ContentRow, t: TranslateFn): string[] {
    const { item, section } = row;
    const out: string[] = [];
    if (section.key === 'automations') {
        if (item.isActive === true) out.push(t('solutions.sub_live', 'live'));
        else if (item.isActive === false) out.push(t('solutions.sub_paused', 'paused'));
        if (item.isDraft === true) out.push(t('solutions.sub_draft', 'draft'));
        if (row.formTriggered) out.push(t('solutions.sub_public_form', 'public form'));
    }
    if (section.key === 'webpages' && item.isPublished === true) out.push(t('solutions.sub_public', 'public'));
    if (section.key === 'knowledgeBases' && item.description?.trim()) out.push(item.description.trim());
    return out;
}

/**
 * The Overview tab's tiles: a count per kind, `null` when that store could
 * not be read (a dash, never a 0). Approvals count what is still waiting,
 * not how many ever existed.
 */
export function sectionCounts(resources: ProjectResources | null | undefined): { key: SectionDef['key']; count: number | null }[] {
    return SECTIONS.map((section) => {
        const items = resources?.[section.key] ?? null;
        if (items === null) return { key: section.key, count: null };
        if (section.key === 'approvals') {
            return { key: section.key, count: items.filter((a) => (a.status ?? 'pending') === 'pending').length };
        }
        return { key: section.key, count: items.length };
    });
}

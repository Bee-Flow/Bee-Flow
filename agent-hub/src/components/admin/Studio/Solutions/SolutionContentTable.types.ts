import type { SolutionItem, SolutionSection } from './solutionSections';
import type { ControlFinding } from './ControlFindingGroup';
import type { TranslateFn } from '../../../../hooks/useTranslation';

/**
 * What is IN this Solution, grouped by what it is FOR.
 *
 * `SECTIONS` (solutionSections.ts) lists the eight kinds a Solution holds as
 * flat sections, in the order server/projects/membership.js declares them.
 * This view is grouped over that SAME source — `SECTIONS` is imported, never
 * copied — and answers the builder's question: not "what is filed here" but
 * "who touches what".
 *
 * Three bands, and the wording is the point. "People use" is the surface a human
 * clicks; "Work happens" is what runs and who has to agree to it; "Knowledge &
 * data" is what the other two read from. Every kind lands in exactly one band,
 * and a kind that gains a section on the server with no band here renders in
 * "Knowledge & data" rather than disappearing — a missing row is the failure
 * this file must not have.
 *
 * ── Nothing on a row is invented ────────────────────────────────────────────
 *
 * Each cell is drawn only from something the payload actually says:
 *
 *   Depends on   edges the graph drew, resolved to nodes it also drew. An edge
 *                pointing at something outside the Solution is NOT a pill: it
 *                is a finding, and the Control tab is where findings live.
 *   Status       the worst finding the aggregator raised for that entity.
 *                No aggregator answer yet, or one that could not be built, and
 *                the column stays blank — a green tick nobody verified is the
 *                exact claim this product must never make.
 *   Sub-line     only facts the listing carries: whether an automation is live or
 *                still a draft, whether a page is public, and whether an automation
 *                is reachable through a public form (from the graph's form
 *                node, never from `automation_form_pages` — that row's id is
 *                the URL and the only credential guarding it).
 *
 * Two sub-lines the brief asks for are deliberately ABSENT rather than
 * approximated. "3 screens" would need the app DEFINITION, and `/resources`
 * carries meta only. "318 rows" would need a row count the store hands over as
 * `Number(row_count) || 0` — a table the retention sweep has never touched
 * reads as "0 rows", and printing that is a claim about somebody's data being
 * empty when the truth is that nobody counted.
 */

/** A node of the Solution's graph, as far as the table reads it. */
export interface GraphNode {
    id: string;
    type?: string;
    entityId?: string | null;
    name?: string;
    triggers?: unknown;
}

export interface GraphData {
    nodes?: GraphNode[] | null;
    edges?: Array<{ from?: string; to?: string | null } | null> | null;
}

/** The GET /resources payload: one list per section, null when a store could not be reached. */
export type ContentResources = Record<string, SolutionItem[] | null | undefined>;

/** A finding that names the thing it is about. */
export interface TargetedFinding extends ControlFinding {
    targetRef: { id?: string; kind: string };
}

export interface StatusCellProps {
    t: TranslateFn;
    finding?: ControlFinding;
}

export interface DependsOnProps {
    t: TranslateFn;
    targets: GraphNode[];
}

export interface RowProps {
    section: SolutionSection;
    item: SolutionItem;
    onOpen?(kind: string, item: SolutionItem): void;
    onRemove?: (kind: string, item: SolutionItem) => Promise<void>;
    deps: GraphNode[];
    finding?: ControlFinding;
    isFormTriggered: boolean;
    removable: boolean;
    t: TranslateFn;
}

/**
 * A Solution with no parts yet: what a Solution IS, in one placard instead of
 * three empty bands. The way in (the kind tiles) is the add panel below it, which
 * stays mounted while the first parts arrive, so a failure to add one is not
 * wiped by the screen switching over to the filled view.
 */
export interface EmptyIntroProps {
    canEdit: boolean;
    t: TranslateFn;
}

export interface SolutionContentTableProps {
    projectId: string;
    resources: ContentResources | null | undefined;
    graph: GraphData | null | undefined;
    completeness: { findings?: TargetedFinding[] } | null | undefined;
    onOpen?(kind: string, item: SolutionItem): void;
    loading: boolean;
    role: string;
    currentUserId: string | null;
    onRemove: ((kind: string, item: SolutionItem) => Promise<void>) | undefined;
    onAdded: () => void;
    readOnly?: boolean;
}

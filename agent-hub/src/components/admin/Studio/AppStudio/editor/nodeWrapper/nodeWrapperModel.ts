/**
 * The canvas cell's pure parts: span clamping, the pointerdown claim nested
 * cells share, the selection roots bulk actions work on, and the logic marks
 * and named pill a cell wears.
 */
import { CheckCircle2, Eye, Lock, Sigma, Workflow, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { kindColorVar } from '../../../../../shared/kindColors';
import type { AppDefinition, AppNode } from '../../inspector/appDefinition';
import { findNode as findNodeJs } from '../../state/definitionOps';
import type { LogicSummaryMark } from '../nodeLogicSummary';

/** What findNode answers: the node, its parent (node or section) and its section. */
interface FoundNode {
    node: AppNode;
    parent: { id: string; type?: string; children?: AppNode[] };
    section: { id: string };
    screen?: { id: string };
}
export const findNode = findNodeJs as unknown as (definition: AppDefinition | null, id: string) => FoundNode | null;

/** One mark of nodeLogicSummary: what kind of logic the component carries. */
export type LogicMark = LogicSummaryMark;

// Containers that stack their children with flex rather than on the 12-column
// grid. A child's `span` has no effect inside one, so offering the width grip
// there is a control that counts up and moves nothing.
export const SPAN_INERT_PARENTS = new Set(['pane', 'page_header']);

export function clampSpan(n: unknown): number {
    return Number.isFinite(n) ? Math.max(1, Math.min(12, Math.round(n as number))) : 12;
}

// Marker set on the NATIVE pointerdown by whichever cell (or cell toolbar)
// handled it first, so ancestor cells keep their hands off without cutting the
// event short — see EditorNodeWrapper's handlePointerDown.
const NODE_POINTERDOWN_CLAIM = '__aseNodePointerDown';

/** Claim a pointerdown for this cell; false when a descendant already had it. */
export function claimPointerDown(e: { nativeEvent: Event }): boolean {
    const native = e.nativeEvent as Event & { [NODE_POINTERDOWN_CLAIM]?: boolean };
    if (native[NODE_POINTERDOWN_CLAIM]) return false;
    native[NODE_POINTERDOWN_CLAIM] = true;
    return true;
}

/**
 * The selected ids that have no selected ANCESTOR. Acting on a node and on its
 * container both is acting on it twice: duplicating the container already
 * copies what is inside it.
 */
export function selectionRoots(definition: AppDefinition | null, ids: string[]): string[] {
    const set = new Set(ids);
    return ids.filter((id) => {
        let found = findNode(definition, id);
        while (found && found.parent && found.parent.id !== found.section.id) {
            if (set.has(found.parent.id)) return false;
            found = findNode(definition, found.parent.id);
        }
        return true;
    });
}

/**
 * One glyph per kind of logic a component can carry. Shape, not colour, is what
 * distinguishes them — the badges sit on top of whatever the app's own theme
 * paints underneath, and a colour-only code would be unreadable on half of it.
 */
export const LOGIC_MARK_ICONS: Record<string, LucideIcon> = {
    action: Zap,
    visibility: Eye,
    enablement: Lock,
    validation: CheckCircle2,
    computed: Sigma,
};

export interface LogicPillSpec {
    kind: string;
    color: string;
    Icon: LucideIcon;
    text: string;
}

/**
 * The NAMED pill beside the selected component (Studio artboard 1b: "⚙ start
 * automation · Offerte berekenen", r999, `padding 3px 8px`, 11px/600, the
 * trigger family's colour for an automation). One pill, for the FIRST action
 * mark — the question the canvas answers is "what happens when I use this",
 * and the icon strip in the corner still counts the rest.
 *
 * An automation wears --type-trigger (kindColors: automation) so the pill
 * reads as the same thing as the trigger card in the automation builder; any
 * other action wears the app kind's colour. Positioned OUTSIDE the cell on
 * its right (`left: calc(100% + 14px)`), which the relaxed `contain: layout`
 * of a selected cell allows.
 */
export function pillFor(mark: LogicMark | undefined, t: TranslateFn): LogicPillSpec | null {
    if (!mark || mark.kind !== 'action') return null;
    if (mark.actionKind === 'run_automation') {
        return {
            kind: 'run_automation',
            color: kindColorVar('automation'),
            Icon: Workflow,
            text: mark.actionTitle
                ? t('app_studio.canvas.start_automation_named', 'start automation · {name}', { name: mark.actionTitle })
                : t('app_studio.canvas.start_automation', 'start automation'),
        };
    }
    return { kind: mark.actionKind || 'action', color: kindColorVar('app'), Icon: Zap, text: mark.text };
}

/**
 * The small tile that says what kind of work a plan step is: done the same way every run, done by a model, waiting
 * for a person, or a result. One look for the plan card and for a plan that is still being drafted.
 */
import { Bell, Hand, Sparkles, Square } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { PlanStepKind } from '../../api/coworkPlan.types';

const KIND_ICON: Record<PlanStepKind, LucideIcon> = { fixed: Square, ai: Sparkles, ask: Hand, deliver: Bell };

/** Ink for fixed work, the AI blue for a model, the waiting amber for a person. */
const KIND_TILE: Record<PlanStepKind, string> = {
    fixed: 'bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-primary)]',
    ai: 'bg-[color-mix(in_srgb,var(--type-ai)_14%,transparent)] text-[var(--type-ai)]',
    ask: 'bg-[color-mix(in_srgb,var(--warning)_14%,transparent)] text-[var(--warning-ink)]',
    deliver: 'bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)] text-[var(--text-primary)]',
};

/** What each kind is called when there is no dictionary. */
export const KIND_FALLBACK: Record<PlanStepKind, string> = { fixed: 'Fixed', ai: 'AI', ask: 'Asks you', deliver: 'Result' };

export default function CoworkPlanKindTile({ kind }: { kind: PlanStepKind }) {
    const Icon = KIND_ICON[kind];
    return (
        <span className={`flex-shrink-0 w-6 h-6 rounded-md inline-flex items-center justify-center ${KIND_TILE[kind]}`}>
            <Icon aria-hidden="true" className="w-3.5 h-3.5" />
        </span>
    );
}

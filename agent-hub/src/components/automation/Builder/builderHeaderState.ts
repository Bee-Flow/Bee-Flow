import { triggerTypeLabel } from './flow/triggerLabels';
import type { FlowDefinition } from './flow/types';

/** The header's status word and its badge colours. */
export function headerStatus(isDraft: boolean, isActive: boolean) {
    const statusLabel = isDraft ? 'Draft' : (isActive ? 'Live' : 'Paused');
    const statusBadgeClass = isDraft
        ? 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]'
        : isActive
            ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            : 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    return { statusLabel, statusBadgeClass };
}

/**
 * The "Start from" choice in the header's run menu: every additional trigger
 * by name.
 */
export function secondaryTriggerOptions(def: FlowDefinition | null | undefined) {
    return (Array.isArray(def?.triggers) ? def.triggers : [])
        .filter(trigger => trigger && typeof trigger.id === 'string' && trigger.id)
        .map(trigger => ({ id: trigger.id, label: trigger.label || triggerTypeLabel(trigger), kind: trigger.kind || 'manual' }));
}

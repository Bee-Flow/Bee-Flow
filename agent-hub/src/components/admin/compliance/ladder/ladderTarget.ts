/**
 * The ladder's hook loads by `target.id`. The Frameworks page's per-automation rows hand over
 * only the id (and title); a bare string left `target.id` undefined, so the modal never loaded
 * and showed "0 steps · Contains AI: no" for a routine full of AI steps.
 */
export interface LadderTarget { id: string; title?: string; [key: string]: unknown }

export function ladderTarget(target: unknown, title?: string | null): LadderTarget | null {
    if (target && typeof target === 'object') return target as LadderTarget;
    if (target == null || target === '') return null;
    return { id: String(target), ...(title ? { title } : {}) };
}

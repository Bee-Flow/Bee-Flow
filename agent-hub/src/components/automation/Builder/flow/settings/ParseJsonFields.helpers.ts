import type { ParseField } from './ParseJsonFields.types';

/**
 * An updater for the step's `fields` that appends `added` to the list as it is
 * when the updater runs, minus the names taken meanwhile. For rows that arrive
 * late (the AI mapping takes seconds): writing back the list from before the
 * question would erase every row typed or added while it was out.
 */
export function appendFields(added: ParseField[]) {
    return (current: unknown): ParseField[] => {
        const now: ParseField[] = Array.isArray(current) ? current : [];
        const have = new Set(now.map(f => f?.name).filter(Boolean));
        return [...now, ...added.filter(f => !have.has(f.name))];
    };
}

import { groupKindOf, membersOf } from './FilterTreeGroup';
import type { FilterEntry, FilterGroupKind, FilterRow } from './FilterRowsEditor.types';

type Descriptor = Record<string, unknown>;

/** A group of `kind` over already built entries, in the shape the server reads. */
function regroup(kind: FilterGroupKind, members: Descriptor[]): Descriptor {
    if (kind === 'none') return { not: members.length === 1 ? members[0] : { any: members } };
    return { [kind]: members };
}

/**
 * A filter list as a saved descriptor carries it: each finished row built by
 * `leaf`, unfinished rows left out, a group kept with what is left of it and a
 * group left empty dropped with them.
 */
export function descriptorFilters(entries: FilterEntry[], leaf: (f: FilterRow) => Descriptor): Descriptor[] {
    const out: Descriptor[] = [];
    for (const entry of entries) {
        const kind = groupKindOf(entry);
        if (kind === null) {
            const row = entry as FilterRow;
            if (row.field && row.op && row.otherField !== '') out.push(leaf(row));
            continue;
        }
        const members = descriptorFilters(membersOf(entry, kind), leaf);
        if (members.length) out.push(regroup(kind, members));
    }
    return out;
}

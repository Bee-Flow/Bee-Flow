/**
 * What the Versions and Installs tabs make of their answers — a port of the
 * web's admin/Studio/Solutions/releaseModel.js (groupNoteRows) and
 * installsBadge (SolutionInstallsTab.jsx), held to them by
 * releases.lockstep.test.ts.
 *
 * The one mistake these two tabs must not make: "there is nothing" and "we
 * could not read it" both look like an empty list. An empty version list
 * reads as "never published"; an install counter that becomes 0 reads as
 * "nobody uses this" — the answer on which someone deletes a Solution. The
 * readers keep `null` for unread; this file never turns it into a zero.
 */

import type { InstallCounts, NoteRow, Release } from './package';

export interface NoteGroups {
    added: NoteRow[];
    changed: NoteRow[];
    unchanged: NoteRow[];
    /** Rows with a `change` this screen does not know: counted, never filed under "unchanged". */
    unreadable: number;
}

export function groupNoteRows(rows: readonly NoteRow[]): NoteGroups {
    const groups: NoteGroups = { added: [], changed: [], unchanged: [], unreadable: 0 };
    for (const row of rows) {
        if (row.change === 'added') groups.added.push(row);
        else if (row.change === 'changed') groups.changed.push(row);
        else if (row.change === 'unchanged') groups.unchanged.push(row);
        else groups.unreadable += 1;
    }
    return groups;
}

/** How many things a version changed or added; null when no diff was recorded for it. */
export function changesIn(release: Release): number | null {
    const entities = release.notes.entities;
    if (entities === null) return null;
    const groups = groupNoteRows(entities);
    return groups.changed.length + groups.added.length;
}

/**
 * The Installs tab's count. None at 0 and none when either half is unknown: a
 * tab strip has no room for "at least, and only on this instance", and a
 * "0" there would read as "nobody uses this" when the counter cannot see
 * another instance at all. A number above 0 survives, being a lower bound.
 */
export function installsBadge(counts: InstallCounts | null | undefined): number | null {
    if (!counts || counts.here === null || counts.elsewhere === null) return null;
    const total = counts.here + counts.elsewhere;
    return total > 0 ? total : null;
}

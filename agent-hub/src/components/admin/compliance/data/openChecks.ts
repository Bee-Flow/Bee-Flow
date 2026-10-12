/**
 * openChecks — how many checks of a regulation still need work.
 *
 * One rule for the phone's framework rows (MobileHomeOverview) and the rail's
 * "Needs attention" filter (ComplianceRail): a check row counts when it fails
 * or warns, under its own regulation or under any framework its evidence also
 * counts for (`frameworks: [{ regulation }]`). A per-source check counts once
 * per scope, the same way the attention list lists it.
 */

export interface CheckLike {
    status?: string | null;
    regulation?: string | null;
    frameworks?: ReadonlyArray<{ regulation?: string | null } | null> | null;
}

/** Open (fail/warn) check rows of a regulation; undefined while the checks have not loaded. */
export function openChecksFor(checks: ReadonlyArray<CheckLike | null> | null | undefined, regulation: string | null | undefined): number | undefined {
    if (!Array.isArray(checks) || !regulation) return undefined;
    return checks.filter((c) => {
        if (c?.status !== 'fail' && c?.status !== 'warn') return false;
        if (c.regulation === regulation) return true;
        const frameworks: CheckLike['frameworks'] = c.frameworks;
        return Array.isArray(frameworks) && frameworks.some((f: { regulation?: string | null } | null) => f?.regulation === regulation);
    }).length;
}

/**
 * Blueprint shapes: the gallery (server/stores/blueprintStore.js mapRow,
 * meta only), the release history and install counts
 * (routes/projects/packaging.js), and what an install or an upgrade reports.
 *
 * None of these carry a manifest. The gallery is meta by design on the server
 * (manifests are multi-megabyte JSONB), and the phone keeps it that way: a
 * manifest is only ever fetched to be handed on as a file (export), never to
 * be held in a query cache.
 */

export interface BlueprintMeta {
    id: string;
    name: string;
    description: string;
    icon: string | null;
    version: number;
    /** `sol_<projectId>` of the Solution it was published from. */
    solutionKey: string;
    createdBy: string;
    sourceProjectId: string | null;
    updatedAt: string | null;
}

/** One entity line of a release note (projects/packaging/releaseNotes.js). */
export interface NoteRow {
    kind: string;
    ref: string;
    name: string;
    /** added | changed | unchanged — anything else is counted as unplaceable. */
    change: string;
    text: string | null;
    /** Changed, but no one-line summary could be written: NOT "unchanged". */
    summaryMissing: boolean;
}

/** `entities: null` = no diff was recorded for this version — NOT "nothing changed". */
export interface ReleaseNotes {
    entities: NoteRow[] | null;
    omitted: number;
    textsDropped: boolean;
}

export interface Release {
    id: string;
    version: number | null;
    publishedAt: string | null;
    notes: ReleaseNotes;
}

/** Installs on this instance; each half independently unknown (null), never 0 for unknown. */
export interface InstallCounts {
    here: number | null;
    elsewhere: number | null;
}

export interface PlanRow {
    ref: string;
    kind: string;
    name: string;
}

/** The four server lists as five named groups — see upgrade.ts planRows. */
export interface PlanRows {
    added: PlanRow[];
    changed: PlanRow[];
    kept: PlanRow[];
    undetermined: PlanRow[];
    gone: PlanRow[];
}

export interface UpgradePlan {
    rows: PlanRows;
    toVersion: number | null;
}

export interface UpgradeReport {
    replaced: number;
    added: number;
    failed: { ref: string; why: string }[];
    warnings: string[];
}

export interface InstallReport {
    projectId: string;
    /** How many entities were created, over every kind. */
    installed: number;
    skipped: { ref: string; kind: string; why: string }[];
    warnings: string[];
}

export interface PublishResult {
    blueprintId: string | null;
    version: number | null;
    /** The capture worked but keeping it on the instance did not. */
    saveError: string | null;
}

import type React from 'react';

/**
  * Is this Blueprint newer than what is installed?
  *
  * Literally the rule of `isNewer` in server/projects/packaging/upgrade.js:
  * equal versions are NOT an upgrade. Repeated here because the banner has to be
  * able to ask before the first request; `updateAvailability` guards the trap
  * the server version leaves open: `installedVersion || 0` turns "we do not
  * know what is installed" into a 0, and then every v1 is suddenly newer.
 */
export interface IsNewerArgs {
    installedVersion: number;
    blueprintVersion: number;
}

/**
  * May this reader promise anything about a newer version at all?
  *
  * THE SCOPE IS CHECKED HERE, BEFORE THE BANNER SAYS ANYTHING. The Blueprint is
  * looked up in `blueprints`, the list from GET /package/blueprints, which is
  * `listBlueprintsFor`, so already org-scoped by the server. If the id is not in
  * it (deleted, or from another organisation), the answer is `unknown` and
  * NEVER `available`: a banner that promises an update for a Blueprint you may
  * not see reveals that it exists.
  *
  * `blueprintId` only travels along when the Blueprint WAS found. That way no
  * caller can request a plan for an id that did not pass the scope
  * here.
  *
  * Four states:
  *   none       not installed from a Blueprint: there is no question.
  *   unknown    it was, but cannot be answered. NOT "up to date".
  *   available  there is a newer one, and `latestVersion` names it.
  *   current    compared, and there is nothing new.
 */
export interface UpdateAvailabilityArgs {
    installedFromBlueprintId?: string | null;
    installedVersion?: number | null;
    blueprints?: { id: string; version: number; solutionKey?: string; createdBy?: string; }[] | null;
}

/** Ref → readable name, from the manifest the plan sent along. */
export interface PlanItem { ref: string; kind: string; entityId?: string; why?: string }

/** A manifest as far as the plan reads it: only the names of its entities. */
export interface PlanManifest {
    solution?: { entities?: Record<string, unknown> | null } | null;
}

/** One row of the plan, with the name beside it and nothing else from the row. */
export interface PlanRow { ref: string; kind: string; name: string }

/** The plan's five named groups. */
export interface PlanRows {
    added: PlanRow[];
    changed: PlanRow[];
    kept: PlanRow[];
    undetermined: PlanRow[];
    gone: PlanRow[];
}

/** What the plan route answers with. */
export interface UpgradeBody {
    ok?: boolean;
    error?: string;
    toVersion?: number | null;
    manifest?: PlanManifest | null;
    plan?: { add?: PlanItem[]; replace?: PlanItem[]; skip?: PlanItem[]; missing?: PlanItem[] } | null;
    report?: UpgradeReport | null;
}

/** The upgrade report as the server sends it. */
export interface UpgradeReport {
    added?: Record<string, unknown> | null;
    replaced?: unknown[];
    failed?: Array<{ ref?: unknown; why?: unknown }>;
    warnings?: string[];
}

/** The report, boiled down to what the dialog prints. */
export interface ReadReport {
    replaced: number;
    added: number;
    failed: Array<{ ref: string; why: string }>;
    warnings: string[];
}

export type PlanOutcome = { status: 'error'; error: string | null } | { status: 'ok'; rows: PlanRows; toVersion: number | null };

export type UpgradeOutcome = { status: 'error'; error: string | null } | { status: 'ok'; report: ReadReport; toVersion: number | null };

/**
  * Request the plan. EXCLUSIVELY with `blueprintId`: see the header for why the
  * manifest must not go in here.
 */
export interface FetchUpgradePlanArgs {
    projectId: string;
    blueprintId: string | null | undefined;
}

/** Execute it. Here too only the id: the server plans again itself. */
export interface RunUpgradeArgs {
    projectId: string;
    blueprintId: string | null | undefined;
}

/**
  * "There is a newer version" — and the honest silence around it.
  *
  * `current` and `none` show NOTHING: that is the calm state, and the version
  * chip in the header already says which version it is. `unknown` DOES show a
  * line, because without that line the absence of the banner would mean both
  * "up to date" and "we could not check", and that second answer is exactly what
  * this product does not round off. `unknown` offers no button: there is nothing
  * to update when we do not know whether it is there.
 */
export interface UpdateBannerProps {
    availability: { state: string; blueprintId?: string | null; installedVersion?: number | null; latestVersion?: number | null };
    onOpen: (() => void) | undefined;
}

/** One named group of the plan. Empty = nothing, no empty heading. */
export interface PlanGroupProps {
    rows: { ref: string; kind: string; name: string }[];
    title: string;
    note?: string;
    testId: string;
}

/** What is in the dialog: the plan, or the reason there is no plan. */
export interface PlanState {
    status: string;
    rows?: PlanRows;
}

export interface DialogBodyProps {
    plan: PlanState;
    result: UpgradeOutcome | null;
    ready: boolean;
    empty: boolean;
}

/**
  * The footer. Confirming is possible ONLY when a plan has been read that
  * actually changes something; in every other state there is only a way out.
 */
export interface DialogFooterProps {
    done: boolean;
    canConfirm: boolean;
    applying: boolean;
    onClose: React.MouseEventHandler<HTMLButtonElement>;
    onConfirm: () => Promise<void>;
}

/**
  * The plan, and only then the button.
  *
  * The confirmation is ONLY reachable from a plan that has been read. A failed
  * plan offers no "continue anyway": nothing is known about what would
  * happen, and that is the one state in which this action should not be
  * offered.
 */
export interface UpgradeDialogProps {
    open: boolean;
    onClose: () => void;
    projectId: string;
    blueprintId?: string | null;
    latestVersion?: number | null;
    onDone: () => void;
}

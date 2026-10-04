/**
 * Where an automation stands between its working copy and its live version
 * (handoff 5, "live split"): autosave on an active automation is NOT live until
 * "Make vN live". Pure: the header's words and its primary action both come
 * from this, and the tests pin it without rendering anything.
 */

type LiveKind = 'never' | 'live' | 'paused';
type PrimaryAction = 'activate' | 'publish' | null;

/**
 * An automation managed by a Solution stage is read-only (design 9): Publish and
 * Save are gone, On/Off and Run stay. It is a FLAG on the state, not a fourth
 * kind, so the status pill keeps saying Live / Paused / never live, which is
 * still true of a managed automation.
 */

export interface LiveState {
    kind: LiveKind;
    /** The version runs execute; null while never live. */
    liveVersion: number | null;
    /** The working copy's version, the "vN" in "Make vN live". */
    workingVersion: number | null;
    /** Structural changes saved since the live version (0 when never live). */
    pendingChanges: number;
    /** The one filled button; null when the only action is Pause. */
    primary: PrimaryAction;
    /** Pause shows as the quiet secondary while the automation is switched on. */
    canPause: boolean;
    /** Managed by a Solution stage: no Publish, no Save; On/Off and Run stay. */
    managed: boolean;
    /**
     * Managed and never deployed: there is no live copy to switch on, so
     * Activate is offered disabled with the reason instead of failing on click.
     */
    notDeployed: boolean;
}

/** The row fields this reads; camelCase as the API sends them. */
export interface LiveRow {
    isActive?: boolean | null;
    isDraft?: boolean | null;
    version?: number | null;
    liveVersion?: number | null;
    neverLive?: boolean | null;
    pendingChanges?: number | null;
    /** `managed` as a part GET carries it (managedPart.managedOf); any non-null value means managed. */
    managed?: unknown;
}

function count(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * `countsPending` is GET /:id/counts' figure, used when the row did not carry
 * one (a PUT answer omits it rather than guess 0).
 */
export function liveStateOf(row: LiveRow | null | undefined, countsPending: number | null = null): LiveState {
    const r = row || {};
    const liveVersion = count(r.liveVersion);
    // An older server sends no live columns: fall back to isDraft, the
    // pre-split meaning of "never went live".
    const neverLive = typeof r.neverLive === 'boolean'
        ? r.neverLive
        : (r.liveVersion === undefined ? !!r.isDraft : liveVersion == null);
    const workingVersion = count(r.version);
    const rowPending = count(r.pendingChanges);
    const managed = r.managed != null && r.managed !== false;
    // A managed working copy is what the stage deployed: nothing is "ahead".
    const pendingChanges = neverLive || managed ? 0 : (rowPending ?? countsPending ?? 0);

    if (neverLive) {
        return {
            kind: 'never', liveVersion: null, workingVersion, pendingChanges: 0, primary: 'activate', canPause: false,
            managed, notDeployed: managed,
        };
    }
    if (!r.isActive) {
        return { kind: 'paused', liveVersion, workingVersion, pendingChanges, primary: 'activate', canPause: false, managed, notDeployed: false };
    }
    return {
        kind: 'live',
        liveVersion,
        workingVersion,
        pendingChanges,
        primary: pendingChanges > 0 ? 'publish' : null,
        canPause: true,
        managed,
        notDeployed: false,
    };
}

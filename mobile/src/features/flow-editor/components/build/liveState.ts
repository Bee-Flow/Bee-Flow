/**
 * Where a routine stands between its working copy and its live version
 * (handoff 5, the live split): on a routine that has gone live, a save only
 * changes the working copy, and runs keep executing the live version until
 * "Make vN live" (POST /:id/publish).
 *
 * `liveStateOf` is a port of agent-hub `Builder/header/liveState.ts`, run
 * beside the original by liveState.lockstep.test.ts. The rest is the phone's
 * reading of it: whether the server knows the split at all, and the words the
 * web's LiveStatusPill puts beside the pill.
 */

import type { Translate } from '@/features/flow-editor/model';

type LiveKind = 'never' | 'live' | 'paused';
type PrimaryAction = 'activate' | 'publish' | null;

export interface LiveState {
    kind: LiveKind;
    /** The version runs execute; null while never live. */
    liveVersion: number | null;
    /** The working copy's version, the "vN" in "Make vN live". */
    workingVersion: number | null;
    /** Structural changes saved since the live version (0 when never live). */
    pendingChanges: number;
    /** The web's one filled button; null when the only action is Pause. */
    primary: PrimaryAction;
    /** Pause shows as the quiet secondary while the routine is switched on. */
    canPause: boolean;
}

/** The row fields this reads; camelCase as the API sends them. */
export interface LiveRow {
    isActive?: boolean | null;
    isDraft?: boolean | null;
    version?: number | null;
    liveVersion?: number | null;
    neverLive?: boolean | null;
    pendingChanges?: number | null;
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
    const pendingChanges = neverLive ? 0 : (rowPending ?? countsPending ?? 0);

    if (neverLive) {
        return { kind: 'never', liveVersion: null, workingVersion, pendingChanges: 0, primary: 'activate', canPause: false };
    }
    if (!r.isActive) {
        return { kind: 'paused', liveVersion, workingVersion, pendingChanges, primary: 'activate', canPause: false };
    }
    return {
        kind: 'live',
        liveVersion,
        workingVersion,
        pendingChanges,
        primary: pendingChanges > 0 ? 'publish' : null,
        canPause: true,
    };
}

/**
 * True when the server sends the live columns, `liveVersion: null` included.
 * An older server sends none: the editor then shows what it always did and
 * offers no Make live.
 */
export function hasLiveSplit(row: LiveRow | null | undefined): boolean {
    return !!row && row.liveVersion !== undefined;
}

/**
 * "editing v5 · 2 changes not live yet", or null when the working copy is not
 * ahead of the live version. The web's LiveStatusPill words.
 */
export function pendingText(live: LiveState, t: Translate): string | null {
    if (live.kind === 'never' || live.pendingChanges <= 0) return null;
    const version = live.workingVersion ?? '';
    return live.pendingChanges === 1
        ? t('routines.header.editing_pending_one', 'editing v{version} · 1 change not live yet', { version })
        : t('routines.header.editing_pending_other', 'editing v{version} · {n} changes not live yet', { version, n: live.pendingChanges });
}

/** "Live · v3" for a routine switched on with a known live version, else null (the caller's own word). */
export function liveVersionWord(live: LiveState | null, t: Translate): string | null {
    if (live?.kind !== 'live' || live.liveVersion == null) return null;
    return t('routines.header.status_live_version', 'Live · v{version}', { version: live.liveVersion });
}

import { useEffect, useState } from 'react';
import { useMaintenanceQuery } from '../api/queries/maintenanceRead';
import useAdjustOnChange from './useAdjustOnChange';

/**
 * Watches for an announced deployment window so the app can warn people before
 * the server drops from under them.
 *
 * ── Why an ETA alone is not enough ─────────────────────────────────────────
 *
 * The ETA the deploy pipeline sends is a guess about how long a rollout takes.
 * Counting it down and then declaring "we're back" would be a lie roughly half
 * the time. So this tracks two independent things:
 *
 *   - the announced window (when it should end), and
 *   - `appVersion` (APP_BUILD_SHA), which is ground truth: when the value we
 *     get back differs from the one we first booted against, a NEW build is
 *     genuinely serving this client.
 *
 * A version change flips straight to 'recovered' whether or not the ETA has
 * elapsed. The countdown is only ever cosmetic.
 */

// Poll gently when nothing is happening; tighten once a window is open so the
// "you can continue" flip lands promptly rather than up to a minute late.
const IDLE_POLL_MS = 60_000;
const ACTIVE_POLL_MS = 5_000;

/**
 * 'idle'       — nothing announced
 * 'pending'    — window in force, ETA has not run out
 * 'overdue'    — ETA elapsed, server has not come back on a new build
 * 'recovered'  — a new build is serving us; this tab still runs the OLD
 *                bundle, so the phase is a PERSISTENT reload prompt. It never
 *                times out: reloading is the only exit, because it is the only
 *                thing that actually fetches the new frontend.
 */
export type MaintenancePhase = 'idle' | 'pending' | 'overdue' | 'recovered';

/** The announced window, as GET /api/maintenance reports it. */
export interface MaintenanceWindow {
    endsAt: string;
    [key: string]: unknown;
}

type EtaUnit = 'moment' | 'seconds' | 'minute' | 'minutes';

export interface CoarseEta {
    unit: EtaUnit;
    value: number;
}

export interface MaintenanceState {
    phase: MaintenancePhase;
    secondsRemaining: number;
    window: MaintenanceWindow | null;
    versionChanged: boolean;
}

/** Whole seconds until `endsAt`, floored at 0. Exported for tests. */
export function secondsUntil(endsAt: string, now: number = Date.now()): number {
    const t = Date.parse(endsAt);
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, Math.round((t - now) / 1000));
}

/**
 * Coarse ETA descriptor — the rounding without the wording, so the banner can
 * run the same numbers through t() while this module stays free of any i18n
 * dependency. Deliberately coarse: "about 2 minutes" is honest about a guess
 * in a way that a ticking "1:47" is not.
 */
export function coarseEta(seconds: number): CoarseEta {
    if (!Number.isFinite(seconds) || seconds <= 0) return { unit: 'moment', value: 0 };
    // Up to 55: from there the nearest ten is 60, and "about 60 seconds" is a minute.
    if (seconds < 55) return { unit: 'seconds', value: Math.max(10, Math.round(seconds / 10) * 10) };
    const mins = Math.round(seconds / 60);
    return mins === 1 ? { unit: 'minute', value: 1 } : { unit: 'minutes', value: mins };
}

/** English rendering of coarseEta — kept for non-translating callers and tests. */
export function formatEta(seconds: number): string {
    const { unit, value } = coarseEta(seconds);
    switch (unit) {
        case 'seconds': return `about ${value} seconds`;
        case 'minute': return 'about a minute';
        case 'minutes': return `about ${value} minutes`;
        default: return 'any moment now';
    }
}

/**
 * Resolve the display phase. Pure, so the state machine is testable without
 * timers or a network.
 */
export function derivePhase(
    { window, versionChanged, secondsRemaining }: {
        window: MaintenanceWindow | null;
        versionChanged: boolean;
        secondsRemaining: number;
    },
): MaintenancePhase {
    if (versionChanged) return 'recovered';
    if (!window) return 'idle';
    return secondsRemaining > 0 ? 'pending' : 'overdue';
}

export function useMaintenanceWindow({ enabled = true }: { enabled?: boolean } = {}): MaintenanceState {
    // Poll loop. The interval tightens while a window is open — that is when the
    // "you can continue" flip must land promptly. Once recovered there is
    // nothing left to detect (the prompt persists until reload), so a stale
    // tab relaxes back to the idle cadence. A failed poll during a rollout is
    // expected (the pod serving us is being replaced): the last answer stays,
    // so the banner stays up across the outage.
    const query = useMaintenanceQuery<MaintenanceWindow>({ enabled, idleMs: IDLE_POLL_MS, activeMs: ACTIVE_POLL_MS });
    const window_ = query.data?.maintenance || null;
    const [secondsRemaining, setSecondsRemaining] = useState(0);
    const [versionChanged, setVersionChanged] = useState(false);

    // The build this client booted against. Captured on the FIRST successful
    // response rather than at module load, because we cannot know it until the
    // server tells us. Never overwritten — that is the whole comparison.
    //
    // Why not compare against this bundle's own stamp (utils/appVersion)? CI
    // builds each image when its service changes, so a healthy prod routinely
    // serves an agent-hub bundle built from an older commit than the server —
    // a direct FE-vs-server equality would show a permanent false "reload".
    // "The server moved DURING my session" is the comparison that is always
    // true to act on. (Its blind spot — an agent-hub-only roll changes no
    // server sha — is why a deploy should roll ALL services by default.)
    const [baselineVersion, setBaselineVersion] = useState<string | null>(null);

    useAdjustOnChange([query.dataUpdatedAt], () => {
        if (!query.data) return;
        const version = query.data.appVersion || '';
        if (version) {
            if (baselineVersion === null) setBaselineVersion(version);
            else if (version !== baselineVersion) setVersionChanged(true);
        }
        setSecondsRemaining(window_ ? secondsUntil(window_.endsAt) : 0);
    });

    // Local countdown so the number moves between polls.
    useEffect(() => {
        if (!window_) return undefined;
        const id = setInterval(() => setSecondsRemaining(secondsUntil(window_.endsAt)), 1000);
        return () => clearInterval(id);
    }, [window_]);

    // `versionChanged` deliberately has NO expiry. It used to retire after 20s
    // and re-baseline, which meant anyone who missed the note silently kept
    // running the old bundle against the new server. But the condition it
    // reports — this tab's code predates the server's — stays true until the
    // page reloads, so the prompt must too. The reload itself resets all of
    // this state by construction.

    return {
        phase: derivePhase({ window: window_, versionChanged, secondsRemaining }),
        secondsRemaining,
        window: window_,
        versionChanged,
    };
}


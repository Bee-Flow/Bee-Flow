/**
 * The one place that decides what state a cowork item is in.
 *
 * There used to be two: the list card read `lastStatus` almost directly, the
 * Studio detail pane derived a richer answer, and the same item could show
 * "Idle" in one and "Finished" in the other. Everything now calls this.
 *
 * The subtlety it exists for: `isActive === false` means very little on its
 * own. A one-off started with "Run now" is deactivated server-side *before* it
 * fires, so an inactive, never-run row is usually mid-flight — reading it as
 * idle tells the user nothing is happening seconds after they pressed Run.
 *
 * The distinction between "running now" and "deliberately switched off" has
 * always been made here — and until the token table split them it was thrown
 * away one line later, because `running` and `paused` carried the identical
 * amber. Both branches below now end in a different colour (CW-04).
 */
import { tokenFor } from '../shared/statusTokens';

/**
 * `needs_reauth` is a cowork status the shared token table does not carry.
 *
 * The server writes it in two places — `routineAuth` switches a schedule off
 * with `last_status = 'needs_reauth'`, and `markError` records it on the run
 * row — and both mean the same thing: this unattended work has STOPPED and
 * only the owner can start it again, by signing back in to the account it
 * needs. Left to `tokenFor` it fell through to the neutral `idle` row, so a
 * run that died on an expired token got the grey dot and the word "Idle", and
 * the schedule beside it read "Paused" — indistinguishable from "I switched
 * that off myself". The one screen whose job is to show that unattended work
 * has stopped was the screen saying nothing had.
 *
 * Extended here rather than in `shared/statusTokens.ts` because the word is
 * cowork's alone today; the tone is `error`'s, because the server counts these
 * runs as failures in /stats and the two must not disagree. If a second
 * surface ever needs it, this belongs in that table as a real `needs_reauth`
 * row with a `run_status.*` key — see the note at the top of that file.
 */
const NEEDS_REAUTH_TOKEN = {
    ...tokenFor('error'),
    labelKey: 'cowork.status.needs_reauth',
    labelEn: 'Needs sign-in',
};

/**
 * The token for ONE run row's status — the same lookup as `tokenFor`, plus
 * cowork's own `needs_reauth`.
 */
export function runStatusToken(status) {
    return status === 'needs_reauth' ? NEEDS_REAUTH_TOKEN : tokenFor(status);
}

/** True while an item is running or has not produced its first run yet. */
export function isInFlight(item) {
    return item.lastStatus === 'running' || (!item.lastRunAt && !item.runCount);
}

export function coworkStatus(item) {
    if (item.lastStatus === 'running') return tokenFor('running');
    // A schedule switched off because an account needs signing in again is not
    // a schedule the user paused, and must not read like one.
    if (item.lastStatus === 'needs_reauth') return NEEDS_REAUTH_TOKEN;
    if (!item.lastRunAt && !item.runCount) return tokenFor(item.isActive ? 'queued' : 'idle');
    if (!item.isActive && item.lastStatus === 'success') return tokenFor('success');
    if (!item.isActive) return tokenFor(item.lastStatus === 'error' ? 'error' : 'paused');
    return tokenFor(item.lastStatus);
}

/**
 * The limits of the Teams setup and diagnostics endpoints and of option B
 * (organisation-wide import), each an environment variable with a generous
 * default. Read at call time, so a test (or an operator restarting with a new
 * value) needs no module reload.
 *
 *   TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS  10     seconds between two diagnostics runs per user
 *   TEAMS_DIAGNOSTICS_PROBE_TIMEOUT_MS      15000  per Graph or Entra probe
 *   TEAMS_DIAGNOSTICS_MAX_MEMBERS           2000   rows in the members overview
 *   TEAMS_APP_IMPORT_MAX_SELECTED_USERS     5000   selected members for option B
 *   TEAMS_APP_IMPORT                        '1'    '0' switches option B off for the instance
 *
 * For the numbers: unset or empty is the default, a finite number >= 0 is
 * floored, anything else is the default, and 0 means unlimited (no timeout).
 */

/** Same rule as core/meetingNotes/manualImportRunner.js. */
export function limitFromEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const DEFAULT_MIN_INTERVAL_SECONDS = 10;
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_MEMBERS = 2000;
export const DEFAULT_MAX_SELECTED_USERS = 5000;

/** Seconds between two diagnostics runs of one user; 0 = no limit. */
export function minIntervalSeconds(): number {
    return limitFromEnv('TEAMS_DIAGNOSTICS_MIN_INTERVAL_SECONDS', DEFAULT_MIN_INTERVAL_SECONDS);
}

/** Milliseconds one Graph or Entra probe may take; 0 = no timeout. */
export function probeTimeoutMs(): number {
    return limitFromEnv('TEAMS_DIAGNOSTICS_PROBE_TIMEOUT_MS', DEFAULT_PROBE_TIMEOUT_MS);
}

/** Rows the members overview lists; 0 = every member. */
export function maxMembers(): number {
    return limitFromEnv('TEAMS_DIAGNOSTICS_MAX_MEMBERS', DEFAULT_MAX_MEMBERS);
}

/** Members option B may select; 0 = unlimited. */
export function maxSelectedUsers(): number {
    return limitFromEnv('TEAMS_APP_IMPORT_MAX_SELECTED_USERS', DEFAULT_MAX_SELECTED_USERS);
}

/** Option B is on for the instance unless TEAMS_APP_IMPORT is exactly '0'. */
export function appImportAllowed(): boolean {
    return process.env.TEAMS_APP_IMPORT !== '0';
}

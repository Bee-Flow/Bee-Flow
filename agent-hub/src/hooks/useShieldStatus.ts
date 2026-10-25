import {
    SHIELD_STATUS_POLL_MS,
    SHIELD_STATUS_TTL_MS,
    parseShieldStatus,
    shieldErrorCode,
    shieldStatusKeys,
    useShieldStatusQuery,
    type ShieldAction,
    type ShieldError,
    type ShieldFailMode,
    type ShieldSource,
    type ShieldStatus,
} from '../api/queries/shieldStatus';
import { queryClient } from '../api/queryClient';

/**
 * useShieldStatus — the caller's effective Privacy Shield status, for every
 * privacy claim the UI makes: the chat header pill, the composer line, the
 * footer, the Cowork pill.
 *
 * ONE request, `GET /api/privacy/shield-status` (routes/privacyShieldStatus.js
 * documents each field), shared by every mounted instance through the app's
 * React Query cache: concurrent loads collapse into one in-flight request and
 * the last answer serves the other consumers, so the three chat consumers
 * never poll three times. The wire contract — the allow-list parser, the error
 * codes, the 30 s poll — lives in `api/queries/shieldStatus`.
 *
 * The hook delivers DATA only — never a text. A failed fetch yields
 * `data: null` even when an earlier read succeeded: when the status is
 * unknown, nothing may be claimed, and a stale green lock is worse than none.
 * `error` is a code, not a sentence; the consumer decides whether to say
 * anything at all.
 *
 * THE ONE RULE for all claims lives in code, in deriveShieldClaims(), rather
 * than once per consumer: a shield that is "on" while the detector cannot
 * scan is NOT active. A green lock that stays green while the guard is
 * unreachable is worse than no lock, and only a masking action may be worded
 * as "replaced".
 */
export { SHIELD_STATUS_POLL_MS, SHIELD_STATUS_TTL_MS, parseShieldStatus };
export type { ShieldAction, ShieldError, ShieldFailMode, ShieldSource, ShieldStatus };

export interface ShieldClaims {
    shieldActive: boolean;
    replacesPersonalData: boolean;
    coworkShieldActive: boolean;
}

export interface ShieldStatusState {
    data: ShieldStatus | null;
    loading: boolean;
    error: ShieldError | null;
}

const IDLE: ShieldStatusState = Object.freeze({ data: null, loading: false, error: null });
const NO_CLAIMS: ShieldClaims = Object.freeze({ shieldActive: false, replacesPersonalData: false, coworkShieldActive: false });

/**
 * The one rule. `shieldActive` is what the header pill may claim,
 * `replacesPersonalData` what the composer line may claim, and
 * `coworkShieldActive` what the Cowork card may claim. Unknown status (null)
 * claims nothing.
 */
export function deriveShieldClaims(data: ShieldStatus | null | undefined): ShieldClaims {
    if (!data) return NO_CLAIMS;
    const shieldActive = data.enabled === true && data.guardReachable === true;
    return {
        shieldActive,
        replacesPersonalData: shieldActive && data.action === 'redact',
        coworkShieldActive: data.coworkEnabled === true && data.guardReachable === true,
    };
}

/** Drop the cached answer — for a settings screen that just saved the shield. */
export function invalidateShieldStatus(): void {
    // remove, not reset or invalidate: logout calls this while the old
    // user's screens are still mounted and their session token still set,
    // and either of those would refetch for the old user on the way out.
    queryClient.removeQueries({ queryKey: shieldStatusKeys.all });
}

export function useShieldStatus({ enabled = true }: { enabled?: boolean } = {}): ShieldStatusState {
    const query = useShieldStatusQuery({ enabled });

    // Derived, not reset in the effect: a disabled hook reports nothing and
    // claims nothing; re-enabling fetches again immediately.
    if (!enabled) return IDLE;
    // React Query keeps the last good payload beside an error. This hook must
    // not: an outage that follows a green answer has to read as unknown.
    if (query.error) return { data: null, loading: false, error: shieldErrorCode(query.error) };
    return { data: query.data ?? null, loading: query.isPending, error: null };
}

export default useShieldStatus;

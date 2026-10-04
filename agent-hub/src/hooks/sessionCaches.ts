import { invalidateIntegrationStatus } from './useIntegrationStatus';
import { invalidateShieldStatus } from './useShieldStatus';
import { invalidateSkills } from './useSkills';
import { invalidateTrainingGates } from './useTrainingGates';
import { clearAppRefCache } from '../components/automation/Builder/flow/appRefLabel';
import { invalidateAllowedModelsCache } from '../utils/modelMeta';

/**
 * Every MODULE-LEVEL cache that belongs to one signed-in account, dropped in
 * one call.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────
 * Logout already dropped the two caches people think of: `scopedStorage`
 * (per-user preferences) and the React Query cache (whose keys are not
 * tenant-scoped). It did NOT drop the caches that live in module scope — and
 * logout does not reload the page. `setUser(null)` renders the login screen in
 * the SAME JavaScript context, so a `let cache = …` at the top of a hook file
 * survives it and the next person to sign in on that browser reads it.
 *
 * What that cost, concretely, on a shared workstation:
 *
 *   useIntegrationStatus  B's app pickers gated on A's `/ai/user-settings`
 *                         (orgEnabledIntegrations, isGoogleUser,
 *                         hasFirefliesKey). `useAppsCatalog` seeds
 *                         `enabledApps` from that payload and POSTs the seeded
 *                         list back on B's first toggle — B's own app
 *                         preferences overwritten with A's.
 *   useSkills             B saw A's skill list — names and descriptions,
 *                         including skills shared only with A's groups —
 *                         until something called `refresh()`.
 *   useShieldStatus       B saw A's org's Privacy Shield state.
 *   appRefLabel           B saw the app name, screen name and button label
 *                         behind an automation's `trigger.appRef` — plus
 *                         `canOpen:true`, so the breadcrumb offered a link
 *                         into an App Studio editor B has no rights to. The
 *                         cache key is appId+screenId+nodeId and names no
 *                         viewer, while the answer is per viewer: a
 *                         non-owner gets `restricted`, with no names and no
 *                         link. Reachable through the same builder URL
 *                         (?from=app:…) or any automation carrying that ref.
 *   useTrainingGates      B saw the courses A's organisation enforces, with
 *                         their titles and A's own lesson progress ("4 of 7
 *                         done") — and B's create buttons locked or unlocked
 *                         on A's rules. Same `let cached` shape as the others;
 *                         it simply never made this list.
 *   modelMeta             B's agent designer offered the models A's
 *                         organisation allows per agent type
 *                         (`fetchAllowedModelsByAgentType`), not B's own.
 *
 * Four of these six — integration status, skills, the shield and the training
 * gates — now read through the shared React Query cache, which `AuthedApp`
 * clears wholesale on logout. Their calls stay here anyway: a cache with an
 * owner is easier to keep honest than one that relies on a caller elsewhere
 * remembering to clear everything.
 *
 * The rule this file encodes: a cache keyed on nothing is keyed on the
 * session, so it dies with the session. A new module cache belongs in this
 * list on the day it is written, not after the incident.
 */
export function clearSessionCaches(): void {
    invalidateIntegrationStatus();
    invalidateShieldStatus();
    invalidateSkills();
    invalidateTrainingGates();
    clearAppRefCache();
    invalidateAllowedModelsCache();
}

export default clearSessionCaches;

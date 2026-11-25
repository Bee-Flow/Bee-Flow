/**
 * What the organisation's Cowork policy (../entitlements/coworkPolicy.mts) says about one plan: the apps it uses that
 * may not run while nobody watches. Asked before a plan run starts (./planRun.mts) and again when a paused run
 * continues (./planHeldDefinition.mts), so both refuse with the same reason.
 */

import type { Definition, ToolLookups } from './plan/planTypes.mts';
import { permissionsOf, BUILT_IN_APP } from './plan/planPermissions.mts';
import { appsNotAllowed, type CoworkPolicy } from '../entitlements/coworkPolicy.mts';

/**
 * Why the policy does not let this plan go on unattended, or null. `outcome` ends the sentence: what did not happen.
 */
export function unattendedRefusal(definition: Definition, lookups: ToolLookups, policy: CoworkPolicy, outcome = 'this plan did not run'): string | null {
    const blocked = appsNotAllowed(permissionsOf(definition, lookups).grants.map((g) => g.app).filter((a) => a !== BUILT_IN_APP), policy);
    return blocked.length > 0 ? `Your organisation does not let ${blocked.join(', ')} run while nobody watches, so ${outcome}.` : null;
}

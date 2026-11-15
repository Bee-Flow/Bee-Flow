// Reading the integration availability of the chosen organisation
// (api/queries/orgIntegrationAvailability.ts): is a family, or one catalogue
// integration, available, and what to do while the answer is not there.
//
// THE FAIL POLICY, mirroring `entitlementsUnknown`:
//   - a platform admin: while the answer loads, after it failed, or when the
//     server could not read the organisation's plan, the setting FAILS OPEN and
//     carries `unknown: true`, so the page can say "could not check
//     availability" instead of hiding a setting the operator may need;
//   - an organisation admin's configuration form: it FAILS CLOSED, so nobody
//     configures an integration their organisation may not have.
// A definite answer is the answer for both.

import type { TranslateFn } from '@/hooks/useTranslation';
import type {
    IntegrationFamily,
    OrgIntegrationAvailability,
    UnavailableReason,
} from '@/api/queries/orgIntegrationAvailability';

/** The query result as the helpers read it (a react-query result fits). */
export interface AvailabilityRead {
    data?: OrgIntegrationAvailability | null;
    isError?: boolean;
}

/** Who is looking: decides which way an unknown answer falls. */
export interface AvailabilityViewer {
    /** True for the operator of the whole server (utils/adminAccess isPlatformAdmin). */
    platformAdmin: boolean;
}

export interface AvailabilityVerdict {
    available: boolean;
    /** Why not, when the answer is definite. */
    reason?: UnavailableReason;
    /** No definite answer: `available` is the fail policy's choice. */
    unknown: boolean;
}

/** Reasons the plan decides, which a degraded answer cannot vouch for. */
const PLAN_REASONS: ReadonlySet<UnavailableReason> = new Set(['not_in_plan', 'not_granted_to_org']);

function unknownFor(viewer: AvailabilityViewer): AvailabilityVerdict {
    return { available: viewer.platformAdmin, unknown: true };
}

function verdictOf(
    av: OrgIntegrationAvailability,
    entry: { available: boolean; reason?: UnavailableReason } | undefined,
    viewer: AvailabilityViewer,
): AvailabilityVerdict {
    if (!entry) return unknownFor(viewer);
    if (entry.available) return { available: true, unknown: false };
    if (av.degraded && (!entry.reason || PLAN_REASONS.has(entry.reason))) return unknownFor(viewer);
    return entry.reason ? { available: false, reason: entry.reason, unknown: false } : { available: false, unknown: false };
}

/** Is this integration family available to the chosen organisation? */
export function familyAvailable(read: AvailabilityRead | null | undefined, family: IntegrationFamily, viewer: AvailabilityViewer): AvailabilityVerdict {
    const av = read?.data;
    if (!av || read?.isError) return unknownFor(viewer);
    return verdictOf(av, av.families?.[family], viewer);
}

/** Is this catalogue integration (`gmail`, `fireflies`, `nextcloud-talk`, …) available to the chosen organisation? */
export function integrationAvailable(read: AvailabilityRead | null | undefined, integrationId: string, viewer: AvailabilityViewer): AvailabilityVerdict {
    const av = read?.data;
    if (!av || read?.isError) return unknownFor(viewer);
    return verdictOf(av, av.integrations?.[integrationId], viewer);
}

/** The sentence for a reason, for a disabled card or a note under a setting. */
export function availabilityReasonText(t: TranslateFn, reason: UnavailableReason): string {
    switch (reason) {
        case 'not_configured': return t('admin_availability.reason_not_configured', 'Not set up on this server');
        case 'not_in_plan': return t('admin_availability.reason_not_in_plan', "Not included in this organisation's plan");
        case 'not_granted_to_org': return t('admin_availability.reason_not_granted_to_org', 'Not enabled for this organisation');
        case 'module_off': return t('admin_availability.reason_module_off', 'Turned off on this server');
        case 'not_bound': return t('admin_availability.reason_not_bound', 'This organisation is not connected to a Nextcloud');
        default: return t('admin_availability.unavailable', 'Not available for this organisation');
    }
}

/** The note a platform admin sees on a setting shown without a definite answer. */
export function availabilityUnknownText(t: TranslateFn): string {
    return t('admin_availability.unknown', 'Could not check whether this is available for this organisation');
}

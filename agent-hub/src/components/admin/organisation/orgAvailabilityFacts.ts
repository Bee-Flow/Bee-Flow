// What the CHOSEN organisation has, for the Organisation tab's section rules
// (orgSections): read from its integration availability
// (api/queries/orgIntegrationAvailability), never the viewer's own session, with
// the fail policy of utils/integrationAvailability. Pure, so every rule can be
// tested without rendering a panel.

import type { IntegrationFamily, OrgIntegrationAvailability, UnavailableReason } from '@/api/queries/orgIntegrationAvailability';
import { familyAvailable, type AvailabilityRead } from '@/utils/integrationAvailability';

/**
 * What the CHOSEN organisation has, from its integration availability
 * (api/queries/orgIntegrationAvailability), never the viewer's own session: a
 * platform admin looking at another organisation gets that organisation's
 * rows. Read by orgAvailabilityFactsOf with the fail policy of
 * utils/integrationAvailability.
 */
export interface OrgAvailabilityFacts {
    /** The organisation is bound to a Nextcloud. */
    ncBound: boolean;
    /**
     * The Nextcloud row applies: a bound organisation, or the viewer's own
     * unbound organisation while pairing is offered (the section's "Connect a
     * Nextcloud"), for the platform admin and for an admin of that organisation.
     */
    ncSectionAvailable: boolean;
    /** The organisation can sync agent configuration with GitHub (the family is available, or a sync is already set up). */
    githubAvailable: boolean;
    /** Microsoft 365 applies: Microsoft is set up on the server, and the organisation has a directory connected or is the viewer's own. */
    microsoft365: boolean;
    meetingNotes: boolean;
    mcp: boolean;
    projects: boolean;
    learningCenter: boolean;
    automations: boolean;
    /**
     * The availability is still being read (set by useOrgSectionFacts): a
     * section hidden only for want of an answer may yet open, so the tab waits
     * instead of showing another section in its place.
     */
    availabilityPending?: boolean;
    /** Why a family is not available to the organisation, where the answer says so (the unavailable notice). */
    familyReasons?: Partial<Record<IntegrationFamily, UnavailableReason>>;
}

interface AvailabilityFactsInput {
    /** The availability query of the chosen organisation (a react-query result fits). */
    read: AvailabilityRead | null | undefined;
    /** The fail policy's viewer: a platform admin fails open, anyone else closed. */
    platformAdmin: boolean;
    /** The viewer administers an organisation (canSeeOrg): their own one may pair with a Nextcloud. */
    orgAdmin?: boolean;
    /** The chosen organisation is the viewer's home organisation (the answer's own flag wins once there). */
    homeOrg: boolean;
    /** The viewer's session says their home organisation is bound to a Nextcloud: the fallback while there is no answer. */
    sessionNcBound: boolean;
}

/** The answer is there and has the shape the rules read. */
function knownAnswer(read: AvailabilityRead | null | undefined): OrgIntegrationAvailability | null {
    const data = read?.data;
    return !read?.isError && data && typeof data === 'object' && data.families && data.nextcloud ? data : null;
}

/** Microsoft 365 applies to the organisation: set up on the server, and a directory connected or the viewer's own organisation. */
function microsoft365Of(answer: OrgIntegrationAvailability, ownOrg: boolean): boolean {
    return !!answer.families.microsoft?.serverConfigured && (!!answer.microsoft?.directoryConnected || ownOrg);
}

/**
 * The Nextcloud row: a bound organisation, or the viewer's own unbound one while
 * pairing is offered, for a platform or organisation admin. Without an answer a
 * platform admin fails open, anyone else follows the binding.
 */
function ncSectionAvailableOf(answer: OrgIntegrationAvailability | null, ncBound: boolean, ownOrg: boolean, viewer: { platformAdmin: boolean; orgAdmin: boolean }): boolean {
    if (!answer) return viewer.platformAdmin || ncBound;
    return ncBound || ((viewer.platformAdmin || viewer.orgAdmin) && ownOrg && !!answer.nextcloud.pairingAvailable);
}

/** The families a section rule reads, whose reason the unavailable notice names. */
const REASONED_FAMILIES: readonly IntegrationFamily[] = ['projects', 'learningCenter', 'meetingNotes', 'mcp', 'automations', 'github', 'microsoft'];

/**
 * The chosen organisation's facts. Without an answer (loading, failed, no
 * organisation chosen) the Nextcloud binding falls back to the viewer's session
 * for their home organisation, the Nextcloud row is offered to a platform admin,
 * and every family follows the fail policy.
 */
export function orgAvailabilityFactsOf({ read, platformAdmin, orgAdmin = false, homeOrg, sessionNcBound }: AvailabilityFactsInput): OrgAvailabilityFacts {
    const viewer = { platformAdmin };
    const has = (family: IntegrationFamily) => familyAvailable(read, family, viewer).available;
    const familyReasons: Partial<Record<IntegrationFamily, UnavailableReason>> = {};
    for (const family of REASONED_FAMILIES) {
        const reason = familyAvailable(read, family, viewer).reason;
        if (reason) familyReasons[family] = reason;
    }
    const answer = knownAnswer(read);
    const ownOrg = answer ? answer.homeOrg : homeOrg;
    const ncBound = answer ? !!answer.nextcloud.bound : homeOrg && sessionNcBound;
    const ncSectionAvailable = ncSectionAvailableOf(answer, ncBound, ownOrg, { platformAdmin, orgAdmin });
    return {
        ncBound,
        ncSectionAvailable,
        githubAvailable: has('github') || !!answer?.github?.syncConfigured,
        microsoft365: answer ? microsoft365Of(answer, ownOrg) : platformAdmin,
        meetingNotes: has('meetingNotes'),
        mcp: has('mcp'),
        projects: has('projects'),
        learningCenter: has('learningCenter'),
        automations: has('automations'),
        familyReasons,
    };
}

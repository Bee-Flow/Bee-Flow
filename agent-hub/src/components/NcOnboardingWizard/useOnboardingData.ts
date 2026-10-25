import { useState } from 'react';
import { useNcOnboardingOrg, useNcSyncGroups } from '../../api/queries/settingsNcOnboarding';

interface OrgForm {
    name: string; email: string; tagline: string; description: string;
    address: string; phone: string; website: string; kvk: string; vat: string;
}
const BLANK_ORG: OrgForm = { name: '', email: '', tagline: '', description: '', address: '', phone: '', website: '', kvk: '', vat: '' };
const NO_GROUPS: string[] = [];

const ORG_FIELDS = Object.keys(BLANK_ORG) as (keyof OrgForm)[];

/** The org row's fields, with the NC bootstrap data standing in for an empty name and e-mail. */
function orgPrefill(j: Partial<OrgForm> | null | undefined, orgName: string | null | undefined, userEmail: string | undefined): OrgForm {
    const out = { ...BLANK_ORG };
    for (const k of ORG_FIELDS) out[k] = j?.[k] || '';
    out.name = j?.name || orgName || '';
    out.email = j?.email || userEmail || '';
    return out;
}

/**
 * Organisation form. Pre-filled from GET /auth/organizations/:id, falling back to the NC
 * bootstrap data (orgName prop, user email) when the org row's fields are still empty;
 * the person's own typing wins over the pre-fill.
 */
export function useOrgForm(orgId: string | undefined, orgName: string | null | undefined, userEmail: string | undefined): [OrgForm, (next: OrgForm) => void] {
    const orgQuery = useNcOnboardingOrg(orgId);
    const j = orgQuery.data;
    const [edited, setEdited] = useState<OrgForm | null>(null);
    const prefill: OrgForm = orgQuery.isSuccess ? orgPrefill(j, orgName, userEmail) : BLANK_ORG;
    return [edited ?? prefill, setEdited];
}

export function useGroups(orgId: string | undefined) {
    const query = useNcSyncGroups(orgId);
    // Without an org there is nothing to load (the spinner then stays, as it always did).
    return { groups: query.data ?? NO_GROUPS, groupsLoading: !orgId || query.isPending };
}

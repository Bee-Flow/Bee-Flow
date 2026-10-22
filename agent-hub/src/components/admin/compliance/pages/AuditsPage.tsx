import React from 'react';
import AuditsTab from './audits/AuditsTab';
import ReviewsTab from './audits/ReviewsTab';
import NcsTab from './audits/NcsTab';
import ObjectivesTab from './audits/ObjectivesTab';
import type { ComponentProps } from 'react';
import type { SetHeaderActions } from './audits/useHeaderPrimary';
import type { OrgUser } from './accessAuditLabels';

interface AuditTabProps {
    audit: AuditHook;
    orgUsers: OrgUser[] | null;
    isMobile: boolean;
    focusId: string | null;
    setHeaderActions: SetHeaderActions;
}

type AuditHook = ComponentProps<typeof ReviewsTab>['audit'] & ComponentProps<typeof NcsTab>['audit'] & ComponentProps<typeof ObjectivesTab>['audit'];

/**
 * AuditsPage — the ISMS-process section (ISO 27001 clauses 9.2 / 9.3 / 10.2 /
 * 6.2) as four registers behind the header's tabs.
 *
 * The page itself owns nothing but the tab switch: each tab is a complete
 * register (table + drawer) coded against `data.audit`, the hub hook that
 * carries the legacy handler names (createAudit / updateAudit / addFinding /
 * createReview / createNc / updateNc / createObjective / updateObjective).
 *
 * `tab` comes from the header (`sections.js` declares
 * `tabs: ['audits','reviews','ncs','objectives']`); an unknown or missing tab
 * falls back to the first one, so a stale `?tab=` never renders a blank page.
 *
 * The create action of the active tab sits in the section header: each tab
 * hands it up through `setHeaderActions` (useHeaderPrimary) and keeps only
 * its one-line intro in the toolbar. Every tab opens its drawer through
 * useDrawerMode and draws its states with RegisterStatePill.
 */

export const AUDIT_TABS = Object.freeze(['audits', 'reviews', 'ncs', 'objectives']);

const TAB_COMPONENTS = Object.freeze({
    audits: AuditsTab,
    reviews: ReviewsTab,
    ncs: NcsTab,
    objectives: ObjectivesTab,
});

/** Canonical tab id — anything unknown resolves to the first tab. */
export function resolveTab(tab: string) {
    return AUDIT_TABS.includes(tab) ? tab : AUDIT_TABS[0];
}

interface AuditsPageArgs {
    tab: string;
    data?: { audit?: AuditHook; orgUsers?: OrgUser[] | null };
    isMobile?: boolean | undefined;
    focusId?: string | null;
    setHeaderActions?: SetHeaderActions;
}

export default function AuditsPage({ tab, data = {}, isMobile = false, focusId = null, setHeaderActions = undefined }: AuditsPageArgs) {
    const active = resolveTab(tab);
    const Tab = TAB_COMPONENTS[active as keyof typeof TAB_COMPONENTS] as React.ComponentType<AuditTabProps>;
    const audit = (data.audit || {}) as AuditHook;
    const orgUsers = data.orgUsers ?? null;

    return (
        <div className="h-full min-h-0 flex flex-col" data-testid="audits-page" data-tab={active}>
            <Tab audit={audit} orgUsers={orgUsers} isMobile={isMobile} focusId={focusId} setHeaderActions={setHeaderActions} />
        </div>
    );
}

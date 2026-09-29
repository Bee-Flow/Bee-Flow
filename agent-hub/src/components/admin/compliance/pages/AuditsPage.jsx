import React from 'react';
import AuditsTab from './audits/AuditsTab';
import ReviewsTab from './audits/ReviewsTab';
import NcsTab from './audits/NcsTab';
import ObjectivesTab from './audits/ObjectivesTab';

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
 */

export const AUDIT_TABS = Object.freeze(['audits', 'reviews', 'ncs', 'objectives']);

const TAB_COMPONENTS = Object.freeze({
    audits: AuditsTab,
    reviews: ReviewsTab,
    ncs: NcsTab,
    objectives: ObjectivesTab,
});

/** Canonical tab id — anything unknown resolves to the first tab. */
export function resolveTab(tab) {
    return AUDIT_TABS.includes(tab) ? tab : AUDIT_TABS[0];
}

export default function AuditsPage({ tab, data = {}, isMobile = false, focusId = null }) {
    const active = resolveTab(tab);
    const Tab = TAB_COMPONENTS[active];
    const audit = data.audit || {};
    const orgUsers = data.orgUsers ?? null;

    return (
        <div className="h-full min-h-0 flex flex-col" data-testid="audits-page" data-tab={active}>
            <Tab audit={audit} orgUsers={orgUsers} isMobile={isMobile} focusId={focusId} />
        </div>
    );
}

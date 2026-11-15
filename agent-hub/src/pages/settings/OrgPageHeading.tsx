// The heading of an organisation page outside the admin dashboard (Settings on
// a phone, /app/org-settings): in the dashboard the AdminPage frame draws it,
// so the panels draw none of their own. The same label and line as the
// dashboard's rail row (organisation/orgSections); an OrgInfoPanel section
// without a row there by its Settings label. The Privacy Shield and the MCP
// library name themselves (OrganisationSection SELF_NAMED_SECTIONS).

import SectionHeader from '@/components/shared/SectionHeader';
import { ORG_SECTION_ALIASES } from '@/components/admin/dashboard/adminPathAliases';
import { SECTIONS as INFO_SECTIONS } from '@/components/admin/org/orgInfo/orgInfoShared';
import { ORG_HUB_SECTIONS } from '@/components/admin/organisation/orgSections';
import { useTranslation } from '@/hooks/useTranslation';

/** The rail row of a section named by its Settings id (github_sync) or its dashboard id (github-sync). */
function hubRowOf(section: string) {
    const hubId = Object.hasOwn(ORG_SECTION_ALIASES, section) ? ORG_SECTION_ALIASES[section] : section;
    return ORG_HUB_SECTIONS.find(s => s.id === hubId) ?? null;
}

/** The page heading of an organisation section, or nothing for a section without a label. */
export default function OrgPageHeading({ section, className = 'mb-6' }: { section: string; className?: string }) {
    const { t } = useTranslation();
    const row = hubRowOf(section);
    if (row) {
        const description = row.descriptionKey ? t(row.descriptionKey, row.descriptionFallback) : undefined;
        return <SectionHeader className={className} title={t(row.labelKey, row.labelFallback)} description={description} />;
    }
    const info = INFO_SECTIONS.find(s => s.id === section);
    return info ? <SectionHeader className={className} title={t(info.labelKey)} /> : null;
}

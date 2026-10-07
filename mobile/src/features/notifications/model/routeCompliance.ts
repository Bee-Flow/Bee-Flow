/**
 * Where a Compliance Center address opens on the phone:
 *
 *   /app/admin/compliance/<section>[/<id>]   utils/appPaths.js complianceSectionPath,
 *                                            complianceIncidentPath (compliance/events.js,
 *                                            attention.js, deadlines.js,
 *                                            jobs/complianceDeadlineNotifier.js)
 *   /app/admin/compliance/dsr?id=<id>        the DSR deadline notice (the same job)
 *
 * The rules are features/compliance's own — sectionById (a section id or an
 * old alias) and targetRoute (a section's page, or one record in it: a
 * register's record under its first record type) — ported rather than
 * imported, for the reason routeOrg.ts gives. routeCompliance.lockstep.test.ts
 * runs both on every section, alias and moved tab. `?tab=` is kept on a
 * section's page; a tab that moved (sections.ts LEGACY_TABS) goes where it
 * went — the calendar is a hub page of its own (jobs/complianceDeadlineNotifier.js
 * links frameworks?tab=calendar and overview?tab=calendar).
 */

import { queryValue } from './query';
import type { NotificationTarget } from './route';

/** The Compliance Center hub (features/compliance model/navigation.ts HUB_ROUTE). */
const HUB = '/org/compliance';

/** sections.ts SECTIONS, by id; the overview is the hub itself. */
export const COMPLIANCE_SECTION_IDS: ReadonlySet<string> = new Set([
    'overview', 'gdpr', 'aia', 'iso', 'frameworks', 'nis2', 'cra', 'data_act', 'pld', 'eaa', 'dora', 'machinery', 'custom',
    'dsr', 'incidents', 'vulnerabilities', 'ropa', 'dpia', 'risks', 'soa', 'policies', 'audits', 'training', 'access_log',
    'portability', 'settings', 'connectors',
]);

/** sections.ts ALIASES: old ids the web still accepts. */
export const COMPLIANCE_ALIASES: Readonly<Record<string, string>> = {
    iso_overview: 'iso',
    iso_controls: 'iso',
    kaders: 'frameworks',
    iso_risks: 'risks',
    iso_soa: 'soa',
    iso_policies: 'policies',
    iso_audit: 'audits',
    iso_training: 'training',
    iso_access_log: 'access_log',
    iso_connectors: 'connectors',
};

/** A register whose first record type is not its own id: a record opens under the type. */
const RECORD_SEGMENT: Readonly<Record<string, string>> = { training: 'personnel' };

/** sections.ts HUB_PAGES: hub pages that are not a section. */
const HUB_PAGES: ReadonlySet<string> = new Set(['calendar', 'setup', 'chat_signals']);

/** sections.ts LEGACY_TABS, as the route each moved tab opens. Spelled out, so src/meta/routes.test.ts checks them. */
export const COMPLIANCE_MOVED_TABS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    overview: { calendar: '/org/compliance/calendar' },
    frameworks: { calendar: '/org/compliance/calendar', per_automation: '/org/compliance/aia?tab=systems' },
    dsr: { settings: '/org/compliance/settings' },
    soa: { export: '/org/compliance/soa?tab=controls' },
    audits: { obligations: '/org/compliance/training?tab=obligations' },
};

function sectionOf(raw: string | undefined): string | null {
    const key = (raw ?? '').trim();
    if (COMPLIANCE_SECTION_IDS.has(key)) return key;
    return COMPLIANCE_ALIASES[key] ?? null;
}

function movedTab(section: string, tab: string | null): string | null {
    const map = COMPLIANCE_MOVED_TABS[section];
    return tab && map && Object.prototype.hasOwnProperty.call(map, tab) ? (map[tab] as string) : null;
}

/** `/app/admin/compliance/<segment>[/<id>][?tab=]`, the id also as `?id=`. */
export function complianceTarget(segment: string | undefined, id: string | undefined, query: string): NotificationTarget {
    if (!segment) return { href: HUB };
    if (HUB_PAGES.has(segment)) return { href: `/org/compliance/${segment}` };
    const section = sectionOf(segment);
    // A section this build does not know: the hub, which lists the ones it does.
    if (!section) return { href: HUB, approximate: true };
    const tab = queryValue(query, 'tab') || null;
    const moved = movedTab(section, tab);
    if (moved) return { href: moved };
    if (section === 'overview') return { href: HUB };
    const record = id || queryValue(query, 'id');
    // Spelled out rather than from HUB, so src/meta/routes.test.ts checks both against app/.
    if (record) return { href: `/org/compliance/${RECORD_SEGMENT[section] ?? section}/${record}` };
    return { href: tab ? `/org/compliance/${section}?tab=${tab}` : `/org/compliance/${section}` };
}

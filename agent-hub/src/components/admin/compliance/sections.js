/**
 * sections — the Compliance Center's section registry (redesign, Sep 2026).
 *
 * One flat rail replaces the old GDPR·AI / ISO toggle: KADERS (the frameworks,
 * each with a score), REGISTERS (the things a DPO or CISO keeps — a request,
 * an incident, a risk — which serve SEVERAL frameworks at once: an incident
 * counts for GDPR Art. 33, ISO A.5.24 and the CRA reporting duty) and BEHEER.
 * The registers therefore no longer live "under" ISO, and their ids lose the
 * `iso_` prefix. The old ids stay as ALIASES so every bookmarked
 * `admin/compliance/iso_soa` and `/app/settings/organisation/compliance/iso_*`
 * still opens the right page; the hub EMITS canonical ids only.
 *
 * `frameworkOf` keeps the one meaning that mattered in the old
 * `frameworkOf(sectionId)`: which regulation a section SCORES. Registers
 * answer null — they belong to several.
 *
 * A leaf on purpose: `ComplianceHub.nav.test.jsx`, the rail, the header and
 * `complianceNavAdapter` all read it, and nothing here may import React.
 */
import {
    Accessibility, ArrowLeftRight, BookOpen, Bot, Bug, ClipboardCheck, Database, Factory,
    Fingerprint, FolderKanban, Gauge, Gavel, GraduationCap, History, Inbox, Landmark, Layers,
    ListChecks, Network, PlugZap, ScrollText, SearchCheck, Settings2, ShieldAlert, ShieldCheck,
    Siren, TriangleAlert,
} from 'lucide-react';

export const GROUPS = Object.freeze([
    Object.freeze({ id: 'frameworks', labelKey: 'compliance.rail_group_frameworks', labelFallback: 'Frameworks' }),
    Object.freeze({ id: 'registers', labelKey: 'compliance.rail_group_registers', labelFallback: 'Registers' }),
    Object.freeze({ id: 'admin', labelKey: 'compliance.rail_group_admin', labelFallback: 'Admin' }),
]);

// Tabs a framework section carries in its header (artboard 1b: Checks · Tijdlijn · Bewijs).
const FRAMEWORK_TABS = Object.freeze(['checks', 'timeline', 'evidence']);

// `legacyTabs` maps a tab that no longer lives on a section to where it went:
// `{ <oldTab>: { section, tab? } }`. A bookmark, an e-mailed link or a stored
// attention target with `?tab=<oldTab>` then still opens the right page
// (resolveTab here, the redirect in index.jsx, resolveTarget in data/actions.js).
const NO_LEGACY_TABS = Object.freeze({});
const legacy = (map) => Object.freeze(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, Object.freeze({ ...v })])));

const fw = (id, regulation, icon, labelKey, labelFallback, extra = {}) => Object.freeze({
    id, group: 'frameworks', icon, labelKey, labelFallback, regulation, tabs: FRAMEWORK_TABS, aliases: Object.freeze([]), legacyTabs: NO_LEGACY_TABS, ...extra,
});
const reg = (id, icon, labelKey, labelFallback, extra = {}) => Object.freeze({
    id, group: 'registers', icon, labelKey, labelFallback, regulation: null, tabs: Object.freeze([]), aliases: Object.freeze([]), legacyTabs: NO_LEGACY_TABS, ...extra,
});

export const SECTIONS = Object.freeze([
    Object.freeze({
        id: 'overview', group: null, icon: Gauge, labelKey: 'compliance.nav_overview', labelFallback: 'Overview',
        regulation: null, tabs: Object.freeze(['status', 'calendar', 'reports']), aliases: Object.freeze([]), legacyTabs: NO_LEGACY_TABS,
    }),
    // ── Kaders ──
    fw('gdpr', 'GDPR', Fingerprint, 'compliance.nav_gdpr', 'GDPR'),
    fw('aia', 'AIA', Bot, 'compliance.nav_aia', 'AI Act'),
    // iso_overview's readiness numbers move into the ISO header pill and its five
    // downloads into Overview › Reports, so both old ids land on the one ISO page.
    fw('iso', 'ISO27001', ShieldCheck, 'compliance.fw_iso', 'ISO 27001', { aliases: Object.freeze(['iso_overview', 'iso_controls']) }),
    Object.freeze({
        id: 'frameworks', group: 'frameworks', icon: Layers, labelKey: 'compliance.rail_frameworks', labelFallback: 'More frameworks',
        regulation: null, tabs: Object.freeze(['all', 'calendar', 'per_automation']), aliases: Object.freeze(['kaders']), legacyTabs: NO_LEGACY_TABS,
    }),
    // The growing set — a row appears in the rail only once the org has enabled it.
    fw('nis2', 'NIS2', Network, 'compliance.rail_nis2', 'NIS2', { optional: true }),
    fw('cra', 'CRA', Bug, 'compliance.rail_cra', 'CRA', { optional: true }),
    fw('data_act', 'DATA_ACT', Database, 'compliance.rail_data_act', 'Data Act', { optional: true }),
    fw('pld', 'PLD', Gavel, 'compliance.rail_pld', 'Product liability', { optional: true }),
    fw('eaa', 'EAA', Accessibility, 'compliance.rail_eaa', 'Accessibility (EAA)', { optional: true }),
    fw('dora', 'DORA', Landmark, 'compliance.rail_dora', 'DORA', { optional: true }),
    // Machinery shows detections + assessments, and a custom framework its own
    // checks register — neither is the checks/timeline/evidence table.
    fw('machinery', 'MACHINERY', Factory, 'compliance.rail_machinery', 'Machinery Regulation', { optional: true, tabs: Object.freeze([]) }),
    fw('custom', 'CUSTOM', FolderKanban, 'compliance.rail_custom', 'Own frameworks', { optional: true, tabs: Object.freeze([]) }),
    // ── Registers ──
    // The DPO / acknowledgement settings live with the other compliance settings (reached through the rail).
    reg('dsr', Inbox, 'compliance.rail_dsr', 'Requests (DSR)', { tabs: Object.freeze(['requests', 'public_form']), legacyTabs: legacy({ settings: { section: 'settings' } }) }),
    reg('incidents', Siren, 'compliance.rail_incidents', 'Incidents & breaches'),
    reg('vulnerabilities', ShieldAlert, 'compliance.rail_vulnerabilities', 'Vulnerability register', { optional: true }),
    reg('ropa', BookOpen, 'compliance.rail_ropa', 'Processing register (ROPA)'),
    reg('dpia', ClipboardCheck, 'compliance.rail_dpia', 'DPIAs'),
    reg('risks', TriangleAlert, 'compliance.rail_risks', 'Risk register', { aliases: Object.freeze(['iso_risks']) }),
    reg('soa', ListChecks, 'compliance.rail_soa', 'SoA (Annex A)', { tabs: Object.freeze(['controls', 'history', 'export']), aliases: Object.freeze(['iso_soa']) }),
    reg('policies', ScrollText, 'compliance.rail_policies', 'Policies', { aliases: Object.freeze(['iso_policies']) }),
    reg('audits', SearchCheck, 'compliance.rail_audits', 'Audits & reviews', {
        tabs: Object.freeze(['audits', 'reviews', 'ncs', 'objectives']), aliases: Object.freeze(['iso_audit']),
        // The ISMS obligations moved to Training & competence.
        legacyTabs: legacy({ obligations: { section: 'training' } }),
    }),
    reg('training', GraduationCap, 'compliance.rail_training', 'Training & competence', { aliases: Object.freeze(['iso_training']) }),
    reg('access_log', History, 'compliance.rail_access_log', 'Access log', { aliases: Object.freeze(['iso_access_log']) }),
    reg('portability', ArrowLeftRight, 'compliance.rail_portability', 'Data portability', { optional: true }),
    // ── Beheer ──
    Object.freeze({
        id: 'settings', group: 'admin', icon: Settings2, labelKey: 'compliance.nav_settings', labelFallback: 'Settings',
        regulation: null, tabs: Object.freeze([]), aliases: Object.freeze([]), legacyTabs: NO_LEGACY_TABS,
    }),
    Object.freeze({
        id: 'connectors', group: 'admin', icon: PlugZap, labelKey: 'compliance.rail_connectors', labelFallback: 'Evidence connectors',
        regulation: null, tabs: Object.freeze([]), aliases: Object.freeze(['iso_connectors']), legacyTabs: NO_LEGACY_TABS,
    }),
]);

export const DEFAULT_SECTION = 'overview';

const BY_ID = new Map(SECTIONS.map(s => [s.id, s]));
const BY_ALIAS = new Map();
for (const s of SECTIONS) for (const a of s.aliases) BY_ALIAS.set(a, s.id);

/** Canonical id for any id or alias; unknown or empty → the overview. */
export function resolveSection(id) {
    const key = typeof id === 'string' ? id.trim() : '';
    if (BY_ID.has(key)) return key;
    if (BY_ALIAS.has(key)) return BY_ALIAS.get(key);
    return DEFAULT_SECTION;
}

/** The section record, by id or alias (never null — falls back to the overview). */
export function sectionById(id) {
    return BY_ID.get(resolveSection(id));
}

/** The regulation a section SCORES — null for the overview, registers and admin. */
export function frameworkOf(sectionId) {
    return sectionById(sectionId).regulation;
}

/** regulation code → the section that scores it. */
export const SECTION_FOR_REGULATION = Object.freeze(Object.fromEntries(
    SECTIONS.filter(s => s.regulation).map(s => [s.regulation, s.id]),
));

/** The section for a regulation code; unknown → the overview (never a broken link). */
export function sectionForRegulation(code) {
    return SECTION_FOR_REGULATION[code] || DEFAULT_SECTION;
}

/** Header tab ids of a section, in artboard order. */
export function tabsOf(sectionId) {
    return sectionById(sectionId).tabs;
}

/**
 * Where `?tab=<tab>` on a section lands: the section's own tab, or — for a tab
 * that moved away — the target its `legacyTabs` names. Always `{ section, tab }`
 * with a canonical section id; `tab` is null when there is none to select.
 */
export function resolveTab(sectionId, tab) {
    const section = sectionById(sectionId);
    const moved = movedTab(section.id, tab);
    if (moved) return { section: resolveSection(moved.section), tab: moved.tab || null };
    return { section: section.id, tab: typeof tab === 'string' && tab ? tab : null };
}

/** The `legacyTabs` target of a tab that moved away from a section, else null. */
export function movedTab(sectionId, tab) {
    const map = sectionById(sectionId).legacyTabs;
    return typeof tab === 'string' && tab && map && Object.hasOwn(map, tab) ? map[tab] : null;
}

/** Sections in one rail group, in rail order. */
export function sectionsInGroup(groupId) {
    return SECTIONS.filter(s => s.group === groupId);
}

/**
 * Sections whose page shows an org-member picker (DPO, owners, auditors,
 * attesters) or names members (the Access log shows who acted, the DSR
 * timeline who handled a request). `/org-users`
 * is fetched only for these — the nav test pins that the GDPR page never asks
 * for the directory.
 */
export const SECTIONS_WITH_PICKERS = Object.freeze(['settings', 'soa', 'policies', 'risks', 'audits', 'training', 'custom', 'access_log', 'dsr']);

/** i18n key of a header tab label: `compliance.tab_<section>_<tab>`. */
export function tabLabelKey(sectionId, tabId) {
    return `compliance.tab_${resolveSection(sectionId)}_${tabId}`;
}

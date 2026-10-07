/**
 * The hub's sections, in the web rail's order (agent-hub
 * components/admin/compliance/sections.js): the frameworks, the registers a
 * DPO or CISO keeps, and the admin pair. `frameworksLockstep.test.ts` holds
 * the ids and order to the web file.
 *
 * `view` says which kind of page a section is on the phone:
 *   checks     — the checks table of one regulation (GDPR, AI Act, ISO, NIS2…)
 *   records    — a register driven by the record-type registry (one or more tabs)
 *   frameworks, ropa, access_log, portability, settings — a page of its own
 */

import type { IconName } from '@/shared/ui';

import { recordType } from './registry';
import type { Label } from './types';

export type SectionGroup = 'frameworks' | 'registers' | 'admin';
export type SectionView = 'overview' | 'checks' | 'records' | 'frameworks' | 'ropa' | 'access_log' | 'portability' | 'settings';

export interface ComplianceSection {
    readonly id: string;
    readonly group: SectionGroup | null;
    readonly icon: IconName;
    readonly label: Label;
    /** The regulation code the section SCORES; null for registers and admin. */
    readonly regulation: string | null;
    /** Shown only once the org enabled the framework it belongs to. */
    readonly optional?: boolean;
    readonly view: SectionView;
    /** The record types behind a `records` section, in tab order. */
    readonly types?: readonly string[];
}

export const GROUPS: readonly { id: SectionGroup; label: Label }[] = [
    { id: 'frameworks', label: { i18nKey: 'compliance.rail_group_frameworks', en: 'Frameworks' } },
    { id: 'registers', label: { i18nKey: 'compliance.rail_group_registers', en: 'Registers' } },
    { id: 'admin', label: { i18nKey: 'compliance.rail_group_admin', en: 'Admin' } },
];

function fw(id: string, regulation: string, icon: IconName, label: Label): ComplianceSection {
    return { id, group: 'frameworks', icon, label, regulation, view: 'checks' };
}

function reg(id: string, icon: IconName, label: Label, types: readonly string[]): ComplianceSection {
    return { id, group: 'registers', icon, label, regulation: null, view: 'records', types };
}

/** A row of the growing set: shown once the org has enabled its framework. */
const opt = (section: ComplianceSection): ComplianceSection => ({ ...section, optional: true });

export const SECTIONS: readonly ComplianceSection[] = [
    { id: 'overview', group: null, icon: 'Gauge', label: { i18nKey: 'compliance.nav_overview', en: 'Overview' }, regulation: null, view: 'overview' },
    fw('gdpr', 'GDPR', 'FingerprintPattern', { i18nKey: 'compliance.nav_gdpr', en: 'GDPR' }),
    fw('aia', 'AIA', 'Bot', { i18nKey: 'compliance.nav_aia', en: 'AI Act' }),
    fw('iso', 'ISO27001', 'ShieldCheck', { i18nKey: 'compliance.fw_iso', en: 'ISO 27001' }),
    { id: 'frameworks', group: 'frameworks', icon: 'Layers', label: { i18nKey: 'compliance.rail_frameworks', en: 'More frameworks' }, regulation: null, view: 'frameworks' },
    opt(fw('nis2', 'NIS2', 'Network', { i18nKey: 'compliance.rail_nis2', en: 'NIS2' })),
    opt(fw('cra', 'CRA', 'Bug', { i18nKey: 'compliance.rail_cra', en: 'CRA' })),
    opt(fw('data_act', 'DATA_ACT', 'Database', { i18nKey: 'compliance.rail_data_act', en: 'Data Act' })),
    opt(fw('pld', 'PLD', 'Gavel', { i18nKey: 'compliance.rail_pld', en: 'Product liability' })),
    opt(fw('eaa', 'EAA', 'Eye', { i18nKey: 'compliance.rail_eaa', en: 'Accessibility (EAA)' })),
    opt(fw('dora', 'DORA', 'Landmark', { i18nKey: 'compliance.rail_dora', en: 'DORA' })),
    // Machinery shows detections + assessments, a custom framework its own
    // register — neither is a checks table.
    { ...opt(fw('machinery', 'MACHINERY', 'Wrench', { i18nKey: 'compliance.rail_machinery', en: 'Machinery Regulation' })), view: 'records', types: ['machinery'] },
    { ...opt(fw('custom', 'CUSTOM', 'Kanban', { i18nKey: 'compliance.rail_custom', en: 'Own frameworks' })), view: 'records', types: ['custom'] },
    reg('dsr', 'Inbox', { i18nKey: 'compliance.rail_dsr', en: 'Requests (DSR)' }, ['dsr']),
    reg('incidents', 'Siren', { i18nKey: 'compliance.rail_incidents', en: 'Incidents & breaches' }, ['incidents']),
    opt(reg('vulnerabilities', 'ShieldAlert', { i18nKey: 'compliance.rail_vulnerabilities', en: 'Vulnerability register' }, ['vulnerabilities'])),
    { ...reg('ropa', 'BookOpen', { i18nKey: 'compliance.rail_ropa', en: 'Processing register (ROPA)' }, []), view: 'ropa' },
    reg('dpia', 'ClipboardCheck', { i18nKey: 'compliance.rail_dpia', en: 'DPIAs' }, ['dpia']),
    reg('risks', 'TriangleAlert', { i18nKey: 'compliance.rail_risks', en: 'Risk register' }, ['risks']),
    reg('soa', 'ListChecks', { i18nKey: 'compliance.rail_soa', en: 'SoA (Annex A)' }, ['soa']),
    reg('policies', 'ScrollText', { i18nKey: 'compliance.rail_policies', en: 'Policies' }, ['policies']),
    reg('audits', 'FileSearch', { i18nKey: 'compliance.rail_audits', en: 'Audits & management review' }, ['audits', 'reviews', 'ncs', 'objectives']),
    reg('training', 'GraduationCap', { i18nKey: 'compliance.rail_training', en: 'Training & competence' }, ['personnel', 'obligations']),
    { ...reg('access_log', 'History', { i18nKey: 'compliance.rail_access_log', en: 'Access log' }, []), view: 'access_log' },
    { ...opt(reg('portability', 'Repeat', { i18nKey: 'compliance.rail_portability', en: 'Data portability' }, [])), view: 'portability' },
    { id: 'settings', group: 'admin', icon: 'Settings2', label: { i18nKey: 'compliance.nav_settings', en: 'Settings' }, regulation: null, view: 'settings' },
    { id: 'connectors', group: 'admin', icon: 'Plug', label: { i18nKey: 'compliance.rail_connectors', en: 'Evidence connectors' }, regulation: null, view: 'records', types: ['connectors'] },
];

/** Old ids the web still accepts (bookmarks from before the redesign). */
const ALIASES: Readonly<Record<string, string>> = {
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

const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));

/** The section for an id or an old alias; null for anything else. */
export function sectionById(id: string | null | undefined): ComplianceSection | null {
    const key = (id ?? '').trim();
    return BY_ID.get(key) ?? BY_ID.get(ALIASES[key] ?? '') ?? null;
}

export function sectionsInGroup(group: SectionGroup): ComplianceSection[] {
    return SECTIONS.filter((s) => s.group === group);
}

/** The id the counts and the frameworks endpoint key a section under. */
export function frameworkIdOf(section: ComplianceSection): string {
    if (section.id === 'iso') return 'iso27001';
    if (section.id === 'vulnerabilities') return 'cra';
    if (section.id === 'portability') return 'data_act';
    return section.id;
}

/** regulation code → section id; unknown → the overview (never a broken link). */
export function sectionForRegulation(code: string | null | undefined): string {
    return SECTIONS.find((s) => s.regulation && s.regulation === code && s.view === 'checks')?.id ?? 'overview';
}

/**
 * Which optional rows this org sees: a growing-set framework or register
 * shows once the org enabled it — its score is in the counts, or the
 * frameworks list says it is on.
 */
export function visibleSections(
    sections: readonly ComplianceSection[],
    scored: ReadonlySet<string>,
    enabled: ReadonlySet<string>,
): ComplianceSection[] {
    return sections.filter((s) => {
        if (!s.optional) return true;
        const id = frameworkIdOf(s);
        return scored.has(id) || enabled.has(id);
    });
}

/** One header tab of a section; `type` is the record type the tab lists. */
export interface SectionTab {
    readonly id: string;
    readonly type?: string;
}

/** Tabs a framework section carries (web sections.js FRAMEWORK_TABS). */
const FRAMEWORK_TABS: readonly string[] = ['checks', 'timeline', 'evidence'];

/** The section's header tabs, in order; [] for a section with one page. */
export function tabsOfSection(section: ComplianceSection): SectionTab[] {
    if (section.view === 'checks') {
        return [...FRAMEWORK_TABS, ...(section.id === 'aia' ? ['systems'] : [])].map((id) => ({ id }));
    }
    if (section.id === 'dsr') return [{ id: 'requests', type: 'dsr' }, { id: 'public_form' }];
    if (section.id === 'soa') return [{ id: 'controls', type: 'soa' }, { id: 'history' }];
    if (section.view === 'records') return (section.types ?? []).map((type) => ({ id: type, type }));
    return [];
}

/** Sections whose tabs have a web label key (`compliance.tab_<section>_<tab>`). */
const WEB_TAB_KEYS: ReadonlySet<string> = new Set(['dsr', 'soa', 'audits']);

/** A tab's label: the web key where the web has the tab, else the record type's plural. */
export function tabLabel(sectionId: string, tabId: string): Label {
    const section = sectionById(sectionId);
    const tab = section ? tabsOfSection(section).find((t) => t.id === tabId) : undefined;
    const type = tab?.type ? recordType(tab.type) : null;
    if (section && (section.view === 'checks' || WEB_TAB_KEYS.has(section.id))) {
        return { i18nKey: `compliance.tab_${section.id}_${tabId}`, en: type?.plural.en ?? TAB_EN[tabId] ?? tabId };
    }
    return type ? type.plural : { i18nKey: `compliance.tab_${sectionId}_${tabId}`, en: TAB_EN[tabId] ?? tabId };
}

const TAB_EN: Readonly<Record<string, string>> = {
    checks: 'Checks',
    timeline: 'Timeline',
    evidence: 'Evidence',
    systems: 'Systems',
    requests: 'Requests',
    public_form: 'Public form',
    controls: 'Controls',
    history: 'History',
};

/** Hub pages that are not a section: never a section id or alias. */
export const HUB_PAGES = ['calendar', 'setup', 'chat_signals'] as const;
export type HubPage = (typeof HUB_PAGES)[number];

/** Where a moved tab went: another section (and tab), or a hub page. */
export interface MovedTab {
    readonly section?: string;
    readonly tab?: string;
    readonly page?: HubPage;
}

/**
 * Tabs that no longer live on their section (web sections.js legacyTabs). The
 * phone has no overview calendar tab: it is the calendar page; and the
 * obligations open on their own tab of Training.
 */
export const LEGACY_TABS: Readonly<Record<string, Readonly<Record<string, MovedTab>>>> = {
    overview: { calendar: { page: 'calendar' } },
    frameworks: { calendar: { page: 'calendar' }, per_automation: { section: 'aia', tab: 'systems' } },
    dsr: { settings: { section: 'settings' } },
    soa: { export: { section: 'soa', tab: 'controls' } },
    audits: { obligations: { section: 'training', tab: 'obligations' } },
};

export interface ResolvedTab {
    section: string;
    tab: string | null;
    page: HubPage | null;
}

/** Where `?tab=<tab>` on a section lands (web sections.js resolveTab / movedTab). */
export function resolveTab(sectionId: string, tab: string | null | undefined): ResolvedTab {
    const section = sectionById(sectionId)?.id ?? 'overview';
    const map = LEGACY_TABS[section];
    const moved = tab && map && Object.prototype.hasOwnProperty.call(map, tab) ? map[tab] : undefined;
    if (!moved) return { section, tab: tab || null, page: null };
    return { section: sectionById(moved.section)?.id ?? section, tab: moved.tab ?? null, page: moved.page ?? null };
}

/** A hub page's route (model/navigation.ts HUB_ROUTE + the page id). */
export function pageRoute(id: HubPage): string {
    return `/org/compliance/${id}`;
}

export function isHubPage(id: unknown): id is HubPage {
    return typeof id === 'string' && (HUB_PAGES as readonly string[]).includes(id);
}

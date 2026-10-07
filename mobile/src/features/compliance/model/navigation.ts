/**
 * Where a tap in the hub goes, and the downloads its Reports group offers.
 *
 * The server computes attention and deadline targets as web paths
 * (`/app/admin/compliance/<section>[/<id>][?tab=]`, utils/appPaths.js); the
 * phone maps them onto its own routes (parseTarget), moved tabs included.
 */

import { COMPLIANCE } from './paths';
import { isHubPage, pageRoute, resolveTab, sectionById, sectionForRegulation, type HubPage } from './sections';
import type { Download, Label } from './types';

export const HUB_ROUTE = '/org/compliance';

export function sectionRoute(sectionId: string): string {
    return `${HUB_ROUTE}/${encodeURIComponent(sectionId)}`;
}

/** A record's detail: `/org/compliance/<type or section>/<id>`. */
export function recordRoute(typeOrSection: string, id: string): string {
    return `${HUB_ROUTE}/${encodeURIComponent(typeOrSection)}/${encodeURIComponent(id)}`;
}

export interface Target {
    section: string;
    id: string | null;
    /** A tab of the section's page; record routes ignore it. */
    tab?: string | null;
    /** A hub page (calendar, setup…) instead of a section. */
    page?: HubPage | null;
}

const HUB_PATH = /^(?:https?:\/\/[^/]+)?\/?(?:app\/)?admin\/compliance(?:\/([^/?#]+))?(?:\/([^?#]+))?(?:\?([^#]*))?/;

function decoded(raw: string | null | undefined): string | null {
    if (!raw) return null;
    try {
        return decodeURIComponent(raw);
    } catch {
        return raw;
    }
}

function queryParam(query: string | undefined, name: string): string | null {
    if (!query) return null;
    for (const part of query.split('&')) {
        const [key, value] = part.split('=');
        if (key === name && value) return decoded(value.replace(/\+/g, ' '));
    }
    return null;
}

/** A section, id and tab → a Target, with a moved tab resolved (it drops the id, as the web's resolveTarget does). */
function resolved(sectionId: string, id: string | null, tab: string | null): Target | null {
    const section = sectionById(sectionId);
    if (!section) return null;
    const to = resolveTab(section.id, tab);
    if (to.page) return { section: 'overview', id: null, tab: null, page: to.page };
    return { section: to.section, id: to.section === section.id ? id : null, tab: to.tab, page: null };
}

function idOf(value: unknown): string | null {
    if (typeof value === 'string' && value) return value;
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

/**
 * A server target — the web path `/app/admin/compliance/<seg>[/<id>][?tab=..][&id=..]`
 * (utils/appPaths.js; `/app` optional) or a `{ section, id }` object — as a Target.
 * Null for anything that is not the Compliance Center.
 */
export function parseTarget(raw: unknown): Target | null {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const o = raw as Record<string, unknown>;
        if (isHubPage(o.page)) return { section: 'overview', id: null, tab: null, page: o.page };
        const tab = typeof o.tab === 'string' && o.tab ? o.tab : null;
        return typeof o.section === 'string' ? resolved(o.section, idOf(o.id), tab) : null;
    }
    if (typeof raw !== 'string') return null;
    const m = HUB_PATH.exec(raw.trim());
    if (!m) return null;
    const [, segment, rawId, query] = m;
    if (!segment) return { section: 'overview', id: null, tab: null, page: null };
    if (isHubPage(segment)) return { section: 'overview', id: null, tab: null, page: segment };
    return resolved(decoded(segment) ?? '', decoded(rawId) ?? queryParam(query, 'id'), queryParam(query, 'tab'));
}

interface AttentionLike {
    source: string;
    code: string | null;
    id: string;
    meta: { frameworks: readonly { regulation: string | null }[] };
    action: { target: string | null };
}

/** The server's target path, else the section scoring the item. */
export function attentionTarget(item: AttentionLike): Target {
    const parsed = parseTarget(item.action.target);
    if (parsed && (parsed.section !== 'overview' || parsed.page)) return parsed;
    const regulation = item.meta.frameworks[0]?.regulation ?? null;
    return { section: sectionForRegulation(regulation), id: item.source === 'check' ? item.code ?? item.id : null };
}

/** The route a target opens: a hub page, a section's page (on a tab), or one record in it. */
export function targetRoute(target: Target): string {
    if (target.page) return pageRoute(target.page);
    const section = sectionById(target.section);
    if (!section || section.id === 'overview') return HUB_ROUTE;
    if (!target.id) return `${sectionRoute(section.id)}${target.tab ? `?tab=${encodeURIComponent(target.tab)}` : ''}`;
    // A register section's detail route carries its (first) record type.
    const type = section.view === 'records' ? section.types?.[0] ?? section.id : section.id;
    return recordRoute(type, target.id);
}

export interface Report {
    readonly id: string;
    readonly label: Label;
    readonly description: Label;
    readonly download: Download;
    readonly iso?: boolean;
    /** The Reports tab's group (web ReportsTab REPORT_GROUPS). */
    readonly group: 'core' | 'iso';
}

const pdf = (path: string, fileName: string): Download => ({ path: `${COMPLIANCE}${path}`, fileName, mimeType: 'application/pdf' });

/** Overview › Reports (web: pages/overview/ReportsTab REPORT_GROUPS). */
export const REPORTS: readonly Report[] = [
    { id: 'report', group: 'core', label: { i18nKey: 'compliance.ovw_dl_report', en: 'Compliance report (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_report_desc', en: 'Scores, the verification split and every check with its latest result and evidence hash.' }, download: pdf('/report.pdf', 'compliance-report.pdf') },
    { id: 'ropa', group: 'core', label: { i18nKey: 'compliance.ovw_dl_ropa', en: 'Records of processing (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_ropa_desc', en: 'Art. 30 register: activities, processors and transfer safeguards.' }, download: pdf('/ropa.pdf', 'ropa.pdf') },
    { id: 'soa', iso: true, group: 'iso', label: { i18nKey: 'compliance.ovw_dl_soa', en: 'Statement of Applicability (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_soa_desc', en: 'All 93 Annex A controls with their decision and justification.' }, download: pdf('/iso/soa.pdf', 'soa.pdf') },
    { id: 'clauses', iso: true, group: 'iso', label: { i18nKey: 'compliance.ovw_dl_clauses', en: 'Clause conformity (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_clauses_desc', en: 'Clauses 4–10 with the records that evidence each one.' }, download: pdf('/iso/clause-conformity.pdf', 'clause-conformity.pdf') },
    { id: 'risks', iso: true, group: 'iso', label: { i18nKey: 'compliance.ovw_dl_risks', en: 'Risk register (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_risks_desc', en: 'Risks, scores and treatment plans.' }, download: pdf('/iso/risks.pdf', 'risks.pdf') },
    { id: 'policies', iso: true, group: 'iso', label: { i18nKey: 'compliance.ovw_dl_policies', en: 'Policy pack (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_policies_desc', en: 'Every published ISMS document in one file.' }, download: pdf('/iso/policy-pack.pdf', 'policy-pack.pdf') },
    { id: 'bundle', iso: true, group: 'iso', label: { i18nKey: 'compliance.ovw_dl_bundle', en: 'Evidence bundle (ZIP)' }, description: { i18nKey: 'compliance.ovw_dl_bundle_desc', en: 'The pack above plus the hashed evidence rows behind it.' }, download: { path: `${COMPLIANCE}/iso/evidence-bundle.zip`, fileName: 'evidence-bundle.zip', mimeType: 'application/zip' } },
];

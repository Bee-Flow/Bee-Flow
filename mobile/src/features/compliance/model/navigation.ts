/**
 * Where a tap in the hub goes, and the downloads its Reports group offers.
 *
 * The server computes attention targets as web paths
 * (`/app/admin/compliance/<section>[/<id>]`, utils/appPaths.js); the phone
 * maps the section onto its own route, exactly as the web's phone frame does
 * (mobile/MobileHomeOverview.attentionTarget).
 */

import { COMPLIANCE } from './paths';
import { sectionById, sectionForRegulation } from './sections';
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
}

interface AttentionLike {
    source: string;
    code: string | null;
    id: string;
    meta: { frameworks: readonly { regulation: string | null }[] };
    action: { target: string | null };
}

/** `{ section, id }` from the server's target path, else the section scoring the item. */
export function attentionTarget(item: AttentionLike): Target {
    const target = item.action.target;
    if (target) {
        const segs = target.split('?')[0]?.replace(/^\/+/, '').split('/') ?? [];
        const i = segs.indexOf('compliance');
        const section = i >= 0 ? sectionById(segs[i + 1]) : null;
        if (section) {
            const raw = segs[i + 2];
            let id: string | null = raw ?? null;
            if (id) {
                try {
                    id = decodeURIComponent(id);
                } catch {
                    // keep the raw segment
                }
            }
            return { section: section.id, id };
        }
    }
    const regulation = item.meta.frameworks[0]?.regulation ?? null;
    return { section: sectionForRegulation(regulation), id: item.source === 'check' ? item.code ?? item.id : null };
}

/** The route a target opens: a section's page, or one record in it. */
export function targetRoute(target: Target): string {
    const section = sectionById(target.section);
    if (!section || section.id === 'overview') return HUB_ROUTE;
    if (!target.id) return sectionRoute(section.id);
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
}

const pdf = (path: string, fileName: string): Download => ({ path: `${COMPLIANCE}${path}`, fileName, mimeType: 'application/pdf' });

/** Overview › Reports (web: pages/overview/ReportsTab REPORT_GROUPS). */
export const REPORTS: readonly Report[] = [
    { id: 'report', label: { i18nKey: 'compliance.ovw_dl_report', en: 'Compliance report (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_report_desc', en: 'Scores, the verification split and every check with its latest result and evidence hash.' }, download: pdf('/report.pdf', 'compliance-report.pdf') },
    { id: 'ropa', label: { i18nKey: 'compliance.ovw_dl_ropa', en: 'Records of processing (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_ropa_desc', en: 'Art. 30 register: activities, processors and transfer safeguards.' }, download: pdf('/ropa.pdf', 'ropa.pdf') },
    { id: 'soa', iso: true, label: { i18nKey: 'compliance.ovw_dl_soa', en: 'Statement of Applicability (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_soa_desc', en: 'All 93 Annex A controls with their decision and justification.' }, download: pdf('/iso/soa.pdf', 'soa.pdf') },
    { id: 'clauses', iso: true, label: { i18nKey: 'compliance.ovw_dl_clauses', en: 'Clause conformity (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_clauses_desc', en: 'Clauses 4–10 with the records that evidence each one.' }, download: pdf('/iso/clause-conformity.pdf', 'clause-conformity.pdf') },
    { id: 'risks', iso: true, label: { i18nKey: 'compliance.ovw_dl_risks', en: 'Risk register (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_risks_desc', en: 'Risks, scores and treatment plans.' }, download: pdf('/iso/risks.pdf', 'risks.pdf') },
    { id: 'policies', iso: true, label: { i18nKey: 'compliance.ovw_dl_policies', en: 'Policy pack (PDF)' }, description: { i18nKey: 'compliance.ovw_dl_policies_desc', en: 'Every published ISMS document in one file.' }, download: pdf('/iso/policy-pack.pdf', 'policy-pack.pdf') },
    { id: 'bundle', iso: true, label: { i18nKey: 'compliance.ovw_dl_bundle', en: 'Evidence bundle (ZIP)' }, description: { i18nKey: 'compliance.ovw_dl_bundle_desc', en: 'The pack above plus the hashed evidence rows behind it.' }, download: { path: `${COMPLIANCE}/iso/evidence-bundle.zip`, fileName: 'evidence-bundle.zip', mimeType: 'application/zip' } },
];

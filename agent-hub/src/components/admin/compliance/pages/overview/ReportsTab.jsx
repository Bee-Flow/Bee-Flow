import React from 'react';
import { FileDown, FileArchive, ShieldCheck, Scale } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * ReportsTab — Overview › Reports (C6). One place for every PDF/ZIP the hub
 * can hand an auditor; it replaces `IsoOverviewPage`'s five export links plus
 * the old header `report.pdf` and the ROPA page's `ropa.pdf`.
 *
 * Every href goes through `dl(url)` (the public-demo seam: it returns null
 * when downloads are off). When `exportsEnabled` is false the tab renders one
 * sentence and no links at all — a dead download button is worse than none.
 *
 *   api             API base ('/api/compliance')
 *   dl(url)         → url | null
 *   exportsEnabled  licence/demo gate
 *   isoEnabled      true | false | null (null = framework list not loaded →
 *                   the ISO group is shown, because hiding a working export on
 *                   an unknown state is the worse mistake)
 */
export const REPORT_GROUPS = Object.freeze([
    Object.freeze({
        id: 'compliance',
        icon: Scale,
        titleKey: 'compliance.ovw_reports_group_core', titleEn: 'Compliance',
        items: Object.freeze([
            Object.freeze({
                id: 'report', path: '/report.pdf', kind: 'pdf',
                labelKey: 'compliance.ovw_dl_report', labelEn: 'Compliance report (PDF)',
                descKey: 'compliance.ovw_dl_report_desc', descEn: 'Scores, the verification split and every check with its latest result and evidence hash.',
            }),
            Object.freeze({
                id: 'ropa', path: '/ropa.pdf', kind: 'pdf',
                labelKey: 'compliance.ovw_dl_ropa', labelEn: 'Records of processing (PDF)',
                descKey: 'compliance.ovw_dl_ropa_desc', descEn: 'Art. 30 register: activities, processors and transfer safeguards.',
            }),
        ]),
    }),
    Object.freeze({
        id: 'iso',
        icon: ShieldCheck,
        titleKey: 'compliance.ovw_reports_group_iso', titleEn: 'ISO 27001 — Stage 1 pack',
        iso: true,
        items: Object.freeze([
            Object.freeze({
                id: 'soa', path: '/iso/soa.pdf', kind: 'pdf',
                labelKey: 'compliance.ovw_dl_soa', labelEn: 'Statement of Applicability (PDF)',
                descKey: 'compliance.ovw_dl_soa_desc', descEn: 'All 93 Annex A controls with their decision and justification.',
            }),
            Object.freeze({
                id: 'clauses', path: '/iso/clause-conformity.pdf', kind: 'pdf',
                labelKey: 'compliance.ovw_dl_clauses', labelEn: 'Clause conformity (PDF)',
                descKey: 'compliance.ovw_dl_clauses_desc', descEn: 'Clauses 4–10 with the records that evidence each one.',
            }),
            Object.freeze({
                id: 'risks', path: '/iso/risks.pdf', kind: 'pdf',
                labelKey: 'compliance.ovw_dl_risks', labelEn: 'Risk register (PDF)',
                descKey: 'compliance.ovw_dl_risks_desc', descEn: 'Risks, scores and treatment plans.',
            }),
            Object.freeze({
                id: 'policies', path: '/iso/policy-pack.pdf', kind: 'pdf',
                labelKey: 'compliance.ovw_dl_policies', labelEn: 'Policy pack (PDF)',
                descKey: 'compliance.ovw_dl_policies_desc', descEn: 'Every published ISMS document in one file.',
            }),
            Object.freeze({
                id: 'bundle', path: '/iso/evidence-bundle.zip', kind: 'zip',
                labelKey: 'compliance.ovw_dl_bundle', labelEn: 'Evidence bundle (ZIP)',
                descKey: 'compliance.ovw_dl_bundle_desc', descEn: 'The pack above plus the hashed evidence rows behind it.',
            }),
        ]),
    }),
]);

export default function ReportsTab({ api = '/api/compliance', dl, exportsEnabled = true, isoEnabled = null, className = '', testId = 'ovw-reports' }) {
    const { t } = useTranslation();

    if (!exportsEnabled) {
        return (
            <p className={`text-xs text-[var(--text-tertiary)] ${className}`} data-testid={`${testId}-disabled`}>
                {t('compliance.ovw_reports_disabled', 'Downloads are switched off in this workspace.')}
            </p>
        );
    }

    const groups = REPORT_GROUPS.filter(g => !g.iso || isoEnabled !== false);

    return (
        <div className={`flex flex-col gap-3 ${className}`} data-testid={testId}>
            {groups.map(group => {
                const Icon = group.icon;
                const links = group.items
                    .map(item => ({ item, href: typeof dl === 'function' ? dl(`${api}${item.path}`) : `${api}${item.path}` }))
                    .filter(l => !!l.href);
                if (!links.length) return null;
                return (
                    <section
                        key={group.id}
                        className="flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3.5"
                        style={{ boxShadow: 'var(--shadow-sm)' }}
                        data-testid={`${testId}-group-${group.id}`}
                        aria-label={t(group.titleKey, group.titleEn)}
                    >
                        <header className="flex items-center gap-2">
                            <Icon size={14} style={{ color: 'var(--kind-compliance)' }} aria-hidden />
                            <h3 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{t(group.titleKey, group.titleEn)}</h3>
                        </header>
                        <ul className="m-0 mt-1 list-none p-0">
                            {links.map(({ item, href }) => (
                                <li
                                    key={item.id}
                                    className="flex flex-wrap items-center gap-3 border-t border-[var(--border-default)] py-2.5 first:border-t-0"
                                    data-testid={`${testId}-row`}
                                    data-report={item.id}
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="text-xs font-medium text-[var(--text-primary)]">{t(item.labelKey, item.labelEn)}</div>
                                        <div className="mt-0.5 text-[11px] text-[var(--text-tertiary)]">{t(item.descKey, item.descEn)}</div>
                                    </div>
                                    <a
                                        href={href}
                                        download
                                        className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-1.5 text-[12px] font-medium text-[var(--text-primary)] no-underline hover:bg-[var(--bg-secondary)]"
                                        data-testid={`${testId}-dl-${item.id}`}
                                    >
                                        {item.kind === 'zip'
                                            ? <FileArchive size={13} aria-hidden />
                                            : <FileDown size={13} aria-hidden />}
                                        {t('compliance.ovw_download', 'Download')}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
            <p className="text-[11px] leading-relaxed text-[var(--text-tertiary)]" data-testid={`${testId}-note`}>
                {t('compliance.ovw_reports_note', 'PDF and JSON only — a CSV of personal data is not an export this product offers.')}
            </p>
        </div>
    );
}

import { Building2, FileText, Landmark, Siren, Users, type LucideIcon } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { DrawerSection as DrawerSectionJs } from '../../../../shared/SideDrawer';
import { useDateFormat } from '../../shared/formatDates';
import { reportingRowsOf } from './incidentClocks';

// A .jsx export whose `= null` defaults would type its props as null-only.
const DrawerSection = DrawerSectionJs as unknown as ComponentType<{ label?: ReactNode; hint?: ReactNode; className?: string; testId?: string; children?: ReactNode }>;

/**
 * The incident drawer's reporting block, in two parts:
 *
 *   ReportingList  ONE "Reporting" list: per stage its label, its due date,
 *                  and either "filed {date} · ref …" in success ink, "due
 *                  {date}", or "not filed (decision logged)" for a closed
 *                  incident that was deliberately not notified. It replaced
 *                  a "Clocks" list and a "Stamps" list that said the same
 *                  facts twice (and the header a third time).
 *   StepAction     one filing step (incidentClocks.stepsOf). The step of the
 *                  running stage is the drawer's primary button, directly
 *                  under the clock, with the fields it records (the authority
 *                  reference, the CRA channel and reference). Any other step
 *                  is a secondary button; one with fields opens them inline
 *                  first, so every step stays one click away.
 *
 * Reporting is an attestation: the organisation files with the authority
 * itself; Bee Flow records that it did, when, and the reference.
 */

export type StepId = 'authority' | 'cra_early_warning' | 'cra_notification' | 'cra_final_report' | 'customers' | 'subjects';

export interface StepFields {
    authority_reference?: string;
    reported_via?: string;
    reference?: string;
}

interface StepMeta {
    icon: LucideIcon;
    key: string;
    en: string;
    /** The button's test id after the drawer's own (`inc-drawer-<id>`). */
    id: string;
    fields: 'authority' | 'cra' | null;
}

const STEP_META: Readonly<Record<StepId, StepMeta>> = Object.freeze({
    authority: { icon: Landmark, key: 'compliance.inc_record_authority', en: 'Record authority notification', id: 'authority', fields: 'authority' },
    cra_early_warning: { icon: Siren, key: 'compliance.vuln_report_early', en: 'Report early warning', id: 'cra-early', fields: 'cra' },
    cra_notification: { icon: FileText, key: 'compliance.vuln_report_full', en: 'Report full', id: 'cra-full', fields: 'cra' },
    cra_final_report: { icon: FileText, key: 'compliance.vuln_report_final', en: 'Report final report', id: 'cra-full', fields: 'cra' },
    customers: { icon: Building2, key: 'compliance.vuln_customer_notified', en: 'Customer notified', id: 'cra-customers', fields: null },
    subjects: { icon: Users, key: 'compliance.inc_record_subjects', en: 'Record data-subject notification', id: 'subjects', fields: null },
});

/** Steps that go through the CRA / customer-notice routes, which an older server answers with 404. */
export function usesCraRoute(step: StepId): boolean {
    return step.startsWith('cra_') || step === 'customers';
}

export const INPUT = 'w-full rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]';
export const SECONDARY_BUTTON = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--item-hover-bg)]';
export const PRIMARY_BUTTON = 'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-[10px] text-[12px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:brightness-110 transition disabled:opacity-50 disabled:cursor-not-allowed';

export interface StepActionProps {
    step: StepId;
    primary?: boolean;
    busy?: boolean;
    onRun: (step: StepId, fields: StepFields) => unknown;
    testId: string;
}

export function StepAction({ step, primary = false, busy = false, onRun, testId }: StepActionProps) {
    const { t } = useTranslation();
    const meta = STEP_META[step];
    const [open, setOpen] = useState(primary);
    const [fields, setFields] = useState<StepFields>({});
    const firstField = useRef<HTMLInputElement>(null);
    const Icon = meta.icon;
    // A secondary step that opens its fields hands focus to the first one:
    // the button that was pressed is gone from the page.
    useEffect(() => {
        if (open && !primary) firstField.current?.focus();
    }, [open, primary]);
    const label = t(meta.key, meta.en);
    const set = (patch: StepFields) => setFields((f) => ({ ...f, ...patch }));
    const run = () => onRun(step, fields);

    const button = (
        <button type="button" disabled={busy} onClick={run} className={primary ? `${PRIMARY_BUTTON} w-full` : SECONDARY_BUTTON} data-testid={`${testId}-${meta.id}`}>
            <Icon size={13} aria-hidden="true" />{label}
        </button>
    );
    if (!meta.fields) return button;

    if (!primary && !open) {
        return (
            <button type="button" disabled={busy} onClick={() => setOpen(true)} aria-expanded={false} className={SECONDARY_BUTTON} data-testid={`${testId}-${meta.id}-open`}>
                <Icon size={13} aria-hidden="true" />{label}…
            </button>
        );
    }

    return (
        <div className={`flex flex-col gap-2 ${primary ? '' : 'basis-full'}`}>
            {meta.fields === 'authority' ? (
                <input
                    ref={firstField}
                    value={fields.authority_reference ?? ''}
                    onChange={(e) => set({ authority_reference: e.target.value })}
                    placeholder={t('compliance.inc_authority_ref_ph', 'Authority case/reference number (optional)')}
                    aria-label={t('compliance.inc_authority_ref_ph', 'Authority case/reference number (optional)')}
                    className={INPUT}
                    data-testid={`${testId}-authority-ref`}
                />
            ) : (
                <div className="flex flex-wrap gap-2">
                    <input
                        ref={firstField}
                        value={fields.reported_via ?? ''}
                        onChange={(e) => set({ reported_via: e.target.value })}
                        placeholder={t('compliance.vuln_reported_via_ph', 'Reported via (ENISA platform, CSIRT…)')}
                        aria-label={t('compliance.vuln_reported_via_ph', 'Reported via (ENISA platform, CSIRT…)')}
                        className={`${INPUT} flex-1 min-w-[140px]`}
                        data-testid={`${testId}-cra-via`}
                    />
                    <input
                        value={fields.reference ?? ''}
                        onChange={(e) => set({ reference: e.target.value })}
                        placeholder={t('compliance.vuln_reference_ph', 'Reference (optional)')}
                        aria-label={t('compliance.vuln_reference_ph', 'Reference (optional)')}
                        className={`${INPUT} flex-1 min-w-[120px]`}
                        data-testid={`${testId}-cra-ref`}
                    />
                </div>
            )}
            {primary ? button : (
                <div className="flex gap-2">
                    {button}
                    <button type="button" className={SECONDARY_BUTTON} onClick={() => { setOpen(false); setFields({}); }}>{t('common.cancel', 'Cancel')}</button>
                </div>
            )}
        </div>
    );
}

export function ReportingList({ incident, testId }: { incident: Record<string, unknown>; testId: string }) {
    const { t } = useTranslation();
    const { formatDayTime } = useDateFormat();
    const rows = reportingRowsOf(incident);
    if (!rows.length) return null;
    const quiet = 'text-[var(--text-tertiary)]';
    return (
        <DrawerSection label={t('compliance.inc_reporting', 'Reporting')} testId={`${testId}-reporting`}>
            <ul className="m-0 p-0 list-none flex flex-col gap-1.5 text-[11px]">
                {rows.map((r) => {
                    const due = r.dueAt ? t('compliance.inc_stage_due', 'due {date}', { date: formatDayTime(r.dueAt) }) : null;
                    let status: string;
                    let ink = quiet;
                    if (r.filedAt) {
                        status = [
                            t('compliance.inc_stage_filed', 'filed {date}', { date: formatDayTime(r.filedAt) }),
                            r.via,
                            r.reference ? t('compliance.inc_stage_ref', 'ref {ref}', { ref: r.reference }) : null,
                        ].filter(Boolean).join(' · ');
                        ink = 'text-[var(--success-ink)]';
                    } else if (r.notFiled && r.id !== 'recipients') {
                        status = t('compliance.inc_stage_not_filed', 'not filed (decision logged)');
                    } else {
                        status = due ?? '—';
                    }
                    const dueUnder = due && (r.filedAt || r.notFiled);
                    return (
                        <li key={r.id} className="flex items-start justify-between gap-3" data-stage={r.id} data-filed={r.filedAt ? 'true' : 'false'} data-not-filed={r.notFiled ? 'true' : undefined}>
                            <span className="min-w-0 flex flex-col">
                                <span className="text-[var(--text-secondary)]">{t(r.labelKey, r.fallback)}</span>
                                {dueUnder && <span className={`text-[10px] tabular-nums ${quiet}`}>{due}</span>}
                            </span>
                            <span className={`text-right tabular-nums [overflow-wrap:anywhere] ${ink}`}>{status}</span>
                        </li>
                    );
                })}
            </ul>
        </DrawerSection>
    );
}

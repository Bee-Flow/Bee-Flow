import { CheckCircle2, Mail, Play } from 'lucide-react';
import React, { useState } from 'react';
import { clocksOf, isVulnerability, stepsOf } from './incidentClocks';
import { INPUT, ReportingList, SECONDARY_BUTTON, StepAction, usesCraRoute } from './IncidentReporting';
import { IncidentClock, IncidentStatusPill, incidentRef } from './IncidentsTable';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerFooter, DrawerSection, DrawerId } from '../../../../shared/SideDrawer';
import { useDateFormat } from '../../shared/formatDates';
import SeverityTag from '../../shared/SeverityTag';

/**
 * IncidentDrawer — one row of the incident / vulnerability register.
 *
 * Top to bottom: the running clock; directly under it the NEXT filing step
 * as the primary button (record the authority notification, report the CRA
 * early warning or full report, stamp the customer notice; incidentClocks
 * stepsOf); one "Reporting" list of every stage (IncidentReporting); the
 * other actions (start the assessment, notify the configured breach
 * recipients, the remaining filing steps); the editable facts; the log.
 * "Close incident" is last, a secondary in the footer: while a stage is
 * still unfiled it asks why the authority was not notified (Art. 33(5): the
 * controller documents every breach, notified or not) and sends that as the
 * PATCH's `note`. Save appears in the footer only while the facts are edited.
 *
 * Reporting is an attestation: the org files with the authority itself; Bee
 * Flow records that it did, when, and the reference. On a server without the
 * CRA routes (404) those steps stay, disabled, with a sentence saying so —
 * never a silent no-op.
 *
 * props: incident, busy, onUpdate(id, patch), onNotify(id), onCraReport(id, body), onCustomerNotified(id),
 *        craUnavailable (bool), onClose, mode, testId
 */
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

export default function IncidentDrawer({
    incident, busy = false, onUpdate, onNotify, onCraReport, onCustomerNotified, craUnavailable = false, onClose, mode = 'inline', testId = 'inc-drawer',
}) {
    const { t } = useTranslation();
    const { formatDayTime } = useDateFormat();
    const [draft, setDraft] = useState(() => draftOf(incident));
    const [closing, setClosing] = useState(false);
    const [closeReason, setCloseReason] = useState('');
    // A fresh draft when another incident opens or this one changed on the
    // server — during render, so typing is never reset by a parent re-render.
    const incidentKey = `${incident?.id}:${incident?.updated_at}:${incident?.status}`;
    const [seenIncident, setSeenIncident] = useState(incidentKey);
    if (seenIncident !== incidentKey) {
        setSeenIncident(incidentKey);
        setDraft(draftOf(incident)); setClosing(false); setCloseReason('');
    }

    if (!incident) return null;
    const vuln = isVulnerability(incident);
    const closed = incident.status === 'closed';
    const patch = (p) => setDraft(d => ({ ...d, ...p }));
    const dirty = draft.title !== (incident.title || '') || draft.description !== (incident.description || '')
        || draft.severity !== (incident.severity || 'medium') || !!draft.high_risk !== !!incident.high_risk;
    const steps = stepsOf(incident);
    // Closing while a stage is unfiled is the Art. 33(5) decision not to notify: it needs its reason.
    const needsReason = clocksOf(incident).some(c => !c.sentAt);

    const runStep = (step, fields) => {
        if (step === 'authority') return onUpdate?.(incident.id, { status: 'authority_notified', authority_reference: fields.authority_reference?.trim() || undefined });
        if (step === 'subjects') return onUpdate?.(incident.id, { status: 'subjects_notified' });
        if (step === 'customers') return onCustomerNotified?.(incident.id);
        return onCraReport?.(incident.id, craBody(step.replace(/^cra_/, ''), fields));
    };
    const stepBusy = (step) => busy || (craUnavailable && usesCraRoute(step));
    const close = (note) => onUpdate?.(incident.id, { status: 'closed', note });

    const header = (
        <div className="flex items-center gap-2 min-w-0">
            <DrawerId>{incidentRef(incident)}</DrawerId>
            <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{incident.title}</span>
            {!closed && incident.severity && <SeverityTag severity={incident.severity} vocabulary="incident" testId={`${testId}-severity`} />}
            <IncidentStatusPill status={incident.status} testId={`${testId}-status`} />
        </div>
    );

    const save = dirty ? { onPrimary: () => onUpdate?.(incident.id, savePatch(draft, vuln)), primaryDisabled: busy || !draft.title.trim() } : {};
    const closeLabel = vuln ? t('compliance.vuln_close_reason', 'Why was it not reported? (CRA Art. 14)') : t('compliance.inc_close_reason', 'Why was the authority not notified? (Art. 33(5))');
    const footer = (closed && !dirty) ? null : (
        <>
            {closing && (
                <div className="flex flex-col gap-1.5" data-testid={`${testId}-close-form`}>
                    <label className="text-[11px] text-[var(--text-secondary)]" htmlFor={`${testId}-close-reason`}>{closeLabel}</label>
                    <textarea id={`${testId}-close-reason`} rows={2} value={closeReason} onChange={e => setCloseReason(e.target.value)} className={`${INPUT} resize-y`} data-testid={`${testId}-close-reason`} />
                    <div className="flex gap-2">
                        <button type="button" className={SECONDARY_BUTTON} disabled={busy || !closeReason.trim()} onClick={() => close(closeReason.trim())} data-testid={`${testId}-close-confirm`}>
                            <CheckCircle2 size={13} aria-hidden="true" />{t('compliance.inc_close', 'Close incident')}
                        </button>
                        <button type="button" className={SECONDARY_BUTTON} onClick={() => { setClosing(false); setCloseReason(''); }}>{t('common.cancel', 'Cancel')}</button>
                    </div>
                </div>
            )}
            <DrawerFooter testId={`${testId}-foot`} {...save}>
                {!closed && !closing && (
                    <button
                        type="button"
                        disabled={busy}
                        className={SECONDARY_BUTTON}
                        aria-expanded={needsReason ? false : undefined}
                        onClick={() => (needsReason ? setClosing(true) : close(t('compliance.inc_closed_note', 'Closed after assessment.')))}
                        data-testid={`${testId}-close-incident`}
                    >
                        <CheckCircle2 size={13} aria-hidden="true" />{t('compliance.inc_close', 'Close incident')}
                    </button>
                )}
            </DrawerFooter>
        </>
    );

    const others = steps.others;
    const hasActions = !closed && (incident.status === 'open' || !incident.recipients_notified_at || others.length > 0);

    return (
        <SideDrawer open onClose={onClose} header={header} footer={footer} mode={mode} ariaLabel={t(vuln ? 'compliance.vuln_drawer_aria' : 'compliance.inc_drawer_aria', vuln ? 'Vulnerability' : 'Incident')} testId={testId}>
            <IncidentClock incident={incident} variant="block" testId={`${testId}-clock`} />

            {steps.primary && (
                <div className="flex flex-col gap-2" data-testid={`${testId}-next`}>
                    <StepAction key={`${incidentKey}:${steps.primary}:primary`} step={steps.primary} primary busy={stepBusy(steps.primary)} onRun={runStep} testId={testId} />
                    {craUnavailable && (
                        <p className="m-0 text-[11px] text-[var(--warning-ink)]" data-testid={`${testId}-cra-unavailable`}>
                            {t('compliance.vuln_reporting_unavailable', 'CRA reporting is not available on this server yet — record the stamps once it is updated.')}
                        </p>
                    )}
                    {steps.primary.startsWith('cra_') && (
                        <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                            {t('compliance.vuln_attestation_note', 'Reporting is an attestation: your organisation files on the ENISA single reporting platform itself; Bee Flow records the stage, the channel and the reference — never the vulnerability details.')}
                        </p>
                    )}
                    {steps.primary === 'authority' && (
                        <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                            {t('compliance.inc_attestation_note', '"Record authority notification" is an attestation: your organisation files with the supervisory authority itself; Bee Flow only records that it was done, by whom and when.')}
                        </p>
                    )}
                </div>
            )}

            <ReportingList incident={incident} testId={testId} />

            {vuln && (
                <DrawerSection label={t('compliance.vuln_details', 'Vulnerability')}>
                    <div className="text-[11px] text-[var(--text-secondary)] flex flex-col gap-1">
                        <div className="font-mono">{Array.isArray(incident.cve_ids) && incident.cve_ids.length ? incident.cve_ids.join(' · ') : t('compliance.vuln_no_cve', 'no CVE id yet')}</div>
                        {incident.exploited_in_wild != null && (
                            <div className={incident.exploited_in_wild ? 'text-[var(--error-ink)]' : ''}>
                                {incident.exploited_in_wild ? t('compliance.vuln_exploited_long', 'Actively exploited — CRA Art. 14(1)') : t('compliance.vuln_not_exploited', 'No active exploitation known')}
                            </div>
                        )}
                        {Array.isArray(incident.affected_products) && incident.affected_products.length > 0 && (
                            <div>{t('compliance.vuln_affected', 'Affects')}: {incident.affected_products.map(p => [p.name, p.version_range].filter(Boolean).join(' ')).join(', ')}</div>
                        )}
                    </div>
                </DrawerSection>
            )}

            {hasActions && (
                <DrawerSection label={t('compliance.inc_actions', 'Actions')} testId={`${testId}-actions`}>
                    <div className="flex flex-wrap gap-2">
                        {incident.status === 'open' && (
                            <button type="button" disabled={busy} className={SECONDARY_BUTTON} onClick={() => onUpdate?.(incident.id, { status: 'assessing' })} data-testid={`${testId}-assess`}>
                                <Play size={13} aria-hidden="true" />{t('compliance.inc_start_assess', 'Start assessment')}
                            </button>
                        )}
                        {!incident.recipients_notified_at && (
                            <button type="button" disabled={busy} className={SECONDARY_BUTTON} onClick={() => onNotify?.(incident.id)} data-testid={`${testId}-notify`}>
                                <Mail size={13} aria-hidden="true" />{t('compliance.inc_notify_recipients', 'Notify breach recipients')}
                            </button>
                        )}
                        {others.map(step => (
                            <StepAction key={`${incidentKey}:${step}`} step={step} busy={stepBusy(step)} onRun={runStep} testId={testId} />
                        ))}
                    </div>
                </DrawerSection>
            )}

            <DrawerSection label={t('compliance.inc_f_title', 'What happened?')}>
                <input value={draft.title} onChange={e => patch({ title: e.target.value })} aria-label={t('compliance.inc_f_title', 'What happened?')} className={INPUT} data-testid={`${testId}-title`} />
                <textarea value={draft.description} rows={3} onChange={e => patch({ description: e.target.value })} aria-label={t('compliance.inc_f_desc', 'Details')} placeholder={t('compliance.inc_f_desc_ph', 'What data, how many people, how discovered, first containment steps…')} className={`${INPUT} resize-y`} data-testid={`${testId}-description`} />
                <div className="flex items-center gap-3 flex-wrap">
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {t('compliance.inc_f_severity', 'Severity')}
                        <select value={draft.severity} onChange={e => patch({ severity: e.target.value })} className={`${INPUT} w-auto`} data-testid={`${testId}-severity-select`}>
                            {SEVERITIES.map(s => <option key={s} value={s}>{t(`compliance.inc_sev_${s}`, SEVERITY_EN[s])}</option>)}
                        </select>
                    </label>
                    {!vuln && (
                        <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                            <input type="checkbox" checked={!!draft.high_risk} onChange={e => patch({ high_risk: e.target.checked })} data-testid={`${testId}-high-risk`} />
                            {t('compliance.inc_f_high_risk', 'High risk for the people involved (triggers Art. 34)')}
                        </label>
                    )}
                </div>
            </DrawerSection>

            {Array.isArray(incident.notes) && incident.notes.length > 0 && (
                <DrawerSection label={t('compliance.inc_notes', 'Log')}>
                    <ul className="m-0 p-0 list-none flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
                        {incident.notes.map((n, i) => (
                            <li key={i}><span className="text-[var(--text-tertiary)] tabular-nums">{n.at ? formatDayTime(n.at) : ''}</span> — {n.text}</li>
                        ))}
                    </ul>
                </DrawerSection>
            )}
        </SideDrawer>
    );
}

const SEVERITY_EN = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' });

function draftOf(incident) {
    return {
        title: incident?.title || '',
        description: incident?.description || '',
        severity: incident?.severity || 'medium',
        high_risk: !!incident?.high_risk,
    };
}

/** The PUT body — allow-listed fields only. */
export function savePatch(draft, vuln) {
    const out = {
        title: String(draft.title || '').trim() || undefined,
        description: String(draft.description || '').trim() || null,
        severity: draft.severity,
    };
    if (!vuln) out.high_risk = !!draft.high_risk;
    return out;
}

/**
 * POST /incidents/:id/cra-report body. The route knows two stages:
 * `early_warning` and `full` (the 72 h notification and the final report,
 * which it stamps together); sending the clock's own stage name
 * ('notification', 'final_report') was refused with a 400.
 */
export function craBody(stage, cra) {
    return {
        stage: stage === 'early_warning' ? 'early_warning' : 'full',
        reported_via: String(cra?.reported_via || '').trim() || undefined,
        reference: String(cra?.reference || '').trim() || undefined,
    };
}

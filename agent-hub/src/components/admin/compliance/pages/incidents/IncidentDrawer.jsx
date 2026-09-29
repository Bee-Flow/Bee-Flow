import React, { useState } from 'react';
import { CheckCircle2, Landmark, Mail, Save, Siren, FileText, Building2, Users } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import SideDrawer, { DrawerSection, DrawerId } from '../../../../shared/SideDrawer';
import { PRIMARY_ACTION_STYLE } from '../../../../shared/StudioSectionHeader';
import { TONES } from '../../../../shared/statusTone';
import SeverityTag from '../../shared/SeverityTag';
import { IncidentClock, IncidentStatusPill, incidentRef } from './IncidentsTable';
import { clocksOf, isVulnerability, nextCraStage } from './incidentClocks';

/**
 * IncidentDrawer — one row of the incident / vulnerability register.
 *
 * The GDPR actions are the legacy page's, unchanged in meaning: start the
 * assessment, notify the configured breach recipients (the one e-mail Bee
 * Flow sends), RECORD that the authority / the data subjects were notified
 * (attestations — the org files itself), close. A vulnerability row swaps
 * them for the CRA Art. 14 stages: "Report early warning" / "Report full"
 * (→ `craReport(id, { stage, reported_via, reference })`) and "Customer
 * notified" (→ `customerNotified(id)`). When the server has not shipped
 * those routes yet (404) the buttons stay, disabled, with a sentence saying
 * so — never a silent no-op.
 *
 * props: incident, busy, onUpdate(id, patch), onNotify(id), onCraReport(id, body), onCustomerNotified(id),
 *        craUnavailable (bool), onClose, mode, testId
 */
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

export default function IncidentDrawer({
    incident, busy = false, onUpdate, onNotify, onCraReport, onCustomerNotified, craUnavailable = false, onClose, mode = 'inline', testId = 'inc-drawer',
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(() => draftOf(incident));
    const [authorityRef, setAuthorityRef] = useState('');
    const [cra, setCra] = useState({ reported_via: '', reference: '' });
    // A fresh draft when another incident opens or this one changed on the
    // server — during render, so typing is never reset by a parent re-render.
    const incidentKey = `${incident?.id}:${incident?.updated_at}`;
    const [seenIncident, setSeenIncident] = useState(incidentKey);
    if (seenIncident !== incidentKey) {
        setSeenIncident(incidentKey);
        setDraft(draftOf(incident)); setAuthorityRef(''); setCra({ reported_via: '', reference: '' });
    }

    if (!incident) return null;
    const vuln = isVulnerability(incident);
    const closed = incident.status === 'closed';
    const patch = (p) => setDraft(d => ({ ...d, ...p }));
    const dirty = draft.title !== (incident.title || '') || draft.description !== (incident.description || '')
        || draft.severity !== (incident.severity || 'medium') || !!draft.high_risk !== !!incident.high_risk;

    const header = (
        <div className="flex items-center gap-2 min-w-0">
            <DrawerId>{incidentRef(incident)}</DrawerId>
            <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">{incident.title}</span>
            {!closed && incident.severity && <SeverityTag severity={incident.severity} />}
            <IncidentStatusPill status={incident.status} />
        </div>
    );

    const footer = (
        <button
            type="button"
            disabled={busy || !dirty || !draft.title.trim()}
            onClick={() => onUpdate?.(incident.id, savePatch(draft, vuln))}
            style={PRIMARY_ACTION_STYLE}
            className="w-full h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            data-testid={`${testId}-save`}
        >
            <Save size={13} aria-hidden="true" /> {t('common.save', 'Save')}
        </button>
    );

    const stage = nextCraStage(incident);

    return (
        <SideDrawer open onClose={onClose} header={header} footer={footer} mode={mode} ariaLabel={t(vuln ? 'compliance.vuln_drawer_aria' : 'compliance.inc_drawer_aria', vuln ? 'Vulnerability' : 'Incident')} testId={testId}>
            <IncidentClock incident={incident} variant="block" testId={`${testId}-clock`} />

            <DrawerSection label={t('compliance.inc_clocks', 'Clocks')}>
                <ul className="m-0 p-0 list-none flex flex-col gap-1 text-[11px]" data-testid={`${testId}-clocks`}>
                    {clocksOf(incident).map(c => (
                        <li key={c.stage} className="flex items-center justify-between gap-2" data-stage={c.stage} data-done={c.sentAt ? 'true' : 'false'}>
                            <span className="text-[var(--text-secondary)]">{t(c.labelKey, c.fallback)}</span>
                            <span className="tabular-nums" style={{ color: c.sentAt ? TONES.success.ink : 'var(--text-tertiary)' }}>
                                {c.sentAt ? t('compliance.inc_clock_done_at', 'done {when}', { when: formatStamp(c.sentAt) }) : t('compliance.inc_clock_due_at', 'due {when}', { when: formatStamp(c.dueAt) })}
                            </span>
                        </li>
                    ))}
                </ul>
            </DrawerSection>

            {vuln && (
                <DrawerSection label={t('compliance.vuln_details', 'Vulnerability')}>
                    <div className="text-[11px] text-[var(--text-secondary)] flex flex-col gap-1">
                        <div className="font-mono">{Array.isArray(incident.cve_ids) && incident.cve_ids.length ? incident.cve_ids.join(' · ') : t('compliance.vuln_no_cve', 'no CVE id yet')}</div>
                        {incident.exploited_in_wild != null && (
                            <div style={{ color: incident.exploited_in_wild ? TONES.error.ink : undefined }}>
                                {incident.exploited_in_wild ? t('compliance.vuln_exploited_long', 'Actively exploited — CRA Art. 14(1)') : t('compliance.vuln_not_exploited', 'No active exploitation known')}
                            </div>
                        )}
                        {Array.isArray(incident.affected_products) && incident.affected_products.length > 0 && (
                            <div>{t('compliance.vuln_affected', 'Affects')}: {incident.affected_products.map(p => [p.name, p.version_range].filter(Boolean).join(' ')).join(', ')}</div>
                        )}
                    </div>
                </DrawerSection>
            )}

            <DrawerSection label={t('compliance.inc_f_title', 'What happened?')}>
                <input value={draft.title} onChange={e => patch({ title: e.target.value })} className={INPUT} data-testid={`${testId}-title`} />
                <textarea value={draft.description} rows={3} onChange={e => patch({ description: e.target.value })} placeholder={t('compliance.inc_f_desc_ph', 'What data, how many people, how discovered, first containment steps…')} className={`${INPUT} resize-y`} data-testid={`${testId}-description`} />
                <div className="flex items-center gap-3 flex-wrap">
                    <label className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                        {t('compliance.inc_f_severity', 'Severity')}
                        <select value={draft.severity} onChange={e => patch({ severity: e.target.value })} className={`${INPUT} w-auto`} data-testid={`${testId}-severity`}>
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

            {!closed && (
                <DrawerSection label={t('compliance.inc_actions', 'Actions')} testId={`${testId}-actions`}>
                    <div className="flex flex-wrap gap-2">
                        {incident.status === 'open' && (
                            <Action busy={busy} onClick={() => onUpdate?.(incident.id, { status: 'assessing' })} testId={`${testId}-assess`}>
                                {t('compliance.inc_start_assess', 'Start assessment')}
                            </Action>
                        )}
                        {!incident.recipients_notified_at && (
                            <Action busy={busy} icon={Mail} onClick={() => onNotify?.(incident.id)} testId={`${testId}-notify`}>
                                {t('compliance.inc_notify_recipients', 'Notify breach recipients')}
                            </Action>
                        )}
                        <Action busy={busy} icon={CheckCircle2} onClick={() => onUpdate?.(incident.id, { status: 'closed', note: t('compliance.inc_closed_note', 'Closed after assessment.') })} testId={`${testId}-close-incident`}>
                            {t('compliance.inc_close', 'Close incident')}
                        </Action>
                    </div>

                    {vuln ? (
                        <div className="flex flex-col gap-2" data-testid={`${testId}-cra`}>
                            <div className="flex flex-wrap gap-2">
                                <input value={cra.reported_via} onChange={e => setCra(c => ({ ...c, reported_via: e.target.value }))} placeholder={t('compliance.vuln_reported_via_ph', 'Reported via (ENISA platform, CSIRT…)')} className={`${INPUT} flex-1 min-w-[140px]`} data-testid={`${testId}-cra-via`} />
                                <input value={cra.reference} onChange={e => setCra(c => ({ ...c, reference: e.target.value }))} placeholder={t('compliance.vuln_reference_ph', 'Reference (optional)')} className={`${INPUT} flex-1 min-w-[120px]`} data-testid={`${testId}-cra-ref`} />
                            </div>
                            <div className="flex flex-wrap gap-2">
                                {stage === 'early_warning' && (
                                    <Action busy={busy || craUnavailable} icon={Siren} onClick={() => onCraReport?.(incident.id, craBody('early_warning', cra))} testId={`${testId}-cra-early`}>
                                        {t('compliance.vuln_report_early', 'Report early warning')}
                                    </Action>
                                )}
                                {(stage === 'notification' || stage === 'final_report') && (
                                    <Action busy={busy || craUnavailable} icon={FileText} onClick={() => onCraReport?.(incident.id, craBody(stage, cra))} testId={`${testId}-cra-full`}>
                                        {stage === 'final_report' ? t('compliance.vuln_report_final', 'Report final report') : t('compliance.vuln_report_full', 'Report full')}
                                    </Action>
                                )}
                                {!incident.customer_notified_at && (
                                    <Action busy={busy || craUnavailable} icon={Building2} onClick={() => onCustomerNotified?.(incident.id)} testId={`${testId}-cra-customers`}>
                                        {t('compliance.vuln_customer_notified', 'Customer notified')}
                                    </Action>
                                )}
                            </div>
                            {craUnavailable && (
                                <p className="m-0 text-[11px]" style={{ color: TONES.warning.ink }} data-testid={`${testId}-cra-unavailable`}>
                                    {t('compliance.vuln_reporting_unavailable', 'CRA reporting is not available on this server yet — record the stamps once it is updated.')}
                                </p>
                            )}
                            <p className="m-0 text-[11px] text-[var(--text-tertiary)]">{t('compliance.vuln_attestation_note', 'Reporting is an attestation: your organisation files on the ENISA single reporting platform itself; Bee Flow records the stage, the channel and the reference — never the vulnerability details.')}</p>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            {!incident.authority_notified_at && (
                                <div className="flex flex-wrap gap-2 items-center">
                                    <input value={authorityRef} onChange={e => setAuthorityRef(e.target.value)} placeholder={t('compliance.inc_authority_ref_ph', 'Authority case/reference number (optional)')} className={`${INPUT} flex-1 min-w-[160px]`} data-testid={`${testId}-authority-ref`} />
                                    <Action busy={busy} icon={Landmark} onClick={() => onUpdate?.(incident.id, { status: 'authority_notified', authority_reference: authorityRef.trim() || undefined })} testId={`${testId}-authority`}>
                                        {t('compliance.inc_record_authority', 'Record authority notification')}
                                    </Action>
                                </div>
                            )}
                            {incident.high_risk && !incident.subjects_notified_at && (
                                <Action busy={busy} icon={Users} onClick={() => onUpdate?.(incident.id, { status: 'subjects_notified' })} testId={`${testId}-subjects`}>
                                    {t('compliance.inc_record_subjects', 'Record data-subject notification')}
                                </Action>
                            )}
                            <p className="m-0 text-[11px] text-[var(--text-tertiary)]">{t('compliance.inc_attestation_note', '"Record authority notification" is an attestation: your organisation files with the supervisory authority itself; Bee Flow only records that it was done, by whom and when.')}</p>
                        </div>
                    )}
                </DrawerSection>
            )}

            <DrawerSection label={t('compliance.inc_stamps', 'Stamps')}>
                <ul className="m-0 p-0 list-none flex flex-col gap-1 text-[11px]" data-testid={`${testId}-stamps`}>
                    {vuln ? (
                        <>
                            <StampLine label={t('compliance.vuln_stamp_early_warning', 'Early warning')} at={incident.early_warning_sent_at} extra={incident.reported_via} />
                            <StampLine label={t('compliance.vuln_stamp_full_report', 'Full report')} at={incident.notification_sent_at ?? incident.authority_notified_at ?? incident.reported_at} extra={incident.authority_reference} />
                            <StampLine label={t('compliance.vuln_clock_final_report', 'Final report (14 d)')} at={incident.final_report_sent_at} />
                            <StampLine label={t('compliance.vuln_stamp_customers', 'Customers notified')} at={incident.customer_notified_at} />
                        </>
                    ) : (
                        <>
                            <StampLine label={t('compliance.inc_stamp_recipients', 'Internal recipients')} at={incident.recipients_notified_at} />
                            <StampLine label={t('compliance.inc_stamp_authority', 'Supervisory authority (Art. 33)')} at={incident.authority_notified_at} extra={incident.authority_reference ? `ref: ${incident.authority_reference}` : null} />
                            {incident.high_risk && <StampLine label={t('compliance.inc_stamp_subjects', 'Data subjects (Art. 34)')} at={incident.subjects_notified_at} />}
                        </>
                    )}
                </ul>
            </DrawerSection>

            {Array.isArray(incident.notes) && incident.notes.length > 0 && (
                <DrawerSection label={t('compliance.inc_notes', 'Log')}>
                    <ul className="m-0 p-0 list-none flex flex-col gap-1 text-[11px] text-[var(--text-secondary)]">
                        {incident.notes.map((n, i) => (
                            <li key={i}><span className="text-[var(--text-tertiary)]">{n.at ? formatStamp(n.at) : ''}</span> — {n.text}</li>
                        ))}
                    </ul>
                </DrawerSection>
            )}
        </SideDrawer>
    );
}

const SEVERITY_EN = Object.freeze({ low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' });
const INPUT = 'w-full rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]';

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

/** POST /incidents/:id/cra-report body. */
export function craBody(stage, cra) {
    return {
        stage,
        reported_via: String(cra?.reported_via || '').trim() || undefined,
        reference: String(cra?.reference || '').trim() || undefined,
    };
}

function Action({ busy, icon: Icon, onClick, children, testId }) {
    return (
        <button
            type="button"
            disabled={busy}
            onClick={onClick}
            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed hover:bg-[var(--item-hover-bg)]"
            data-testid={testId}
        >
            {Icon && <Icon size={13} aria-hidden="true" />}{children}
        </button>
    );
}

function StampLine({ label, at, extra }) {
    return (
        <li className="flex items-center justify-between gap-2" data-done={at ? 'true' : 'false'}>
            <span className="text-[var(--text-secondary)]">{label}</span>
            <span className="tabular-nums" style={{ color: at ? TONES.success.ink : 'var(--text-tertiary)' }}>
                {at ? formatStamp(at) : '—'}{extra ? ` · ${extra}` : ''}
            </span>
        </li>
    );
}

function formatStamp(value) {
    const ms = value ? new Date(value).getTime() : NaN;
    if (Number.isNaN(ms)) return '—';
    return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

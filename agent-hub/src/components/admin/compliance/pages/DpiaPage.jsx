import React, { useMemo, useState } from 'react';
import { CheckCircle2, AlertTriangle, ClipboardList, FileDown } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import SideDrawer, { DrawerSection, DrawerId } from '../../../shared/SideDrawer';
import EmptyState from '../../../shared/EmptyState';
import StatusPill from '../shared/StatusPill';
import { fmtDate, Field, TextInput, TextArea, Select, Toggle, ActionButton, Intro, RegisterLayout } from './audits/auditForms';

/**
 * DpiaPage — data-protection impact assessments (GDPR Art. 35), one row per
 * high-risk agent.
 *
 * The rows are derived from the per-source Art-35 check results (they carry the
 * agent id/name and the risk reason in their evidence), joined with what is on
 * record. Two paths per agent, both server-persisted through
 * `data.dpia.save(agentId, body)`:
 *   - quick "Attest" (mode=attestation, 12-month validity) for an agent the
 *     admin assessed outside the tool;
 *   - a short structured questionnaire stored as answers JSON.
 *
 * Nothing about the agent's content leaves this page: the payload is the
 * admin's own answers plus the stamps.
 */

export const DPIA_CHECK_ID = 'GDPR-Art35-dpia-high-risk';

export function dpiaRows(checks, dpiaList) {
    return (Array.isArray(checks) ? checks : [])
        .filter(c => c.check_id === DPIA_CHECK_ID && c.scope_id)
        .map(c => ({
            agentId: c.scope_id,
            agentName: c.evidence?.agent_name || c.scope_id,
            riskReason: c.evidence?.risk_reason || null,
            status: c.status,
            dpia: (Array.isArray(dpiaList) ? dpiaList : []).find(d => d.agent_id === c.scope_id) || null,
        }));
}

export function defaultExpiry(now = new Date()) {
    const d = new Date(now.getTime());
    d.setMonth(d.getMonth() + 12);
    return d.toISOString();
}

const EMPTY_FORM = Object.freeze({
    purpose: '', data_categories: '', automated_decisions: false,
    human_oversight: '', mitigations: '', risk_level: 'medium',
});

const COLUMNS = Object.freeze([
    Object.freeze({ id: 'agent', label: 'compliance.dpia_col_agent', width: '1fr' }),
    Object.freeze({ id: 'reason', label: 'compliance.dpia_col_reason', width: '1fr', foldBelow: 1180 }),
    Object.freeze({ id: 'status', label: 'compliance.dpia_col_status', width: '190px' }),
]);
const COLUMN_FALLBACKS = Object.freeze({ agent: 'Agent', reason: 'Why it is high-risk', status: 'DPIA' });

export default function DpiaPage({ data = {}, isMobile = false, focusId = null, exportsEnabled = true, dl }) {
    const { t } = useTranslation();
    const state = data.dpia || {};
    const core = data.core || {};

    const dpiaList = state.dpiaList;
    const loading = dpiaList === null || dpiaList === undefined;
    const rows = useMemo(() => dpiaRows(core.checks, dpiaList), [core.checks, dpiaList]);

    const [openId, setOpenId] = useState(focusId ? String(focusId) : null);
    const [form, setForm] = useState(EMPTY_FORM);
    const selected = useMemo(() => rows.find(r => String(r.agentId) === String(openId)) || null, [rows, openId]);

    const columns = COLUMNS.map(c => ({ ...c, label: t(c.label, COLUMN_FALLBACKS[c.id]) }));
    const set = (patch) => setForm(f => ({ ...f, ...patch }));

    const openRow = (row) => {
        setOpenId(prev => (String(prev) === String(row.agentId) ? null : row.agentId));
        setForm(EMPTY_FORM);
    };

    const attest = () => selected && state.save?.(selected.agentId, {
        mode: 'attestation',
        risk_level: 'medium',
        expires_at: defaultExpiry(),
    });

    const submitQuestionnaire = () => selected && state.save?.(selected.agentId, {
        mode: 'questionnaire',
        risk_level: form.risk_level,
        expires_at: defaultExpiry(),
        answers: {
            purpose: form.purpose,
            data_categories: form.data_categories,
            automated_decisions: !!form.automated_decisions,
            human_oversight: form.human_oversight,
        },
        mitigations: form.mitigations
            ? form.mitigations.split('\n').map(s => s.trim()).filter(Boolean)
            : [],
    });

    const pdfUrl = selected?.dpia && exportsEnabled && typeof state.pdfUrlFor === 'function' && typeof dl === 'function'
        ? dl(state.pdfUrlFor(selected.agentId))
        : null;

    const saving = !!selected && state.savingId === selected.agentId;

    const drawer = selected && (
        <SideDrawer
            open
            onClose={() => setOpenId(null)}
            mode={isMobile ? 'modal' : 'inline'}
            width={420}
            ariaLabel={selected.agentName}
            testId="dpia-drawer"
            header={(
                <div className="flex flex-col gap-1 min-w-0">
                    <DrawerId testId="dpia-drawer-id">{selected.agentId}</DrawerId>
                    <span className="text-sm font-bold text-[var(--text-primary)] truncate">{selected.agentName}</span>
                    {selected.riskReason && <span className="text-[11px] text-[var(--text-tertiary)]">{selected.riskReason}</span>}
                </div>
            )}
            footer={(
                <div className="flex items-center gap-2 flex-wrap">
                    <ActionButton variant="primary" disabled={saving} onClick={submitQuestionnaire} data-testid="dpia-submit">
                        {saving ? t('compliance.saving', 'Saving…') : t('compliance.dpia_submit', 'Record assessment')}
                    </ActionButton>
                    {pdfUrl && (
                        <a
                            href={pdfUrl}
                            download
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] no-underline"
                            data-testid="dpia-pdf"
                        >
                            <FileDown size={13} aria-hidden="true" /> {t('compliance.dpia_download_pdf', 'Download PDF')}
                        </a>
                    )}
                </div>
            )}
        >
            <div className="flex flex-col gap-2">
                <ActionButton variant="success" icon={CheckCircle2} disabled={saving} className="self-start" onClick={attest} data-testid="dpia-attest">
                    {t('compliance.dpia_attest', 'Attest: assessed elsewhere')}
                </ActionButton>
                <span className="text-[11px] text-[var(--text-tertiary)]">
                    {t('compliance.dpia_attest_hint', 'Records that a DPIA exists outside Bee Flow, valid for twelve months.')}
                </span>
            </div>

            <DrawerSection label={t('compliance.dpia_questionnaire', 'Assessment')} hint={t('compliance.dpia_questionnaire_hint', 'Art. 35(7): purpose, data, necessity, measures.')}>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
                    <ClipboardList size={12} aria-hidden="true" />
                    {selected.dpia
                        ? t('compliance.dpia_on_record', 'DPIA on record ({mode}) — {date}', { mode: selected.dpia.mode, date: fmtDate(selected.dpia.approved_at) })
                        : t('compliance.dpia_missing', 'No DPIA on record')}
                </span>
            </DrawerSection>

            <Field label={t('compliance.dpia_q_purpose', 'Purpose')}>
                <TextInput value={form.purpose} onChange={v => set({ purpose: v })} data-testid="dpia-q-purpose" />
            </Field>
            <Field label={t('compliance.dpia_q_data', 'Personal data involved')}>
                <TextInput value={form.data_categories} onChange={v => set({ data_categories: v })} placeholder={t('compliance.dpia_q_data_ph', 'Names, e-mail addresses, case content…')} data-testid="dpia-q-data" />
            </Field>
            <Toggle
                checked={form.automated_decisions}
                onChange={v => set({ automated_decisions: v })}
                label={t('compliance.dpia_q_automated', 'Decisions are made automatically')}
                testId="dpia-q-automated"
            />
            <Field label={t('compliance.dpia_q_oversight', 'Human oversight')}>
                <TextInput value={form.human_oversight} onChange={v => set({ human_oversight: v })} placeholder={t('compliance.dpia_q_oversight_ph', 'Who checks the output, and when?')} data-testid="dpia-q-oversight" />
            </Field>
            <Field label={t('compliance.dpia_q_mitigations', 'Mitigations')} hint={t('compliance.dpia_q_mitigations_hint', 'One per line')}>
                <TextArea rows={3} value={form.mitigations} onChange={v => set({ mitigations: v })} placeholder={t('compliance.dpia_q_mitigations_ph', 'PII redaction before the model call')} data-testid="dpia-q-mitigations" />
            </Field>
            <Field label={t('compliance.dpia_q_risk', 'Residual risk')}>
                <Select
                    value={form.risk_level}
                    onChange={v => set({ risk_level: v })}
                    data-testid="dpia-q-risk"
                    options={[
                        { value: 'low', label: t('compliance.dpia_risk_low', 'Low') },
                        { value: 'medium', label: t('compliance.dpia_risk_medium', 'Medium') },
                        { value: 'high', label: t('compliance.dpia_risk_high', 'High') },
                    ]}
                />
            </Field>
        </SideDrawer>
    );

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="dpia-page"
            drawer={drawer}
            toolbar={(
                <Intro testId="dpia-intro">
                    {t('compliance.dpia_subtitle', 'An agent that processes personal data at scale, or decides about people, needs an impact assessment before it runs (Art. 35).')}
                </Intro>
            )}
        >
            <DataTable
                columns={columns}
                rows={rows}
                rowKey={(r) => r.agentId}
                loading={loading}
                isMobile={isMobile}
                ariaLabel={t('compliance.rail_dpia', 'DPIA')}
                testId="dpia-table"
                empty={(
                    <EmptyState
                        title={t('compliance.dpia_empty_title', 'No agent needs a DPIA')}
                        description={t('compliance.dpia_empty', 'Nothing here processes personal data at a scale that triggers Art. 35 — the check re-evaluates this on every run.')}
                    />
                )}
                renderRow={(r, ctx) => {
                    const ok = r.status === 'pass';
                    const tone = ok ? 'success' : (r.status === 'warn' ? 'warning' : 'error');
                    return (
                        <TableRow
                            columns={ctx.columns}
                            accent={tone}
                            selected={String(openId) === String(r.agentId)}
                            onClick={() => openRow(r)}
                            testId={`dpia-row-${r.agentId}`}
                        >
                            <TableCell column={ctx.columns[0]}>
                                <span className="flex items-center gap-2 min-w-0">
                                    {ok
                                        ? <CheckCircle2 size={13} aria-hidden="true" style={{ color: 'var(--success)' }} />
                                        : <AlertTriangle size={13} aria-hidden="true" style={{ color: tone === 'warning' ? 'var(--warning)' : 'var(--error)' }} />}
                                    <span className="font-semibold text-[var(--text-primary)] truncate">{r.agentName}</span>
                                </span>
                            </TableCell>
                            <TableCell column={ctx.columns[1]}>
                                <span className="text-[var(--text-secondary)] [overflow-wrap:anywhere]">{r.riskReason || '—'}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[2]}>
                                <StatusPill tone={r.dpia ? 'success' : tone} testId={`dpia-status-${r.agentId}`}>
                                    {r.dpia
                                        ? t('compliance.dpia_on_record', 'DPIA on record ({mode}) — {date}', { mode: r.dpia.mode, date: fmtDate(r.dpia.approved_at) })
                                        : t('compliance.dpia_missing', 'No DPIA on record')}
                                </StatusPill>
                            </TableCell>
                        </TableRow>
                    );
                }}
                renderCard={(r) => (
                    <button type="button" onClick={() => openRow(r)} className="w-full text-left flex flex-col gap-1 px-3.5 py-2.5" data-testid={`dpia-card-${r.agentId}`}>
                        <span className="text-xs font-semibold text-[var(--text-primary)]">{r.agentName}</span>
                        <span className="text-[11px] text-[var(--text-tertiary)]">
                            {r.dpia ? t('compliance.dpia_on_record_short', 'DPIA on record') : t('compliance.dpia_missing', 'No DPIA on record')}
                        </span>
                    </button>
                )}
            />
        </RegisterLayout>
    );
}

import React, { useMemo } from 'react';
import { RefreshCw, CheckCircle2, ExternalLink, Globe2, ShieldCheck, ShieldAlert, FileDown } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import EmptyState from '../../../shared/EmptyState';
import StatusPill from '../shared/StatusPill';
import { fmtDate, Fact, ActionButton, Intro, ReadFailed, RegisterLayout } from './audits/auditForms';
import RopaProjects from './ropa/RopaProjects';

/**
 * RopaPage — the Record of Processing Activities (GDPR Art. 30), rendered
 * straight from the server-side synthesis (`GET /ropa`). The admin REVIEWS and
 * attests; nobody types this register from scratch: agents become activities,
 * observed egress operators become processors, settings become the controller
 * block.
 *
 * `data.ropa = { ropa, busy, refresh, review(), sccToggle(operator, confirmed) }`.
 *
 * Non-EU processors carry a per-operator SCC attestation, here a row action.
 * When the org keeps a DORA register of information, the admin's contract facts
 * (`contract_ref`, `critical`, `country`) ride along on the same rows — those
 * columns appear only when at least one row carries them, so a GDPR-only org
 * never sees three empty columns.
 */

export function sccConfirmedSet(ropa) {
    return new Set(
        (ropa?.scc_confirmed_operators || [])
            .map(o => String(o?.operator || o || '').toLowerCase())
            .filter(Boolean),
    );
}

/** True when any processor row carries a DORA register fact. */
export function hasDoraColumns(processors) {
    return (Array.isArray(processors) ? processors : []).some(
        p => p.contract_ref || p.country || typeof p.critical === 'boolean',
    );
}

const ACTIVITY_COLUMNS = Object.freeze([
    Object.freeze({ id: 'name', label: 'compliance.ropa_col_activity', width: '220px' }),
    Object.freeze({ id: 'purpose', label: 'compliance.ropa_col_purpose', width: '1fr' }),
    Object.freeze({ id: 'data', label: 'compliance.ropa_col_data', width: '200px', foldBelow: 1180 }),
    Object.freeze({ id: 'retention', label: 'compliance.ropa_col_retention', width: '160px', foldBelow: 1180 }),
    Object.freeze({ id: 'transfers', label: 'compliance.ropa_col_transfers', width: '160px' }),
]);
const ACTIVITY_FALLBACKS = Object.freeze({ name: 'Activity', purpose: 'Purpose', data: 'Data', retention: 'Retention', transfers: 'Transfers' });

const PROCESSOR_FALLBACKS = Object.freeze({
    operator: 'Processor', location: 'Location', calls: 'Calls', last_seen: 'Last seen', scc: 'Transfer basis',
    contract_ref: 'Contract', critical: 'Critical', country: 'Country (contract)',
});

/**
 * Where an activity's own object lives.
 *
 * The register was a list of names you could not follow: "Invoice BI
 * Automator" is a real table and clicking it should open it (owner,
 * 2026-09-16). `source` has been on every derived activity since datatables
 * joined the register; nothing rendered it. An activity with no source — a
 * static row, a processor — stays plain text.
 */
function sourceLink(activity) {
    const src = activity && activity.source;
    if (!src || !src.id) return null;
    if (src.kind === 'datatable') return `studio/datatables/${src.id}`;
    if (src.kind === 'app' || src.kind === 'studio_app') return `studio/apps/${src.id}`;
    if (src.kind === 'automation') return `studio/automations/${src.id}`;
    if (src.kind === 'project') return `projects/${src.id}`;
    return null;
}

/** The activity's name: a link when we know where it lives, words when we do not. */
function ActivityName({ activity, onNavigate, className }) {
    const to = sourceLink(activity);
    if (!to || !onNavigate) return <span className={className}>{activity.name}</span>;
    return (
        <button
            type="button"
            onClick={() => onNavigate(to)}
            className={`${className} inline-flex items-center gap-1 text-left hover:underline`}
            data-testid={`ropa-activity-link-${activity.activity_id}`}
        >
            {activity.name}
            <ExternalLink className="w-3 h-3 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
        </button>
    );
}

export default function RopaPage({ data = {}, isMobile = false, exportsEnabled = true, dl, api = '/api/compliance', onNavigate = null }) {
    const { t } = useTranslation();
    const state = data.ropa || {};
    const ropa = state.ropa;

    const loading = ropa === null || ropa === undefined;
    const failed = !loading && (typeof ropa !== 'object' || !!ropa.error);

    const confirmed = useMemo(() => sccConfirmedSet(ropa), [ropa]);
    const isConfirmed = (op) => confirmed.has(String(op || '').toLowerCase());

    const activities = !loading && !failed && Array.isArray(ropa.activities) ? ropa.activities : [];
    const processors = !loading && !failed && Array.isArray(ropa.processors) ? ropa.processors : [];
    const dora = hasDoraColumns(processors);
    const reviewedAt = !loading && !failed ? ropa.last_reviewed_at : null;
    const pdfUrl = exportsEnabled && typeof dl === 'function' ? dl(`${api}/ropa.pdf`) : null;

    const activityColumns = ACTIVITY_COLUMNS.map(c => ({ ...c, label: t(c.label, ACTIVITY_FALLBACKS[c.id]) }));
    const processorColumns = [
        { id: 'operator', label: t('compliance.ropa_col_operator', PROCESSOR_FALLBACKS.operator), width: '200px' },
        { id: 'location', label: t('compliance.ropa_col_location', PROCESSOR_FALLBACKS.location), width: '180px' },
        ...(dora ? [
            { id: 'contract_ref', label: t('compliance.ropa_col_contract_ref', PROCESSOR_FALLBACKS.contract_ref), width: '150px' },
            { id: 'critical', label: t('compliance.ropa_col_critical', PROCESSOR_FALLBACKS.critical), width: '110px' },
            { id: 'country', label: t('compliance.ropa_col_country', PROCESSOR_FALLBACKS.country), width: '130px', foldBelow: 1180 },
        ] : []),
        { id: 'calls', label: t('compliance.ropa_col_calls', PROCESSOR_FALLBACKS.calls), width: '90px', foldBelow: 1180 },
        { id: 'last_seen', label: t('compliance.ropa_col_last_seen', PROCESSOR_FALLBACKS.last_seen), width: '130px', foldBelow: 1180 },
        { id: 'scc', label: t('compliance.ropa_col_scc', PROCESSOR_FALLBACKS.scc), width: '190px' },
    ];

    if (failed) {
        return (
            <div className="p-3.5" data-testid="ropa-page">
                <ReadFailed testId="ropa-failed">{t('compliance.ropa_load_failed', 'The processing register could not be built.')}</ReadFailed>
            </div>
        );
    }

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="ropa-page"
            toolbar={(
                <>
                    <Intro testId="ropa-intro">
                        {reviewedAt
                            ? t('compliance.ropa_reviewed_at', 'Last reviewed {date}', { date: fmtDate(reviewedAt) })
                            : t('compliance.ropa_never_reviewed', 'This register has never been reviewed.')}
                    </Intro>
                    <ActionButton icon={RefreshCw} onClick={() => state.refresh?.()} title={t('compliance.ropa_regenerate', 'Rebuild from what the platform observes')} data-testid="ropa-refresh">
                        {t('compliance.ropa_regenerate', 'Rebuild')}
                    </ActionButton>
                    {pdfUrl && (
                        <a
                            href={pdfUrl}
                            download
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] no-underline"
                            data-testid="ropa-pdf"
                        >
                            <FileDown size={13} aria-hidden="true" /> {t('compliance.ropa_download_pdf', 'Download PDF')}
                        </a>
                    )}
                    <ActionButton variant="primary" icon={CheckCircle2} disabled={!!state.busy} onClick={() => state.review?.()} data-testid="ropa-review">
                        {t('compliance.ropa_mark_reviewed', 'Mark as reviewed')}
                    </ActionButton>
                </>
            )}
        >
            <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3.5 flex flex-col gap-1.5" data-testid="ropa-controller">
                <h3 className="m-0 text-xs font-bold text-[var(--text-primary)]">{t('compliance.ropa_controller', 'Controller')}</h3>
                <Fact label={t('compliance.ropa_org', 'Organisation')} testId="ropa-org">{ropa?.controller?.name}</Fact>
                <Fact label={t('compliance.dpo_name', 'DPO name')} testId="ropa-dpo-name">{ropa?.controller?.dpo_name}</Fact>
                <Fact label={t('compliance.dpo_email', 'DPO email')} testId="ropa-dpo-email">{ropa?.controller?.dpo_email}</Fact>
                <Fact label={t('compliance.data_residency', 'Data residency')} testId="ropa-residency">{ropa?.data_residency}</Fact>
                <Fact label={t('compliance.settings_legal_bases', 'Legal bases')} testId="ropa-bases">{(ropa?.legal_bases || []).join(', ') || null}</Fact>
            </section>

            <section className="flex flex-col gap-2" data-testid="ropa-activities">
                <h3 className="m-0 text-xs font-bold text-[var(--text-primary)]">{t('compliance.ropa_activities', 'Processing activities')}</h3>
                <DataTable
                    columns={activityColumns}
                    rows={activities}
                    rowKey={(a) => a.activity_id}
                    loading={loading}
                    isMobile={isMobile}
                    ariaLabel={t('compliance.ropa_activities', 'Processing activities')}
                    testId="ropa-activities-table"
                    empty={<EmptyState title={t('compliance.ropa_no_activities', 'No processing activities detected yet')} />}
                    renderCard={(a) => (
                        <div className="w-full min-w-0 flex flex-col gap-1" data-testid={`ropa-activity-card-${a.activity_id}`}>
                            <ActivityName activity={a} onNavigate={onNavigate} className="text-xs font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]" />
                            <span className="text-[11px] text-[var(--text-secondary)]">{a.purpose}</span>
                            <span className="text-[11px] text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                                {(a.data_categories || []).join(', ') || '—'} · {a.retention || '—'} · {(a.transfers || []).length ? a.transfers.join(', ') : t('compliance.ropa_no_transfers', 'None outside the EU')}
                            </span>
                        </div>
                    )}
                    renderRow={(a, ctx) => (
                        <TableRow columns={ctx.columns} testId={`ropa-activity-${a.activity_id}`}>
                            <TableCell column={ctx.columns[0]}>
                                <ActivityName activity={a} onNavigate={onNavigate} className="font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]" />
                            </TableCell>
                            <TableCell column={ctx.columns[1]}>
                                <span className="text-[var(--text-secondary)]">{a.purpose}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[2]}>
                                <span className="text-[var(--text-secondary)]">{(a.data_categories || []).join(', ') || '—'}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[3]}>
                                <span className="text-[var(--text-secondary)]">{a.retention || '—'}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[4]}>
                                <span className="text-[var(--text-secondary)]">
                                    {(a.transfers || []).length ? a.transfers.join(', ') : t('compliance.ropa_no_transfers', 'None outside the EU')}
                                </span>
                            </TableCell>
                        </TableRow>
                    )}
                />
            </section>

            {/* Collaborative projects with personal data and their records.
                Rendered only when the register hook serves them. */}
            {'projects' in state ? (
                <RopaProjects
                    body={state.projects}
                    onSave={state.saveProject}
                    onRemove={state.removeProject}
                    onNavigate={onNavigate}
                />
            ) : null}

            <section className="flex flex-col gap-2" data-testid="ropa-processors">
                <h3 className="m-0 text-xs font-bold text-[var(--text-primary)]">{t('compliance.ropa_processors', 'Processors')}</h3>
                <p className="m-0 text-xs text-[var(--text-secondary)]">
                    {t('compliance.ropa_processors_desc', 'Measured from the calls that actually left this installation. A processor outside the EU needs a transfer basis — confirm it per operator.')}
                </p>
                <DataTable
                    columns={processorColumns}
                    rows={processors}
                    rowKey={(p) => p.operator || 'unknown'}
                    loading={loading}
                    isMobile={isMobile}
                    ariaLabel={t('compliance.ropa_processors', 'Processors')}
                    testId="ropa-processors-table"
                    empty={<EmptyState title={t('compliance.ropa_no_processors', 'Nothing left this installation yet')} />}
                    renderCard={(p) => {
                        const ok = isConfirmed(p.operator) || !!p.scc_confirmed;
                        const key = p.operator || 'unknown';
                        return (
                            <div className="w-full min-w-0 flex items-center gap-2" data-testid={`ropa-processor-card-${key}`}>
                                <div className="flex-1 min-w-0 flex flex-col gap-1">
                                    <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{p.operator || '—'}</span>
                                    <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] min-w-0">
                                        <Globe2 size={12} aria-hidden="true" style={{ color: p.is_eu ? 'var(--success)' : 'var(--warning)' }} />
                                        <span className="truncate">{p.country_name || p.country_code || '—'}</span>
                                        {p.is_eu && <StatusPill tone="success" testId={`ropa-eu-card-${key}`}>EU</StatusPill>}
                                        {dora && typeof p.critical === 'boolean' && (
                                            <StatusPill tone={p.critical ? 'warning' : 'neutral'} testId={`ropa-critical-card-${key}`}>
                                                {p.critical ? t('compliance.ropa_critical_yes', 'Critical') : t('compliance.ropa_critical_no', 'Not critical')}
                                            </StatusPill>
                                        )}
                                    </span>
                                    <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums truncate">
                                        {p.calls ?? '—'} · {p.last_seen ? fmtDate(p.last_seen) : '—'}
                                    </span>
                                </div>
                                {p.is_eu ? (
                                    <span className="text-[11px] text-[var(--text-tertiary)] flex-shrink-0" data-testid={`ropa-scc-none-card-${key}`}>
                                        {t('compliance.ropa_scc_not_needed', 'No transfer')}
                                    </span>
                                ) : (
                                    <ActionButton
                                        variant={ok ? 'success' : 'warning'}
                                        icon={ok ? ShieldCheck : ShieldAlert}
                                        disabled={!!state.busy}
                                        onClick={() => state.sccToggle?.(p.operator, !ok)}
                                        className="flex-shrink-0 min-h-[44px]"
                                        data-testid={`ropa-scc-card-${key}`}
                                    >
                                        {ok ? t('compliance.ropa_scc_confirmed', 'SCCs in place') : t('compliance.ropa_scc_confirm', 'Confirm SCCs')}
                                    </ActionButton>
                                )}
                            </div>
                        );
                    }}
                    renderRow={(p, ctx) => {
                        const ok = isConfirmed(p.operator) || !!p.scc_confirmed;
                        const key = p.operator || 'unknown';
                        let i = 0;
                        return (
                            <TableRow columns={ctx.columns} accent={p.is_eu ? 'success' : (ok ? 'success' : 'warning')} testId={`ropa-processor-${key}`}>
                                <TableCell column={ctx.columns[i++]}>
                                    <span className="font-semibold text-[var(--text-primary)] truncate">{p.operator || '—'}</span>
                                </TableCell>
                                <TableCell column={ctx.columns[i++]}>
                                    <span className="inline-flex items-center gap-1.5 text-[var(--text-secondary)]">
                                        <Globe2 size={12} aria-hidden="true" style={{ color: p.is_eu ? 'var(--success)' : 'var(--warning)' }} />
                                        {p.country_name || p.country_code || '—'}
                                        {p.is_eu && <StatusPill tone="success" testId={`ropa-eu-${key}`}>EU</StatusPill>}
                                    </span>
                                </TableCell>
                                {dora && (
                                    <TableCell column={ctx.columns[i++]}>
                                        <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate" data-testid={`ropa-contract-${key}`}>{p.contract_ref || '—'}</span>
                                    </TableCell>
                                )}
                                {dora && (
                                    <TableCell column={ctx.columns[i++]}>
                                        {typeof p.critical === 'boolean'
                                            ? (
                                                <StatusPill tone={p.critical ? 'warning' : 'neutral'} testId={`ropa-critical-${key}`}>
                                                    {p.critical ? t('compliance.ropa_critical_yes', 'Critical') : t('compliance.ropa_critical_no', 'Not critical')}
                                                </StatusPill>
                                            )
                                            : <span className="text-[var(--text-tertiary)]">—</span>}
                                    </TableCell>
                                )}
                                {dora && (
                                    <TableCell column={ctx.columns[i++]}>
                                        <span className="text-[var(--text-secondary)]" data-testid={`ropa-country-${key}`}>{p.country || '—'}</span>
                                    </TableCell>
                                )}
                                <TableCell column={ctx.columns[i++]}>
                                    <span className="text-[var(--text-secondary)] tabular-nums">{p.calls ?? '—'}</span>
                                </TableCell>
                                <TableCell column={ctx.columns[i++]}>
                                    <span className="text-[var(--text-secondary)]">{p.last_seen ? fmtDate(p.last_seen) : '—'}</span>
                                </TableCell>
                                <TableCell column={ctx.columns[i++]}>
                                    {p.is_eu ? (
                                        <span className="text-[11px] text-[var(--text-tertiary)]" data-testid={`ropa-scc-none-${key}`}>
                                            {t('compliance.ropa_scc_not_needed', 'No transfer')}
                                        </span>
                                    ) : (
                                        <ActionButton
                                            size="sm"
                                            variant={ok ? 'success' : 'warning'}
                                            icon={ok ? ShieldCheck : ShieldAlert}
                                            disabled={!!state.busy}
                                            onClick={() => state.sccToggle?.(p.operator, !ok)}
                                            data-testid={`ropa-scc-${key}`}
                                        >
                                            {ok ? t('compliance.ropa_scc_confirmed', 'SCCs in place') : t('compliance.ropa_scc_confirm', 'Confirm SCCs')}
                                        </ActionButton>
                                    )}
                                </TableCell>
                            </TableRow>
                        );
                    }}
                />
            </section>
        </RegisterLayout>
    );
}

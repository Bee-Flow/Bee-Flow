import { RefreshCw, CheckCircle2, ExternalLink, FileDown } from 'lucide-react';
import React, { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../shared/DataTable';
import EmptyState from '../../../shared/EmptyState';
import { useDateFormat } from '../shared/formatDates';
import StatusPill from '../shared/StatusPill';
import { Fact, ActionButton, ReadFailed, RegisterLayout } from './audits/auditForms';
import RopaProjects from './ropa/RopaProjects';
import SccCell from './ropa/RopaScc';
import { LEGAL_BASES, RESIDENCY } from './settings/settingsFields';

/**
 * RopaPage — the Record of Processing Activities (GDPR Art. 30), rendered
 * straight from the server-side synthesis (`GET /ropa`). The admin REVIEWS and
 * attests; nobody types this register from scratch: agents become activities,
 * observed egress operators become processors, settings become the controller
 * block.
 *
 * `data.ropa = { ropa, busy, refresh, review(), sccToggle(operator, confirmed) }`.
 *
 * The review state and its two actions live in the section header, like every
 * other register's: the page hands `onMarkRopaReviewed`, `onRegenerateRopa`
 * and `ropaBusy` up through `setHeaderActions` (registerSpecs' ropa spec reads
 * the review date from the counts). A host without a header keeps the two
 * buttons above the register.
 *
 * Every Art. 30(1) fact stays on screen at every width: data categories and
 * retention are columns while the card is 900px wide, and a second line
 * under the purpose below that. Non-EU processors carry a per-operator SCC
 * attestation (ropa/RopaScc). When the org keeps a DORA register of
 * information, the admin's contract facts (`contract_ref`, `critical`,
 * `country`) ride along on the same rows — those columns appear only when at
 * least one row carries them, so a GDPR-only org never sees three empty
 * columns.
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

/** A stored option value in words ('legal_obligation' → 'Legal obligation'); an unknown one as it is. */
function optionLabel(options, value, t) {
    const o = options.find(x => x.value === value);
    return o ? t(o.key, o.en) : value;
}

/**
 * The register's row texts. `formatDay` and `number` are the language on
 * screen; a processor's location says EU once, as text.
 */
function ropaTexts(t, formatDay, number) {
    const dataText = (a) => (a.data_categories || []).join(', ') || '—';
    const country = (p) => p.country_name || p.country_code || '';
    return {
        dataText,
        // Operator names carry commas ("OpenAI, L.L.C."), so the list does not.
        transfersText: (a) => ((a.transfers || []).length ? a.transfers.join(' · ') : t('compliance.ropa_no_transfers', 'None outside the EU')),
        dataLine: (a) => t('compliance.ropa_data_line', 'Data: {data} · Kept: {retention}', { data: dataText(a), retention: a.retention || '—' }),
        location: (p) => {
            if (!p.is_eu) return country(p) || '—';
            return country(p) ? t('compliance.ropa_location_eu', '{country} · EU', { country: country(p) }) : 'EU';
        },
        callsLine: (p) => {
            if (typeof p.calls !== 'number') return null;
            const n = number.format(p.calls);
            return p.last_seen
                ? t('compliance.ropa_calls_line', '{n} calls · last {date}', { n, date: formatDay(p.last_seen) })
                : t('compliance.ropa_calls_only', '{n} calls', { n });
        },
    };
}

const ACTIVITY_COLUMNS = Object.freeze([
    Object.freeze({ id: 'name', label: 'compliance.ropa_col_activity', width: '190px' }),
    Object.freeze({ id: 'purpose', label: 'compliance.ropa_col_purpose', width: '1fr' }),
    Object.freeze({ id: 'data', label: 'compliance.ropa_col_data', width: '180px', foldBelow: 900 }),
    Object.freeze({ id: 'retention', label: 'compliance.ropa_col_retention', width: '170px', foldBelow: 900 }),
    Object.freeze({ id: 'transfers', label: 'compliance.ropa_col_transfers', width: '150px' }),
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

/**
 * Hands the review state and its two actions to the section header while the
 * register is on screen. The handlers are read through a ref: the register
 * hook builds new ones on every render, and registering on every render would
 * re-render the hub, which re-renders the page, which registers again.
 */
function useRopaHeaderActions(setHeaderActions, state) {
    const stateRef = useRef(state);
    useEffect(() => { stateRef.current = state; });
    const busy = !!state.busy;
    useEffect(() => {
        if (typeof setHeaderActions !== 'function') return undefined;
        setHeaderActions({
            onMarkRopaReviewed: () => stateRef.current.review?.(),
            onRegenerateRopa: () => stateRef.current.refresh?.(),
            ropaBusy: busy,
        });
        return () => setHeaderActions({});
    }, [setHeaderActions, busy]);
    return typeof setHeaderActions === 'function';
}

export default function RopaPage({ data = {}, isMobile = false, exportsEnabled = true, dl, api = '/api/compliance', onNavigate = null, setHeaderActions = undefined }) {
    const { t, resolvedLocale } = useTranslation();
    const { formatDay } = useDateFormat();
    const state = data.ropa || {};
    const ropa = state.ropa;
    const headerOwnsActions = useRopaHeaderActions(setHeaderActions, state);

    const loading = ropa === null || ropa === undefined;
    const failed = !loading && (typeof ropa !== 'object' || !!ropa.error);

    const confirmed = useMemo(() => sccConfirmedSet(ropa), [ropa]);
    const isConfirmed = (op) => confirmed.has(String(op || '').toLowerCase());

    const activities = !loading && !failed && Array.isArray(ropa.activities) ? ropa.activities : [];
    const processors = !loading && !failed && Array.isArray(ropa.processors) ? ropa.processors : [];
    const dora = hasDoraColumns(processors);
    const pdfUrl = exportsEnabled && typeof dl === 'function' ? dl(`${api}/ropa.pdf`) : null;
    const number = useMemo(() => new Intl.NumberFormat(resolvedLocale || 'en'), [resolvedLocale]);

    const bases = (ropa?.legal_bases || []).map(v => optionLabel(LEGAL_BASES, v, t)).join(' · ') || null;
    const residency = ropa?.data_residency ? optionLabel(RESIDENCY, ropa.data_residency, t) : null;
    const { dataText, transfersText, dataLine, location, callsLine } = ropaTexts(t, formatDay, number);

    const activityColumns = ACTIVITY_COLUMNS.map(c => ({ ...c, label: t(c.label, ACTIVITY_FALLBACKS[c.id]) }));
    const processorColumns = [
        { id: 'operator', label: t('compliance.ropa_col_operator', PROCESSOR_FALLBACKS.operator), width: '1fr' },
        { id: 'location', label: t('compliance.ropa_col_location', PROCESSOR_FALLBACKS.location), width: '170px' },
        ...(dora ? [
            { id: 'contract_ref', label: t('compliance.ropa_col_contract_ref', PROCESSOR_FALLBACKS.contract_ref), width: '150px' },
            { id: 'critical', label: t('compliance.ropa_col_critical', PROCESSOR_FALLBACKS.critical), width: '110px' },
            { id: 'country', label: t('compliance.ropa_col_country', PROCESSOR_FALLBACKS.country), width: '130px', foldBelow: 1180 },
        ] : []),
        { id: 'calls', label: t('compliance.ropa_col_calls', PROCESSOR_FALLBACKS.calls), width: '90px', align: 'right', foldBelow: 900 },
        { id: 'last_seen', label: t('compliance.ropa_col_last_seen', PROCESSOR_FALLBACKS.last_seen), width: '110px', foldBelow: 900 },
        { id: 'scc', label: t('compliance.ropa_col_scc', PROCESSOR_FALLBACKS.scc), width: '150px' },
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
            toolbar={headerOwnsActions ? null : (
                <div className="flex flex-wrap items-center gap-2 ml-auto" data-testid="ropa-own-actions">
                    <ActionButton icon={RefreshCw} onClick={() => state.refresh?.()} data-testid="ropa-refresh">
                        {t('compliance.hdr_ropa_regenerate', 'Regenerate from live configuration')}
                    </ActionButton>
                    <ActionButton variant="primary" icon={CheckCircle2} disabled={!!state.busy} onClick={() => state.review?.()} data-testid="ropa-review">
                        {t('compliance.ropa_mark_reviewed', 'Mark as reviewed')}
                    </ActionButton>
                </div>
            )}
        >
            <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3.5 flex flex-col gap-1.5" data-testid="ropa-controller">
                <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="m-0 text-xs font-bold text-[var(--text-primary)]">{t('compliance.ropa_controller', 'Controller')}</h3>
                    {pdfUrl && (
                        <a
                            href={pdfUrl}
                            download
                            className="ml-auto inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] rounded"
                            data-testid="ropa-pdf"
                        >
                            <FileDown size={13} aria-hidden="true" /> {t('compliance.ropa_download_pdf', 'Download PDF')}
                        </a>
                    )}
                </div>
                <Fact label={t('compliance.ropa_org', 'Organisation')} testId="ropa-org">{ropa?.controller?.name}</Fact>
                <Fact label={t('compliance.dpo_name', 'DPO name')} testId="ropa-dpo-name">{ropa?.controller?.dpo_name}</Fact>
                <Fact label={t('compliance.dpo_email', 'DPO email')} testId="ropa-dpo-email">{ropa?.controller?.dpo_email}</Fact>
                <Fact label={t('compliance.data_residency', 'Data residency')} testId="ropa-residency">{residency}</Fact>
                <Fact label={t('compliance.settings_legal_bases', 'Legal bases')} testId="ropa-bases">{bases}</Fact>
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
                            <span className="text-[11px] text-[var(--text-tertiary)] [overflow-wrap:anywhere]">{dataLine(a)}</span>
                            <span className="text-[11px] text-[var(--text-tertiary)] [overflow-wrap:anywhere]">{transfersText(a)}</span>
                        </div>
                    )}
                    renderRow={(a, ctx) => (
                        <TableRow columns={ctx.columns} testId={`ropa-activity-${a.activity_id}`}>
                            <TableCell column={ctx.columns[0]}>
                                <ActivityName activity={a} onNavigate={onNavigate} className="font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]" />
                            </TableCell>
                            <TableCell column={ctx.columns[1]}>
                                <span className="flex flex-col gap-0.5 min-w-0">
                                    <span className="text-[var(--text-secondary)]">{a.purpose}</span>
                                    <span className={`${TABLE_FOLDED_ONLY[900]} text-[11px] text-[var(--text-tertiary)] [overflow-wrap:anywhere]`} data-testid={`ropa-data-line-${a.activity_id}`}>
                                        {dataLine(a)}
                                    </span>
                                </span>
                            </TableCell>
                            <TableCell column={ctx.columns[2]}>
                                <span className="text-[var(--text-secondary)]">{dataText(a)}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[3]}>
                                <span className="text-[var(--text-secondary)]">{a.retention || '—'}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[4]}>
                                <span className="text-[var(--text-secondary)]">{transfersText(a)}</span>
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
                        const key = p.operator || 'unknown';
                        return (
                            <div className="w-full min-w-0 flex items-center gap-2" data-testid={`ropa-processor-card-${key}`}>
                                <div className="flex-1 min-w-0 flex flex-col gap-1">
                                    <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{p.operator || '—'}</span>
                                    <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] min-w-0">
                                        <span className="truncate">{location(p)}</span>
                                        {dora && typeof p.critical === 'boolean' && (
                                            <StatusPill tone={p.critical ? 'warning' : 'neutral'} testId={`ropa-critical-card-${key}`}>
                                                {p.critical ? t('compliance.ropa_critical_yes', 'Critical') : t('compliance.ropa_critical_no', 'Not critical')}
                                            </StatusPill>
                                        )}
                                    </span>
                                    {callsLine(p) && (
                                        <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums truncate" data-testid={`ropa-calls-card-${key}`}>{callsLine(p)}</span>
                                    )}
                                </div>
                                <SccCell processor={p} attested={isConfirmed(p.operator) || !!p.scc_confirmed} busy={!!state.busy}
                                    onToggle={state.sccToggle} card testKey={`card-${key}`} />
                            </div>
                        );
                    }}
                    renderRow={(p, ctx) => {
                        const ok = isConfirmed(p.operator) || !!p.scc_confirmed;
                        const key = p.operator || 'unknown';
                        let i = 0;
                        return (
                            <TableRow columns={ctx.columns} accent={!p.is_eu && !ok ? 'warning' : null} testId={`ropa-processor-${key}`}>
                                <TableCell column={ctx.columns[i++]}>
                                    <span className="flex flex-col gap-0.5 min-w-0">
                                        <span className="font-semibold text-[var(--text-primary)] truncate">{p.operator || '—'}</span>
                                        {callsLine(p) && (
                                            <span className={`${TABLE_FOLDED_ONLY[900]} text-[11px] text-[var(--text-tertiary)] tabular-nums truncate`}>{callsLine(p)}</span>
                                        )}
                                    </span>
                                </TableCell>
                                <TableCell column={ctx.columns[i++]}>
                                    <span className="text-[var(--text-secondary)] truncate" data-testid={`ropa-location-${key}`}>{location(p)}</span>
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
                                <TableCell column={ctx.columns[i++]} align="right">
                                    <span className="text-[var(--text-secondary)] tabular-nums">{typeof p.calls === 'number' ? number.format(p.calls) : '—'}</span>
                                </TableCell>
                                <TableCell column={ctx.columns[i++]}>
                                    <span className="text-[var(--text-secondary)] whitespace-nowrap">{p.last_seen ? formatDay(p.last_seen) : '—'}</span>
                                </TableCell>
                                <TableCell column={ctx.columns[i++]}>
                                    <SccCell processor={p} attested={ok} busy={!!state.busy} onToggle={state.sccToggle} testKey={key} />
                                </TableCell>
                            </TableRow>
                        );
                    }}
                />
            </section>
        </RegisterLayout>
    );
}

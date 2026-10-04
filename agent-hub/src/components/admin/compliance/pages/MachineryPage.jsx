import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Factory, PenLine } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import DeadlineClock from '../../../shared/DeadlineClock';
import EmptyState from '../../../shared/EmptyState';
import StatusPill from '../shared/StatusPill';
import ArticleRef from '../shared/ArticleRef';
import { API, asObject, fetchJson, json } from '../data/api';
import useResource from '../data/useResource';
import AttestDrawer from './custom/AttestDrawer';

/**
 * MachineryPage — Machinery Regulation (EU) 2023/1230 Art. 18: which
 * integrations of this organisation talk to a machine, and what the
 * organisation declares about each of them.
 *
 * Reads `GET /api/compliance/machinery/detections` (be-1c):
 *   { scanned, matches: [{ source, id, label, signals: [{kind, value}],
 *                          confidence: 'high'|'low', subject_id,
 *                          assessment: { id, classification, attested_at, expires_at, current } | null }],
 *     skipped, manual_subjects: [{ subject_id, label, source: 'manual', assessment }],
 *     classifications }
 * A deployment without the detector answers **503 not_provisioned** — that is
 * its own state, never an empty table: "we found nothing" and "we did not look"
 * are different sentences.
 *
 * Writes `POST /machinery/subjects/:id/attest { classification, statement, evidence_refs }`
 * and reads the per-subject history from `GET /machinery/subjects/:id/attestations`.
 * The declaration is a human verdict: a detector finds an OPC-UA url, it cannot
 * know whether that url steers a safety function.
 */

export const ART18_CHECK_ID = 'MACHINERY-Art18-safety-component-assessment';

/** The Art. 18 vocabulary (server `machinery.js` CLASSIFICATIONS) in the order the drawer offers them. */
export const CLASSIFICATIONS = Object.freeze([
    Object.freeze({
        value: 'safety_component', tone: 'error',
        labelKey: 'compliance.mach_classification_safety_component', fallback: 'Safety component',
        hintKey: 'compliance.mach_classification_safety_component_hint',
        hintFallback: 'steers or monitors a safety function — conformity assessment applies',
    }),
    Object.freeze({
        value: 'monitoring_only', tone: 'warning',
        labelKey: 'compliance.mach_classification_monitoring_only', fallback: 'Monitoring only',
        hintKey: 'compliance.mach_classification_monitoring_only_hint',
        hintFallback: 'reads the machine, never commands it',
    }),
    Object.freeze({
        value: 'not_safety_component', tone: 'success',
        labelKey: 'compliance.mach_classification_not_safety_component', fallback: 'Not a safety component',
        hintKey: 'compliance.mach_classification_not_safety_component_hint',
        hintFallback: 'business data only — an ERP update is not a PLC',
    }),
]);

const CLASSIFICATION_TONE = Object.freeze({ safety_component: 'error', monitoring_only: 'warning', not_safety_component: 'success' });

/** Pure: detections + manual subjects as ONE list, manual rows last. `null` until loaded. */
export function subjectRows(body) {
    const o = asObject(body);
    if (!o) return null;
    const matches = Array.isArray(o.matches) ? o.matches : [];
    const manual = Array.isArray(o.manual_subjects) ? o.manual_subjects : [];
    return [
        ...matches.map(m => ({
            subject_id: m.subject_id || `${m.source}:${m.id}`,
            source: m.source || 'unknown',
            label: m.label || m.id || m.subject_id,
            signals: Array.isArray(m.signals) ? m.signals : [],
            confidence: m.confidence || 'low',
            assessment: m.assessment || null,
        })),
        ...manual.map(m => ({
            subject_id: m.subject_id,
            source: m.source || 'manual',
            label: m.label || m.subject_id,
            signals: [],
            confidence: 'manual',
            assessment: m.assessment || null,
        })),
    ];
}

/** Pure: the pill one row's assessment wears. */
export function assessmentPill(assessment) {
    if (!assessment || !assessment.classification) {
        return { tone: 'neutral', key: 'compliance.mach_not_assessed', fallback: 'Not assessed', expired: false };
    }
    const expired = assessment.current === false;
    const opt = CLASSIFICATIONS.find(c => c.value === assessment.classification) || null;
    return {
        tone: expired ? 'warning' : (CLASSIFICATION_TONE[assessment.classification] || 'neutral'),
        key: opt ? opt.labelKey : null,
        fallback: opt ? opt.fallback : assessment.classification,
        expired,
    };
}

/** Pure: a short, readable signal line ("scheme opc.tcp:// · port 4840"). */
export function signalText(signals, t) {
    if (!Array.isArray(signals) || signals.length === 0) return null;
    return signals
        .slice(0, 4)
        .map(s => `${t(`compliance.mach_signal_${s.kind}`, s.kind)} ${s.value}`)
        .join(' · ');
}

export default function MachineryPage(props) {
    const { isMobile = false, setHeaderActions, focusId, exportsEnabled = true, data = {} } = props;
    const { t } = useTranslation();
    const [readError, setReadError] = useState('');
    const res = useResource(`${API}/machinery/detections`, {
        parse: (b) => asObject(b),
        onError: (e) => { setReadError(String(e?.message || 'error')); return undefined; },
    });
    const rows = useMemo(() => subjectRows(res.data), [res.data]);
    const readFailed = res.failed && res.data === null;
    // 503 not_provisioned: the detector module is absent on this deployment.
    const notProvisioned = readFailed && /\b503\b/.test(readError);

    const [openId, setOpenId] = useState(null);
    const [history, setHistory] = useState(null);
    const [historyFailed, setHistoryFailed] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => { if (focusId) setOpenId(String(focusId)); }, [focusId]);

    useEffect(() => {
        setHeaderActions?.({ onRefreshMachinery: res.refresh });
        return () => setHeaderActions?.({});
    }, [setHeaderActions, res.refresh]);

    const openSubject = useCallback(async (subjectId) => {
        setOpenId(subjectId);
        setHistory(null);
        setHistoryFailed(false);
        try {
            const body = await fetchJson(`${API}/machinery/subjects/${encodeURIComponent(subjectId)}/attestations`);
            setHistory(Array.isArray(body) ? body : []);
        } catch {
            setHistoryFailed(true);
        }
    }, []);

    const selected = useMemo(() => (rows || []).find(r => r.subject_id === openId) || null, [rows, openId]);

    const attest = async ({ outcome, statement, evidence_refs: refs }) => {
        setBusy(true);
        try {
            await fetchJson(
                `${API}/machinery/subjects/${encodeURIComponent(openId)}/attest`,
                json({ classification: outcome, statement, evidence_refs: refs }),
            );
            await res.refresh();
            data.bump?.();
            await data.core?.refresh?.();
        } finally {
            setBusy(false);
        }
    };

    const columns = [
        { id: 'subject', width: '1fr', label: t('compliance.mach_col_subject', 'Integration') },
        { id: 'signals', width: '1.4fr', label: t('compliance.mach_col_signals', 'Signals'), foldBelow: 1180 },
        { id: 'confidence', width: '110px', label: t('compliance.mach_col_confidence', 'Confidence') },
        { id: 'assessment', width: '170px', label: t('compliance.mach_col_assessment', 'Declaration') },
        { id: 'valid', width: '140px', label: t('compliance.mach_col_valid', 'Valid'), foldBelow: 1180 },
        { id: 'action', width: '104px', label: '' },
    ];

    if (readFailed) {
        return (
            <div
                className="h-full min-h-0 overflow-y-auto p-3.5 @[1100px]/cpage:px-7 @[1100px]/cpage:py-[18px]"
                data-testid={notProvisioned ? 'machinery-page-unavailable' : 'machinery-page-failed'}
            >
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)] leading-4">
                    {notProvisioned
                        ? t('compliance.mach_not_provisioned', 'The industrial-integration detector is not installed on this deployment, so nothing was scanned. That is not the same as "no machines found".')
                        : t('compliance.mach_read_failed', 'The machine-integration scan could not be read.')}
                </div>
            </div>
        );
    }

    return (
        <div className="relative h-full min-h-0 overflow-y-auto p-3.5 @[1100px]/cpage:px-7 @[1100px]/cpage:py-[18px] flex flex-col gap-3.5 text-xs" data-testid="machinery-page">
            <section
                className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] px-3.5 py-3 flex items-start gap-2.5"
                style={{ boxShadow: 'var(--shadow-sm)' }}
                data-testid="mach-intro"
            >
                <Factory size={15} className="text-[var(--text-secondary)] shrink-0 mt-px" aria-hidden="true" />
                <div className="min-w-0 flex flex-col gap-1">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold">{t('compliance.mach_title', 'Machinery Regulation — safety components')}</span>
                        <ArticleRef refs={[{ regulation: 'MACHINERY', ref: '18' }]} testId="mach-article" />
                    </div>
                    <p className="text-[var(--text-secondary)] leading-4">
                        {t('compliance.mach_intro', 'Software that steers or monitors a safety function is a safety component from 20 January 2027. The scan finds integrations that speak to machines; only you can say whether such an integration touches a safety function — declare it here, with evidence.')}
                    </p>
                </div>
            </section>

            <DataTable
                columns={columns}
                rows={rows || []}
                loading={rows === null}
                isMobile={isMobile}
                rowKey={(r) => r.subject_id}
                ariaLabel={t('compliance.mach_title', 'Machinery Regulation — safety components')}
                testId="mach-table"
                empty={(
                    <EmptyState
                        title={t('compliance.mach_empty_title', 'No machine integrations found')}
                        description={t('compliance.mach_empty_desc', 'The scan found no OPC-UA, Modbus, MQTT, S7 or comparable signal in your integrations, automations or connections.')}
                    />
                )}
                renderCard={(row) => {
                    const pill = assessmentPill(row.assessment);
                    const signals = signalText(row.signals, t);
                    return (
                        <div className="w-full min-w-0 flex items-center gap-2" data-testid="mach-card" data-subject={row.subject_id}>
                            <div className="flex-1 min-w-0 flex flex-col gap-1">
                                <span className="text-xs font-medium truncate" data-testid="mach-label">{row.label}</span>
                                <span className="text-[10px] uppercase tracking-[.06em] text-[var(--text-tertiary)]" data-testid="mach-source">
                                    {t(`compliance.mach_source_${row.source}`, row.source)}
                                    <span className="normal-case tracking-normal"> · {t(`compliance.mach_confidence_${row.confidence}`, row.confidence)}</span>
                                </span>
                                {signals && <span className="text-[11px] text-[var(--text-secondary)] truncate" data-testid="mach-signals" title={signals}>{signals}</span>}
                                <span className="flex items-center gap-2 min-w-0">
                                    <StatusPill tone={pill.tone} testId="mach-assessment">
                                        {pill.key ? t(pill.key, pill.fallback) : pill.fallback}
                                        {pill.expired ? ` · ${t('compliance.mach_expired', 'expired')}` : ''}
                                    </StatusPill>
                                    {row.assessment?.expires_at && (
                                        <DeadlineClock dueAt={row.assessment.expires_at} startedAt={row.assessment.attested_at} variant="inline" testId="mach-clock" />
                                    )}
                                </span>
                            </div>
                            <button
                                type="button"
                                className="inline-flex flex-shrink-0 items-center gap-1 min-h-[44px] px-2.5 rounded-md border border-[var(--border-default)] text-[11px] font-medium"
                                onClick={() => openSubject(row.subject_id)}
                                data-testid="mach-attest"
                            >
                                <PenLine size={11} aria-hidden="true" />
                                {row.assessment ? t('compliance.mach_reassess', 'Re-declare') : t('compliance.mach_assess', 'Declare')}
                            </button>
                        </div>
                    );
                }}
                renderRow={(row, ctx) => {
                    const pill = assessmentPill(row.assessment);
                    const signals = signalText(row.signals, t);
                    return (
                        <TableRow
                            key={row.subject_id}
                            columns={ctx.columns}
                            accent={pill.tone === 'neutral' ? null : pill.tone}
                            selected={row.subject_id === openId}
                            testId="mach-row"
                        >
                            <TableCell column={ctx.columns[0]} className="min-w-0">
                                <div className="flex flex-col gap-0.5 min-w-0">
                                    <span className="font-medium truncate" data-testid="mach-label" data-subject={row.subject_id}>{row.label}</span>
                                    <span className="text-[10px] uppercase tracking-[.06em] text-[var(--text-tertiary)]" data-testid="mach-source">
                                        {t(`compliance.mach_source_${row.source}`, row.source)}
                                    </span>
                                </div>
                            </TableCell>
                            <TableCell column={ctx.columns[1]} className="min-w-0 text-[11px] text-[var(--text-secondary)]">
                                {signals
                                    ? <span className="truncate block" data-testid="mach-signals" title={signals}>{signals}</span>
                                    : <span className="text-[var(--text-tertiary)]">—</span>}
                            </TableCell>
                            <TableCell column={ctx.columns[2]}>
                                <span className="text-[11px] text-[var(--text-secondary)]" data-testid="mach-confidence" data-confidence={row.confidence}>
                                    {t(`compliance.mach_confidence_${row.confidence}`, row.confidence)}
                                </span>
                            </TableCell>
                            <TableCell column={ctx.columns[3]}>
                                <StatusPill tone={pill.tone} testId="mach-assessment">
                                    {pill.key ? t(pill.key, pill.fallback) : pill.fallback}
                                    {pill.expired ? ` · ${t('compliance.mach_expired', 'expired')}` : ''}
                                </StatusPill>
                            </TableCell>
                            <TableCell column={ctx.columns[4]}>
                                {row.assessment?.expires_at
                                    ? <DeadlineClock dueAt={row.assessment.expires_at} startedAt={row.assessment.attested_at} variant="row" testId="mach-clock" />
                                    : <span className="text-[11px] text-[var(--text-tertiary)]">—</span>}
                            </TableCell>
                            <TableCell column={ctx.columns[5]} align="right">
                                <button
                                    type="button"
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--border-default)] text-[11px] font-medium"
                                    onClick={() => openSubject(row.subject_id)}
                                    data-testid="mach-attest"
                                >
                                    <PenLine size={11} aria-hidden="true" />
                                    {row.assessment ? t('compliance.mach_reassess', 'Re-declare') : t('compliance.mach_assess', 'Declare')}
                                </button>
                            </TableCell>
                        </TableRow>
                    );
                }}
            />

            <AttestDrawer
                open={!!selected}
                uploadsEnabled={exportsEnabled}
                onClose={() => setOpenId(null)}
                title={selected?.label || ''}
                subtitle={t('compliance.mach_attest_subtitle', 'Does this integration steer or monitor a safety function?')}
                reference={selected?.subject_id || null}
                options={CLASSIFICATIONS}
                initialOutcome={selected?.assessment?.classification || null}
                outcomeLabel={t('compliance.mach_attest_outcome', 'Classification')}
                checkId={ART18_CHECK_ID}
                subjectId={selected?.subject_id || null}
                uploadSubjectType="machinery_subject"
                history={history}
                historyFailed={historyFailed}
                busy={busy}
                onSubmit={attest}
                testId="mach-drawer"
            />
        </div>
    );
}

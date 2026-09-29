import React, { useMemo } from 'react';
import { PenLine, Trash2 } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import EmptyState from '../../../../shared/EmptyState';
import SeverityTag from '../../shared/SeverityTag';
import StatusPill from '../../shared/StatusPill';
import VerificationChip from '../../shared/VerificationChip';

/**
 * CustomChecksTable — the items of one org-defined framework
 * (CHECK-CATALOGUE §3): reference · title · severity · evidence required ·
 * "satisfied by a built-in check" · the result the custom runner produced.
 *
 * Definition rows come from `GET /custom/frameworks/:id` (`checks[]`); the
 * RESULT of each item comes from the hub's `data.core.checks`, where the custom
 * runner's rows arrive as `{ regulation: 'CUSTOM', framework_code, article: <ref>, status, … }`.
 * They are joined on `framework_code + ref` — the client never rebuilds the
 * server's `CUSTOM-<CODE>-<REF>` id, because a slug rule that drifts would
 * silently show every item as pending.
 */

const STATUS_PILL = Object.freeze({
    pass: { tone: 'success', key: 'compliance.custom_status_pass', fallback: 'Satisfied' },
    warn: { tone: 'warning', key: 'compliance.custom_status_warn', fallback: 'Attention' },
    fail: { tone: 'error', key: 'compliance.custom_status_fail', fallback: 'Not satisfied' },
    na: { tone: 'neutral', key: 'compliance.custom_status_na', fallback: 'Not applicable' },
    pending: { tone: 'neutral', key: 'compliance.custom_status_pending', fallback: 'Not attested' },
});

export function statusPill(status) {
    return STATUS_PILL[status] || STATUS_PILL.pending;
}

/** Pure: index the hub's check rows by `<framework_code>#<ref>` for a cheap join. */
export function indexResults(checks) {
    const map = new Map();
    for (const row of Array.isArray(checks) ? checks : []) {
        if (!row || row.regulation !== 'CUSTOM' || !row.framework_code) continue;
        map.set(`${row.framework_code}#${row.article}`, row);
    }
    return map;
}

/** Pure: the definition rows joined with their latest result. */
export function joinChecks(checks, results, frameworkCode) {
    if (!Array.isArray(checks)) return null;
    const index = results instanceof Map ? results : indexResults(results);
    return checks.map(c => ({ ...c, result: index.get(`${frameworkCode}#${c.ref}`) || null }));
}

export default function CustomChecksTable({
    checks,
    results = null,
    frameworkCode,
    builtinChecks = null,
    busyId = null,
    isMobile = false,
    onAttest,
    onMap,
    onDelete,
    testId = 'custom-checks',
}) {
    const { t } = useTranslation();
    const rows = useMemo(() => joinChecks(checks, results, frameworkCode), [checks, results, frameworkCode]);

    const columns = [
        { id: 'ref', width: '110px', label: t('compliance.custom_col_ref', 'Ref') },
        { id: 'title', width: '1fr', label: t('compliance.custom_col_title', 'Item') },
        { id: 'severity', width: '90px', label: t('compliance.custom_col_severity', 'Severity') },
        { id: 'mapped', width: '210px', label: t('compliance.custom_col_mapped', 'Satisfied by'), foldBelow: 1180 },
        { id: 'status', width: '140px', label: t('compliance.custom_col_status', 'Result') },
        { id: 'action', width: '110px', label: '' },
    ];

    return (
        <DataTable
            columns={columns}
            rows={rows || []}
            loading={rows === null}
            isMobile={isMobile}
            rowKey={(r) => r.id}
            ariaLabel={t('compliance.custom_checks_aria', 'Framework items')}
            testId={testId}
            empty={(
                <EmptyState
                    title={t('compliance.custom_checks_empty_title', 'No items yet')}
                    description={t('compliance.custom_checks_empty_desc', 'Paste the questionnaire, or add items one by one. Each item is attested by a person — with evidence where the item asks for it.')}
                />
            )}
            renderCard={(row) => {
                const pill = statusPill(row.result?.status || 'pending');
                const mapped = row.mapped_check_id || '';
                return (
                    <div className="w-full min-w-0 flex flex-col gap-1.5" data-testid={`${testId}-card`}>
                        <span className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate" data-testid={`${testId}-ref`}>{row.ref}</span>
                            <StatusPill tone={pill.tone} testId={`${testId}-status`} title={row.result?.details || undefined}>
                                {t(pill.key, pill.fallback)}
                            </StatusPill>
                        </span>
                        <span className="text-xs font-medium truncate" data-testid={`${testId}-title`}>{row.title}</span>
                        {row.description && <span className="text-[11px] text-[var(--text-secondary)] truncate">{row.description}</span>}
                        <span className="flex items-center gap-1.5">
                            <SeverityTag severity={row.severity} testId={`${testId}-severity`} />
                            {row.evidence_required && (
                                <VerificationChip verification="attestation" minimal testId={`${testId}-evidence-required`} />
                            )}
                        </span>
                        <select
                            value={mapped}
                            onChange={(e) => onMap?.(row, e.target.value || null)}
                            disabled={busyId === row.id || builtinChecks === null}
                            className="w-full min-h-[44px] rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] px-2 text-[11px] text-[var(--text-primary)] disabled:opacity-60"
                            aria-label={t('compliance.custom_col_mapped', 'Satisfied by')}
                            data-testid={`${testId}-mapped`}
                        >
                            <option value="">{t('compliance.custom_mapped_none', 'attested by a person')}</option>
                            {(builtinChecks || []).map(c => (
                                <option key={c.id} value={c.id}>{c.id}</option>
                            ))}
                            {mapped && !(builtinChecks || []).some(c => c.id === mapped) && (
                                <option value={mapped}>{mapped}</option>
                            )}
                        </select>
                        <span className="flex items-center gap-2">
                            <button
                                type="button"
                                className="inline-flex items-center gap-1 min-h-[44px] px-2.5 rounded-md border border-[var(--border-default)] text-[11px] font-medium disabled:opacity-60"
                                onClick={() => onAttest?.(row)}
                                disabled={!!row.mapped_check_id || busyId === row.id}
                                title={row.mapped_check_id ? t('compliance.custom_attest_mapped_hint', 'This item follows a built-in check — it is not attested by hand.') : undefined}
                                data-testid={`${testId}-attest`}
                            >
                                <PenLine size={11} aria-hidden="true" />
                                {t('compliance.custom_attest', 'Attest')}
                            </button>
                            {onDelete && (
                                <button
                                    type="button"
                                    className="inline-grid place-items-center h-11 w-11 rounded-md text-[var(--text-tertiary)] disabled:opacity-60"
                                    onClick={() => onDelete(row)}
                                    disabled={busyId === row.id}
                                    aria-label={t('common.delete', 'Delete')}
                                    data-testid={`${testId}-delete`}
                                >
                                    <Trash2 size={14} aria-hidden="true" />
                                </button>
                            )}
                        </span>
                    </div>
                );
            }}
            renderRow={(row, ctx) => {
                const pill = statusPill(row.result?.status || 'pending');
                const mapped = row.mapped_check_id || '';
                return (
                    <TableRow key={row.id} columns={ctx.columns} accent={pill.tone === 'neutral' ? null : pill.tone} testId={`${testId}-row`}>
                        <TableCell column={ctx.columns[0]} className="min-w-0">
                            <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate block" data-testid={`${testId}-ref`}>{row.ref}</span>
                        </TableCell>
                        <TableCell column={ctx.columns[1]} className="min-w-0">
                            <div className="flex flex-col gap-0.5 min-w-0">
                                <span className="font-medium truncate" data-testid={`${testId}-title`}>{row.title}</span>
                                {row.description && <span className="text-[11px] text-[var(--text-secondary)] truncate">{row.description}</span>}
                            </div>
                        </TableCell>
                        <TableCell column={ctx.columns[2]} className="flex items-center gap-1.5">
                            <SeverityTag severity={row.severity} testId={`${testId}-severity`} />
                            {row.evidence_required && (
                                <VerificationChip verification="attestation" minimal testId={`${testId}-evidence-required`} />
                            )}
                        </TableCell>
                        <TableCell column={ctx.columns[3]} className="min-w-0">
                            <select
                                value={mapped}
                                onChange={(e) => onMap?.(row, e.target.value || null)}
                                disabled={busyId === row.id || builtinChecks === null}
                                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] disabled:opacity-60"
                                aria-label={t('compliance.custom_col_mapped', 'Satisfied by')}
                                data-testid={`${testId}-mapped`}
                            >
                                <option value="">{t('compliance.custom_mapped_none', 'attested by a person')}</option>
                                {(builtinChecks || []).map(c => (
                                    <option key={c.id} value={c.id}>{c.id}</option>
                                ))}
                                {mapped && !(builtinChecks || []).some(c => c.id === mapped) && (
                                    <option value={mapped}>{mapped}</option>
                                )}
                            </select>
                        </TableCell>
                        <TableCell column={ctx.columns[4]}>
                            <StatusPill tone={pill.tone} testId={`${testId}-status`} title={row.result?.details || undefined}>
                                {t(pill.key, pill.fallback)}
                            </StatusPill>
                        </TableCell>
                        <TableCell column={ctx.columns[5]} align="right" className="flex items-center gap-1 justify-end">
                            <button
                                type="button"
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md border border-[var(--border-default)] text-[11px] font-medium disabled:opacity-60"
                                onClick={() => onAttest?.(row)}
                                disabled={!!row.mapped_check_id || busyId === row.id}
                                title={row.mapped_check_id ? t('compliance.custom_attest_mapped_hint', 'This item follows a built-in check — it is not attested by hand.') : undefined}
                                data-testid={`${testId}-attest`}
                            >
                                <PenLine size={11} aria-hidden="true" />
                                {t('compliance.custom_attest', 'Attest')}
                            </button>
                            {onDelete && (
                                <button
                                    type="button"
                                    className="p-1 rounded-md text-[var(--text-tertiary)] disabled:opacity-60"
                                    onClick={() => onDelete(row)}
                                    disabled={busyId === row.id}
                                    aria-label={t('common.delete', 'Delete')}
                                    data-testid={`${testId}-delete`}
                                >
                                    <Trash2 size={12} aria-hidden="true" />
                                </button>
                            )}
                        </TableCell>
                    </TableRow>
                );
            }}
        />
    );
}

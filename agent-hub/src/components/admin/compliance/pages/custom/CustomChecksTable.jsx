import { PenLine, Trash2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import EmptyState from '../../../../shared/EmptyState';
import { REGULATION_LABEL, formatRef, regulationLabel } from '../../shared/ArticleRef';
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

const REGULATION_ORDER = Object.keys(REGULATION_LABEL);
const byArticle = (a, b) => String(a.article ?? '').localeCompare(String(b.article ?? ''), 'en', { numeric: true })
    || String(a.id).localeCompare(String(b.id));

/**
 * Pure: the built-in catalogue (`GET /registry` checks) for the "Satisfied by"
 * picker, one group per law in the rail's order, each sorted by article. The
 * option reads as the check's title, never its raw id.
 */
export function groupBuiltinChecks(checks, t) {
    if (!Array.isArray(checks)) return [];
    const groups = new Map();
    for (const c of checks) {
        if (!c || !c.id) continue;
        const code = String(c.regulation ?? '').toUpperCase();
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code).push(c);
    }
    const rank = (code) => { const i = REGULATION_ORDER.indexOf(code); return i === -1 ? REGULATION_ORDER.length : i; };
    return [...groups.entries()]
        .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
        .map(([code, list]) => ({
            regulation: code,
            label: regulationLabel(code, t) || code,
            checks: [...list].sort(byArticle).map(c => ({
                id: c.id,
                label: [formatRef(c.article), c.titleKey ? t(c.titleKey, c.id) : c.id].filter(Boolean).join(' · '),
            })),
        }));
}

/** The "Satisfied by" control: a person, or one built-in check, by title and grouped by law. */
function MappedSelect({ row, groups, builtinChecks, busy, onMap, className, testId, t }) {
    const mapped = row.mapped_check_id || '';
    const known = groups.some(g => g.checks.some(c => c.id === mapped));
    return (
        <select
            value={mapped}
            onChange={(e) => onMap?.(row, e.target.value || null)}
            disabled={busy || builtinChecks === null}
            className={className}
            aria-label={t('compliance.custom_col_mapped', 'Satisfied by')}
            data-testid={testId}
        >
            <option value="">{t('compliance.custom_mapped_none', 'attested by a person')}</option>
            {groups.map(g => (
                <optgroup key={g.regulation} label={g.label}>
                    {g.checks.map(c => <option key={c.id} value={c.id} title={c.id}>{c.label}</option>)}
                </optgroup>
            ))}
            {mapped && !known && <option value={mapped} title={mapped}>{mapped}</option>}
        </select>
    );
}

/**
 * The delete button, and once pressed the question in its place: "Delete this
 * item?" Delete / Cancel. Nothing is deleted until the second press; Cancel
 * (or Escape) puts the button back and focus on it.
 */
function DeleteControl({ row, busy, onDelete, compact, testId, t }) {
    const [asking, setAsking] = useState(false);
    const confirmRef = useRef(null);
    const triggerRef = useRef(null);
    const wasAsking = useRef(false);
    useEffect(() => {
        if (asking) confirmRef.current?.focus();
        else if (wasAsking.current) triggerRef.current?.focus();
        wasAsking.current = asking;
    }, [asking]);
    const question = t('compliance.custom_delete_confirm', 'Delete this item?');
    if (!asking) {
        return (
            <button
                ref={triggerRef}
                type="button"
                className={compact
                    ? 'p-1 rounded-md text-[var(--text-tertiary)] disabled:opacity-60'
                    : 'inline-grid place-items-center h-11 w-11 rounded-md text-[var(--text-tertiary)] disabled:opacity-60'}
                onClick={() => setAsking(true)}
                disabled={busy}
                aria-label={t('common.delete', 'Delete')}
                data-testid={`${testId}-delete`}
            >
                <Trash2 size={compact ? 12 : 14} aria-hidden="true" />
            </button>
        );
    }
    const button = compact ? 'px-2 py-0.5' : 'min-h-[44px] px-2.5';
    return (
        <span
            role="group"
            aria-label={question}
            className={compact
                ? 'absolute right-0 top-1/2 -translate-y-1/2 z-10 flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2 py-1 shadow-[var(--shadow-sm)]'
                : 'flex items-center gap-2 flex-wrap'}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAsking(false); } }}
            data-testid={`${testId}-delete-confirm`}
        >
            <span className="text-[11px] font-medium text-[var(--text-primary)]">{question}</span>
            <button
                ref={confirmRef}
                type="button"
                className={`${button} rounded-md border border-[var(--error)] bg-[var(--error)]/10 text-[11px] font-semibold text-[var(--error-ink)] disabled:opacity-60`}
                onClick={() => { setAsking(false); onDelete(row); }}
                disabled={busy}
                data-testid={`${testId}-delete-yes`}
            >
                {t('common.delete', 'Delete')}
            </button>
            <button
                type="button"
                className={`${button} rounded-md border border-[var(--border-default)] text-[11px] font-medium`}
                onClick={() => setAsking(false)}
                data-testid={`${testId}-delete-cancel`}
            >
                {t('common.cancel', 'Cancel')}
            </button>
        </span>
    );
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
    const groups = useMemo(() => groupBuiltinChecks(builtinChecks, t), [builtinChecks, t]);

    const columns = [
        { id: 'ref', width: '110px', label: t('compliance.custom_col_ref', 'Ref') },
        { id: 'title', width: '1fr', label: t('compliance.custom_col_title', 'Item') },
        { id: 'severity', width: '90px', label: t('compliance.custom_col_severity', 'Severity') },
        // An action, not a detail: it never folds away.
        { id: 'mapped', width: '180px', label: t('compliance.custom_col_mapped', 'Satisfied by') },
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
                        <MappedSelect
                            row={row}
                            groups={groups}
                            builtinChecks={builtinChecks}
                            busy={busyId === row.id}
                            onMap={onMap}
                            className="w-full min-h-[44px] rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] px-2 text-[11px] text-[var(--text-primary)] disabled:opacity-60"
                            testId={`${testId}-mapped`}
                            t={t}
                        />
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
                            {onDelete && <DeleteControl row={row} busy={busyId === row.id} onDelete={onDelete} testId={testId} t={t} />}
                        </span>
                    </div>
                );
            }}
            renderRow={(row, ctx) => {
                const pill = statusPill(row.result?.status || 'pending');
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
                        <TableCell column={ctx.columns[2]} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                            <SeverityTag severity={row.severity} testId={`${testId}-severity`} />
                            {row.evidence_required && (
                                <VerificationChip verification="attestation" minimal testId={`${testId}-evidence-required`} />
                            )}
                        </TableCell>
                        <TableCell column={ctx.columns[3]} className="min-w-0">
                            <MappedSelect
                                row={row}
                                groups={groups}
                                builtinChecks={builtinChecks}
                                busy={busyId === row.id}
                                onMap={onMap}
                                className="w-full rounded-md border border-[var(--border-default)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)] disabled:opacity-60"
                                testId={`${testId}-mapped`}
                                t={t}
                            />
                        </TableCell>
                        <TableCell column={ctx.columns[4]}>
                            <StatusPill tone={pill.tone} testId={`${testId}-status`} title={row.result?.details || undefined}>
                                {t(pill.key, pill.fallback)}
                            </StatusPill>
                        </TableCell>
                        <TableCell column={ctx.columns[5]} align="right" className="relative flex items-center gap-1 justify-end">
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
                            {onDelete && <DeleteControl row={row} busy={busyId === row.id} onDelete={onDelete} compact testId={testId} t={t} />}
                        </TableCell>
                    </TableRow>
                );
            }}
        />
    );
}

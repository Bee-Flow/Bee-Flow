import React, { useMemo, useState } from 'react';
import { Plug, PlugZap } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import DeadlineClock from '../../../shared/DeadlineClock';
import EmptyState from '../../../shared/EmptyState';
import StatusPill from '../shared/StatusPill';
import { fmtStamp, Intro, ReadFailed, RegisterLayout } from './audits/auditForms';
import ConnectorDrawer from './connectors/ConnectorDrawer';

/**
 * ConnectorsPage — the ISO evidence connectors (code hosting, cloud, identity,
 * monitoring) on the shared table + drawer pattern.
 *
 * `data.connectors = { connectors, busyId, refresh, save(id, patch),
 * sweep(id), loadConnections(id) }` — the legacy page's onSave/onSweep/
 * onLoadConnections. Sweeps run every six hours plus on demand, so the "next
 * sweep" column is a clock on `last_sweep_at + 6 h`; a connector that has never
 * swept has no clock, not an overdue one.
 */

export const SWEEP_INTERVAL_HOURS = 6;

export function nextSweepAt(cfg, hours = SWEEP_INTERVAL_HOURS) {
    const at = cfg?.last_sweep_at;
    if (!at) return null;
    const ms = new Date(at).getTime();
    if (Number.isNaN(ms)) return null;
    return new Date(ms + hours * 3600_000).toISOString();
}

/** success = swept cleanly · error = last sweep failed · warning = on but never swept · neutral = off. */
export function toneOfConnector(cfg) {
    if (!cfg?.enabled) return 'neutral';
    if (cfg.last_status === 'ok') return 'success';
    if (cfg.last_status === 'error') return 'error';
    return 'warning';
}

const COLUMNS = Object.freeze([
    Object.freeze({ id: 'connector', label: 'compliance.conn_col_connector', width: '1fr' }),
    Object.freeze({ id: 'status', label: 'compliance.conn_col_status', width: '150px' }),
    Object.freeze({ id: 'last', label: 'compliance.conn_col_last', width: '170px', foldBelow: 1180 }),
    Object.freeze({ id: 'next', label: 'compliance.conn_col_next', width: '170px' }),
]);
const COLUMN_FALLBACKS = Object.freeze({ connector: 'Connector', status: 'Status', last: 'Last sweep', next: 'Next sweep' });

export default function ConnectorsPage({ data = {}, isMobile = false, focusId = null }) {
    const { t, resolvedLocale } = useTranslation();
    const state = data.connectors || {};
    const list = state.connectors;

    const loading = list === null || list === undefined;
    const failed = !loading && !Array.isArray(list);
    const rows = Array.isArray(list) ? list : [];

    const [openId, setOpenId] = useState(focusId ? String(focusId) : null);
    const selected = useMemo(() => rows.find(c => String(c.id) === String(openId)) || null, [rows, openId]);

    const columns = COLUMNS.map(c => ({ ...c, label: t(c.label, COLUMN_FALLBACKS[c.id]) }));

    const statusLabel = (cfg) => {
        if (!cfg?.enabled) return t('compliance.conn_status_off', 'Off');
        if (cfg.last_status === 'ok') return t('compliance.conn_status_ok', 'Collecting');
        if (cfg.last_status === 'error') return t('compliance.conn_status_error', 'Last sweep failed');
        return t('compliance.conn_never_swept', 'Never swept');
    };

    const drawer = selected && (
        <ConnectorDrawer
            connector={selected}
            busy={state.busyId === selected.id}
            onLoadConnections={state.loadConnections}
            onSave={state.save}
            onSweep={state.sweep}
            onClose={() => setOpenId(null)}
            mode={isMobile ? 'modal' : 'inline'}
        />
    );

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="connectors-page"
            drawer={drawer}
            toolbar={(
                <Intro testId="connectors-intro">
                    {t('compliance.conn_intro', 'Couple the systems that already hold your evidence. Credentials stay in the integrations vault — a connector only points at one, and a changed snapshot re-runs the controls it covers.')}
                </Intro>
            )}
        >
            {failed ? (
                <ReadFailed testId="connectors-failed">
                    {t('compliance.conn_read_failed', 'The connector list could not be read.')}
                </ReadFailed>
            ) : (
                <DataTable
                    columns={columns}
                    rows={rows}
                    loading={loading}
                    isMobile={isMobile}
                    ariaLabel={t('compliance.rail_connectors', 'Evidence connectors')}
                    testId="connectors-table"
                    empty={<EmptyState title={t('compliance.conn_empty', 'No evidence connectors available')} />}
                    renderRow={(c, ctx) => {
                        const cfg = c.config || null;
                        const tone = toneOfConnector(cfg);
                        const due = nextSweepAt(cfg);
                        const Icon = cfg?.enabled ? PlugZap : Plug;
                        return (
                            <TableRow
                                columns={ctx.columns}
                                accent={tone === 'neutral' ? null : tone}
                                selected={String(openId) === String(c.id)}
                                onClick={() => setOpenId(prev => (String(prev) === String(c.id) ? null : c.id))}
                                testId={`connectors-row-${c.id}`}
                            >
                                <TableCell column={ctx.columns[0]}>
                                    <span className="flex items-center gap-2 min-w-0">
                                        <Icon size={14} aria-hidden="true" className="shrink-0 text-[var(--text-tertiary)]" />
                                        <span className="flex flex-col min-w-0">
                                            <span className="font-semibold text-[var(--text-primary)] truncate">{t(c.titleKey, c.titleKey)}</span>
                                            <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                                                {(c.covered_controls || []).join(' · ') || t(c.descKey, c.descKey)}
                                            </span>
                                        </span>
                                        {!c.credential && (
                                            <StatusPill tone="neutral" testId={`connectors-nocred-${c.id}`}>
                                                {t('compliance.conn_no_credential', 'No credential needed')}
                                            </StatusPill>
                                        )}
                                    </span>
                                </TableCell>
                                <TableCell column={ctx.columns[1]}>
                                    <StatusPill tone={tone} testId={`connectors-status-${c.id}`}>{statusLabel(cfg)}</StatusPill>
                                </TableCell>
                                <TableCell column={ctx.columns[2]}>
                                    <span className="text-[var(--text-secondary)] whitespace-nowrap" data-testid={`connectors-last-${c.id}`}>
                                        {cfg?.last_sweep_at ? fmtStamp(cfg.last_sweep_at, resolvedLocale) : '—'}
                                    </span>
                                </TableCell>
                                <TableCell column={ctx.columns[3]}>
                                    {due && cfg?.enabled
                                        ? <DeadlineClock dueAt={due} startedAt={cfg.last_sweep_at} variant="inline" testId={`connectors-clock-${c.id}`} />
                                        : <span className="text-[var(--text-tertiary)]">—</span>}
                                </TableCell>
                            </TableRow>
                        );
                    }}
                    renderCard={(c) => (
                        <button
                            type="button"
                            onClick={() => setOpenId(prev => (String(prev) === String(c.id) ? null : c.id))}
                            className="w-full text-left flex flex-col gap-1 px-3.5 py-2.5"
                            data-testid={`connectors-card-${c.id}`}
                        >
                            <span className="text-xs font-semibold text-[var(--text-primary)]">{t(c.titleKey, c.titleKey)}</span>
                            <span className="text-[11px] text-[var(--text-tertiary)]">{statusLabel(c.config)}</span>
                        </button>
                    )}
                />
            )}
        </RegisterLayout>
    );
}

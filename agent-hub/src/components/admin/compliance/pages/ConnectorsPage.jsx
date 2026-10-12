import React, { useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import EmptyState from '../../../shared/EmptyState';
import StatusPill from '../shared/StatusPill';
import useDrawerMode from '../shared/useDrawerMode';
import { Intro, ReadFailed, RegisterLayout } from './audits/auditForms';
import ConnectorDrawer, { CONNECTOR_DRAWER_WIDTH } from './connectors/ConnectorDrawer';
import {
    SWEEP_INTERVAL_HOURS, nextSweepAt, statusLabel, sweepIsLate, sweepText, toneOfConnector,
} from './connectors/connectorStatus';

/**
 * ConnectorsPage — the ISO evidence connectors (code hosting, cloud, identity,
 * monitoring) in two blocks:
 *
 *   Collecting   the connectors that are on: a table of name + covered
 *                controls, status (connectorStatus.statusLabel) and the sweep
 *                as plain text, "Swept … · next ~…", in warning ink only once
 *                a sweep is a whole interval late. A background job is not a
 *                legal deadline, so it gets no DeadlineClock.
 *   Available    the connectors that are off: one compact line each (name ·
 *                covered controls · "no credential needed") with a ghost
 *                "Set up" that opens the same drawer.
 *
 * The row stripe shows only a problem (error or warning). The drawer goes
 * beside the table, over it or into a dialog by the width the register has
 * (useDrawerMode).
 *
 * `data.connectors = { connectors, busyId, refresh, save(id, patch),
 * sweep(id), loadConnections(id) }` — the legacy page's onSave/onSweep/
 * onLoadConnections.
 */

export { SWEEP_INTERVAL_HOURS, nextSweepAt, toneOfConnector };

const COLUMNS = Object.freeze([
    Object.freeze({ id: 'connector', label: 'compliance.conn_col_connector', width: '1fr' }),
    Object.freeze({ id: 'status', label: 'compliance.conn_col_status', width: '150px' }),
    Object.freeze({ id: 'sweep', label: 'compliance.conn_col_sweep', width: '240px' }),
]);
const COLUMN_FALLBACKS = Object.freeze({ connector: 'Connector', status: 'Status', sweep: 'Sweep' });
const PROBLEM_TONES = new Set(['error', 'warning']);

const controlsOf = (c) => (Array.isArray(c.covered_controls) ? c.covered_controls.join(' · ') : '');

export default function ConnectorsPage({ data = {}, isMobile = false, focusId = null }) {
    const { t, resolvedLocale } = useTranslation();
    const state = data.connectors || {};
    const list = state.connectors;

    const loading = list === null || list === undefined;
    const failed = !loading && !Array.isArray(list);
    const rows = useMemo(() => (Array.isArray(list) ? list : []), [list]);
    const active = rows.filter(c => c.config?.enabled);
    const available = rows.filter(c => !c.config?.enabled);

    const [openId, setOpenId] = useState(focusId ? String(focusId) : null);
    const selected = useMemo(() => rows.find(c => String(c.id) === String(openId)) || null, [rows, openId]);
    const [frameRef, drawerMode] = useDrawerMode({ isMobile, drawerWidth: CONNECTOR_DRAWER_WIDTH });
    const toggleOpen = (id) => setOpenId(prev => (String(prev) === String(id) ? null : id));

    const columns = COLUMNS.map(c => ({ ...c, label: t(c.label, COLUMN_FALLBACKS[c.id]) }));
    const locale = resolvedLocale || 'en';

    const drawer = selected && (
        <ConnectorDrawer
            connector={selected}
            busy={state.busyId === selected.id}
            onLoadConnections={state.loadConnections}
            onSave={state.save}
            onSweep={state.sweep}
            onClose={() => setOpenId(null)}
            mode={drawerMode}
        />
    );

    const sweepCell = (c) => {
        const text = sweepText(t, c.config, locale);
        if (!text) return <span className="text-[var(--text-tertiary)]">—</span>;
        const late = sweepIsLate(c.config);
        return (
            <span className={late ? 'text-[var(--warning-ink)]' : 'text-[var(--text-secondary)]'} data-testid={`connectors-sweep-${c.id}`} data-late={late || undefined}>
                {text}
            </span>
        );
    };

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="connectors-page"
            drawer={drawer}
            drawerMode={drawerMode}
            frameRef={frameRef}
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
                <>
                    {!loading && rows.length === 0 && (
                        <EmptyState title={t('compliance.conn_empty', 'No evidence connectors available')} />
                    )}
                    {(loading || rows.length > 0) && (
                        <section className="flex flex-col gap-2" aria-labelledby="connectors-active-title" data-testid="connectors-active">
                            <h3 id="connectors-active-title" className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                                {loading ? t('compliance.conn_status_ok', 'Collecting') : t('compliance.conn_group_active', 'Collecting ({n})', { n: active.length })}
                            </h3>
                            <DataTable
                                columns={columns}
                                rows={active}
                                loading={loading}
                                isMobile={isMobile}
                                cardsBelow={560}
                                ariaLabel={t('compliance.rail_connectors', 'Evidence connectors')}
                                testId="connectors-table"
                                empty={<p className="m-0 text-xs text-[var(--text-tertiary)]">{t('compliance.conn_none_collecting', 'Nothing collects yet. Set up a connector below.')}</p>}
                                renderRow={(c, ctx) => {
                                    const tone = toneOfConnector(c.config);
                                    return (
                                        <TableRow
                                            columns={ctx.columns}
                                            accent={PROBLEM_TONES.has(tone) ? tone : null}
                                            selected={String(openId) === String(c.id)}
                                            onClick={() => toggleOpen(c.id)}
                                            testId={`connectors-row-${c.id}`}
                                        >
                                            <TableCell column={ctx.columns[0]}>
                                                <span className="flex flex-col min-w-0">
                                                    <span className="font-semibold text-[var(--text-primary)] truncate" title={t(c.titleKey, c.titleKey)}>{t(c.titleKey, c.titleKey)}</span>
                                                    <span className="text-[11px] text-[var(--text-tertiary)] truncate" title={controlsOf(c) || undefined}>{controlsOf(c) || t(c.descKey, c.descKey)}</span>
                                                </span>
                                            </TableCell>
                                            <TableCell column={ctx.columns[1]}>
                                                <StatusPill tone={tone} testId={`connectors-status-${c.id}`}>{statusLabel(t, c.config)}</StatusPill>
                                            </TableCell>
                                            <TableCell column={ctx.columns[2]}>{sweepCell(c)}</TableCell>
                                        </TableRow>
                                    );
                                }}
                                renderCard={(c) => (
                                    <button
                                        type="button"
                                        onClick={() => toggleOpen(c.id)}
                                        className="w-full text-left flex flex-col gap-1"
                                        data-testid={`connectors-card-${c.id}`}
                                    >
                                        <span className="flex items-center gap-2 min-w-0">
                                            <span className="flex-1 min-w-0 text-xs font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]">{t(c.titleKey, c.titleKey)}</span>
                                            <StatusPill tone={toneOfConnector(c.config)} testId={`connectors-card-status-${c.id}`}>{statusLabel(t, c.config)}</StatusPill>
                                        </span>
                                        <span className="text-[11px] text-[var(--text-tertiary)] [overflow-wrap:anywhere]">
                                            {[controlsOf(c), sweepText(t, c.config, locale)].filter(Boolean).join(' · ')}
                                        </span>
                                    </button>
                                )}
                            />
                        </section>
                    )}
                    {!loading && available.length > 0 && (
                        <AvailableList connectors={available} openId={openId} onOpen={setOpenId} t={t} />
                    )}
                </>
            )}
        </RegisterLayout>
    );
}

/** The connectors that are off: one line each, with a ghost "Set up" that opens the drawer. */
function AvailableList({ connectors, openId, onOpen, t }) {
    return (
        <section className="flex flex-col gap-2" aria-labelledby="connectors-available-title" data-testid="connectors-available">
            <h3 id="connectors-available-title" className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                {t('compliance.conn_group_available', 'Available ({n})', { n: connectors.length })}
            </h3>
            <ul className="@container m-0 p-0 list-none rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden shadow-[var(--shadow-sm)]">
                {connectors.map(c => {
                    const name = t(c.titleKey, c.titleKey);
                    const current = String(openId) === String(c.id);
                    return (
                        <li
                            key={c.id}
                            className={`flex items-center gap-3 px-3.5 py-2 border-b border-[var(--border-default)] last:border-b-0 text-xs ${current ? 'bg-[var(--bg-secondary)]' : ''}`}
                            data-testid={`connectors-row-${c.id}`}
                            data-selected={current || undefined}
                        >
                            {/* One line on a wide list (name · controls · no credential); on a
                                narrow one the meta drops under the name, without a leading dot. */}
                            <span className="flex-1 min-w-0 flex flex-col gap-0.5 @[480px]:flex-row @[480px]:flex-wrap @[480px]:items-baseline @[480px]:gap-x-1.5">
                                <span id={`connectors-name-${c.id}`} className="font-semibold text-[var(--text-primary)] [overflow-wrap:anywhere]">{name}</span>
                                {(controlsOf(c) || !c.credential) && (
                                    <span className="text-[11px] text-[var(--text-tertiary)]">
                                        <span aria-hidden="true" className="hidden @[480px]:inline">· </span>
                                        {controlsOf(c)}
                                        {!c.credential && (
                                            <span data-testid={`connectors-nocred-${c.id}`}>
                                                {controlsOf(c) ? ' · ' : ''}{t('compliance.conn_no_credential', 'no credential needed')}
                                            </span>
                                        )}
                                    </span>
                                )}
                            </span>
                            <button
                                type="button"
                                onClick={() => onOpen(current ? null : c.id)}
                                aria-expanded={current}
                                aria-describedby={`connectors-name-${c.id}`}
                                className="h-7 px-2.5 shrink-0 inline-flex items-center rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                                data-testid={`connectors-setup-${c.id}`}
                            >
                                {t('compliance.conn_setup', 'Set up')}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}

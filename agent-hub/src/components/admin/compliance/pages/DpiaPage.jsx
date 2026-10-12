import React, { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../shared/DataTable';
import EmptyState from '../../../shared/EmptyState';
import useDrawerMode from '../shared/useDrawerMode';
import { Intro, RegisterLayout } from './audits/auditForms';
import DpiaDrawer, { DpiaPill, DPIA_DRAWER_WIDTH } from './dpia/DpiaDrawer';

export { defaultExpiry } from './dpia/DpiaDrawer';

/**
 * DpiaPage — data-protection impact assessments (GDPR Art. 35), one row per
 * high-risk agent.
 *
 * The rows are derived from the per-source Art-35 check results (they carry the
 * agent id/name and the risk reason in their evidence), joined with what is on
 * record. A row's pill says it in words: "Assessed 14 Jul" or "No DPIA", with
 * how and until when in its tooltip; the stripe is the check's status. The
 * risk reason is a column while the table is 900px wide and a line under the
 * agent's name below that, so the Art. 35 trigger never folds away.
 *
 * Opening a row opens dpia/DpiaDrawer: the recorded assessment as a summary,
 * or the questionnaire for an agent with none. Both paths persist through
 * `data.dpia.save(agentId, body)`. Where the drawer goes follows the width
 * the register has (useDrawerMode): beside the table while the table keeps
 * room, over it otherwise, a dialog on a phone.
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

const COLUMNS = Object.freeze([
    Object.freeze({ id: 'agent', label: 'compliance.dpia_col_agent', width: '1fr' }),
    Object.freeze({ id: 'reason', label: 'compliance.dpia_col_reason', width: '1fr', foldBelow: 900 }),
    Object.freeze({ id: 'status', label: 'compliance.dpia_col_status', width: '150px' }),
]);
const COLUMN_FALLBACKS = Object.freeze({ agent: 'Agent', reason: 'Why it is high-risk', status: 'DPIA' });

/** The stripe: the Art-35 check's own status for this agent. */
function accentOf(status) {
    if (status === 'pass') return 'success';
    return status === 'warn' ? 'warning' : 'error';
}

export default function DpiaPage({ data = {}, isMobile = false, focusId = null, exportsEnabled = true, dl }) {
    const { t } = useTranslation();
    const state = data.dpia || {};
    const core = data.core || {};

    const dpiaList = state.dpiaList;
    const loading = dpiaList === null || dpiaList === undefined;
    const rows = dpiaRows(core.checks, dpiaList);

    const [openId, setOpenId] = useState(focusId ? String(focusId) : null);
    const selected = rows.find(r => String(r.agentId) === String(openId)) || null;
    const [frameRef, drawerMode] = useDrawerMode({ isMobile, drawerWidth: DPIA_DRAWER_WIDTH });

    const columns = COLUMNS.map(c => ({ ...c, label: t(c.label, COLUMN_FALLBACKS[c.id]) }));
    const openRow = (row) => setOpenId(prev => (String(prev) === String(row.agentId) ? null : row.agentId));

    const pdfUrl = selected?.dpia && exportsEnabled && typeof state.pdfUrlFor === 'function' && typeof dl === 'function'
        ? dl(state.pdfUrlFor(selected.agentId))
        : null;

    // Keyed on the agent and the record's stamp: another agent, or a save that
    // landed, mounts a fresh drawer (see DpiaDrawer).
    const drawer = selected && (
        <DpiaDrawer
            key={`${selected.agentId}|${selected.dpia?.approved_at ?? ''}`}
            row={selected}
            mode={drawerMode}
            saving={state.savingId === selected.agentId}
            pdfUrl={pdfUrl}
            onSave={(agentId, body) => state.save?.(agentId, body)}
            onClose={() => setOpenId(null)}
        />
    );

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="dpia-page"
            drawer={drawer}
            drawerMode={drawerMode}
            frameRef={frameRef}
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
                renderRow={(r, ctx) => (
                    <TableRow
                        columns={ctx.columns}
                        accent={accentOf(r.status)}
                        selected={String(openId) === String(r.agentId)}
                        onClick={() => openRow(r)}
                        testId={`dpia-row-${r.agentId}`}
                    >
                        <TableCell column={ctx.columns[0]}>
                            <span className="flex flex-col gap-0.5 min-w-0">
                                <span className="font-semibold text-[var(--text-primary)] truncate">{r.agentName}</span>
                                {r.riskReason && (
                                    <span className={`${TABLE_FOLDED_ONLY[900]} text-[11px] text-[var(--text-tertiary)] [overflow-wrap:anywhere]`} data-testid={`dpia-reason-line-${r.agentId}`}>
                                        {r.riskReason}
                                    </span>
                                )}
                            </span>
                        </TableCell>
                        <TableCell column={ctx.columns[1]}>
                            <span className="text-[var(--text-secondary)] [overflow-wrap:anywhere]">{r.riskReason || '—'}</span>
                        </TableCell>
                        <TableCell column={ctx.columns[2]}>
                            <DpiaPill dpia={r.dpia} testId={`dpia-status-${r.agentId}`} />
                        </TableCell>
                    </TableRow>
                )}
                renderCard={(r) => (
                    <button type="button" onClick={() => openRow(r)} className="w-full min-w-0 text-left flex flex-col items-start gap-1" data-testid={`dpia-card-${r.agentId}`}>
                        <span className="text-xs font-semibold text-[var(--text-primary)]">{r.agentName}</span>
                        {r.riskReason && <span className="text-[11px] text-[var(--text-tertiary)] [overflow-wrap:anywhere]">{r.riskReason}</span>}
                        <DpiaPill dpia={r.dpia} testId={`dpia-card-status-${r.agentId}`} />
                    </button>
                )}
            />
        </RegisterLayout>
    );
}

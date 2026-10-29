import { Plus, Play, CheckCircle2 } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
    AUDIT_STATUS, labelOf, toneOf, userName, fmtDate, ActionButton, Fact, Intro, RegisterLayout,
} from './auditForms';
import { notRaisedCount } from './isoProcessHelpers';
import useHeaderPrimary from './useHeaderPrimary';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '@/components/shared/DataTable';
import EmptyState from '@/components/shared/EmptyState';
import SideDrawer, { DrawerSection, DrawerFooter } from '@/components/shared/SideDrawer';
import RegisterStatePill from '../../shared/RegisterStatePill';
import useDrawerMode from '../../shared/useDrawerMode';
import type { OrgUser } from '../accessAuditLabels';
import type { SetHeaderActions } from './useHeaderPrimary';
import type { TableColumn } from '@/components/shared/DataTable';
import { AddFindingSection, AuditCard, AuditFindingsList, AuditPlanFields, type Audit, type AuditDraft, type AuditFindingRow, type FindingDraft } from './AuditsTabParts';

/**
 * AuditsTab — internal audits (clause 9.2): planned → in progress → closed,
 * with findings. The table lists the audits; the drawer holds one audit's
 * scope, its findings and the add-finding form, or the plan-audit form.
 *
 * Every mutation goes through the hook's handlers (data.audit.createAudit /
 * updateAudit / addFinding / createNc) — the toasts live there.
 *
 * The state steps live in the drawer only. "Close audit" has no way back,
 * so it asks first, and the question counts what is still open: how many
 * findings there are and how many of the weighty ones were never raised as
 * a nonconformity (isoProcessHelpers' notRaisedCount).
 */
const EMPTY_DRAFT: Readonly<AuditDraft> = Object.freeze({ title: '', scope_note: '', auditor_user_id: '', planned_at: '' });
const EMPTY_FINDING: Readonly<FindingDraft> = Object.freeze({ severity: 'observation', control_ref: '', clause: '', description: '', evidence_ref: '' });

interface AuditsTabArgs {
    audit: {
        audits?: Audit[] | null;
        findings?: AuditFindingRow[] | null;
        busy?: boolean;
        independenceWarning?: string | null;
        createAudit: (body: { title: string; scope_note: string | undefined; auditor_user_id: string | undefined; planned_at: string | undefined }) => unknown;
        updateAudit: (id: number, patch: { status: string }) => unknown;
        addFinding: (auditId: string | number, body: { severity: string; control_ref: string | undefined; clause: string | undefined; description: string; evidence_ref: string | undefined }) => unknown;
        createNc: (body: { title: string; description: string; source: string; severity: string; finding_id: string | number }) => unknown;
    };
    orgUsers: OrgUser[] | null;
    isMobile?: boolean | undefined;
    focusId?: string | number | null;
    setHeaderActions?: SetHeaderActions;
}

/** The audit table's columns; auditor and date fold below 900px. */
function auditColumns(t: TranslateFn): TableColumn[] {
    return [
    { id: 'title', width: '1fr', label: t('compliance.audit_f_title', 'Audit title') },
    { id: 'status', width: '120px', label: t('compliance.obj_col_status', 'Status') },
    { id: 'auditor', width: '140px', label: t('compliance.audit_f_auditor', 'Auditor'), foldBelow: 900 },
    { id: 'planned', width: '104px', label: t('compliance.audit_f_planned', 'Planned date'), foldBelow: 900 },
    { id: 'findings', width: '84px', label: t('compliance.audit_findings', 'Findings'), align: 'right' },
    ];
}

export default function AuditsTab({ audit, orgUsers, isMobile = false, focusId = null, setHeaderActions = undefined }: AuditsTabArgs) {
    const { t, resolvedLocale } = useTranslation();
    const { audits, findings, busy, independenceWarning, createAudit, updateAudit, addFinding, createNc } = audit;
    const loading = audits === null || audits === undefined || findings === null || findings === undefined;
    const list = useMemo(() => (Array.isArray(audits) ? audits : []), [audits]);

    const [selectedId, setSelectedId] = useState<string | number | null>(focusId || null);
    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState<Readonly<AuditDraft>>(EMPTY_DRAFT);
    const [findingDrafts, setFindingDrafts] = useState<Record<string | number, Readonly<FindingDraft>>>({});
    // The audit whose "Close audit?" question is open; another row asks afresh.
    const [confirmCloseId, setConfirmCloseId] = useState<number | null>(null);
    const [frameRef, drawerMode] = useDrawerMode({ isMobile });
    const [prevFocusId, setPrevFocusId] = useState(focusId);
    if (prevFocusId !== focusId) {
        setPrevFocusId(focusId);
        if (focusId) setSelectedId(String(focusId));
    }
    const planLabel = t('compliance.audit_plan', 'Plan audit');
    const headerHasCreate = useHeaderPrimary(setHeaderActions, {
        label: planLabel, icon: Plus, onClick: () => { setSelectedId(null); setCreating(true); },
    });

    const findingsByAudit = useMemo(() => {
        const map = new Map();
        for (const f of (Array.isArray(findings) ? findings : [])) {
            if (!map.has(f.audit_id)) map.set(f.audit_id, []);
            map.get(f.audit_id).push(f);
        }
        return map;
    }, [findings]);
    const selected = useMemo(() => list.find(a => String(a.id) === String(selectedId)) || null, [list, selectedId]);

    const columns = auditColumns(t);

    const submitCreate = () => {
        if (!draft.title.trim()) return;
        createAudit({
            title: draft.title.trim(),
            scope_note: draft.scope_note.trim() || undefined,
            auditor_user_id: draft.auditor_user_id || undefined,
            planned_at: draft.planned_at || undefined,
        });
        setDraft(EMPTY_DRAFT);
        setCreating(false);
    };

    const setFinding = (auditId: string|number, patch: Partial<FindingDraft>) =>
        setFindingDrafts(d => ({ ...d, [auditId]: { ...(d[auditId] || EMPTY_FINDING), ...patch } }));
    const submitFinding = (auditId: string|number) => {
        const f = findingDrafts[auditId] || EMPTY_FINDING;
        if (!f.description.trim()) return;
        addFinding(auditId, {
            severity: f.severity,
            control_ref: f.control_ref.trim() || undefined,
            clause: f.clause.trim() || undefined,
            description: f.description.trim(),
            evidence_ref: f.evidence_ref.trim() || undefined,
        });
        setFindingDrafts(d => ({ ...d, [auditId]: EMPTY_FINDING }));
    };
    const raiseNc = (a: Audit, f: AuditFindingRow) => {
        createNc({
            title: String(f.description).slice(0, 120),
            description: `${t('compliance.audit_nc_from', 'From internal audit')} "${a.title}"${f.control_ref ? ` (${f.control_ref})` : ''}: ${f.description}`,
            source: 'internal_audit',
            severity: f.severity === 'major' ? 'major' : 'minor',
            finding_id: f.id,
        });
    };

    /** The drawer's footer: Start audit, or Close audit behind its question. */
    const transition = (a: Audit, rows: AuditFindingRow[]) => {
        if (a.status === 'planned') {
            return (
                <DrawerFooter testId="audit-footer"
                    primary={<ActionButton variant="primary" icon={Play} disabled={busy} onClick={() => updateAudit(a.id, { status: 'in_progress' })} data-testid={`audit-start-${a.id}`}>{t('compliance.audit_start', 'Start audit')}</ActionButton>} />
            );
        }
        if (a.status !== 'in_progress') return null;
        if (String(confirmCloseId) !== String(a.id)) {
            return (
                <DrawerFooter testId="audit-footer"
                    primary={<ActionButton variant="success" icon={CheckCircle2} disabled={busy} onClick={() => setConfirmCloseId(a.id)} data-testid={`audit-close-${a.id}`}>{t('compliance.audit_close', 'Close audit')}</ActionButton>} />
            );
        }
        return (
            <div className="flex flex-col gap-2 pt-3 border-t border-[var(--border-default)]" role="group" aria-labelledby={`audit-close-q-${a.id}`} data-testid="audit-close-confirm">
                <div id={`audit-close-q-${a.id}`} className="text-xs text-[var(--text-primary)]">
                    {t('compliance.audit_close_confirm', 'Close audit? {n} findings, {m} not raised as NC.', { n: rows.length, m: notRaisedCount(rows) })}
                </div>
                <div className="flex items-center gap-2">
                    <ActionButton onClick={() => setConfirmCloseId(null)} data-testid="audit-close-cancel">{t('compliance.audit_cancel', 'Cancel')}</ActionButton>
                    <ActionButton variant="primary" icon={CheckCircle2} disabled={busy} className="ml-auto" autoFocus
                        onClick={() => { setConfirmCloseId(null); updateAudit(a.id, { status: 'closed' }); }} data-testid="audit-close-confirm-yes">
                        {t('compliance.audit_close', 'Close audit')}
                    </ActionButton>
                </div>
            </div>
        );
    };

    let drawer: React.JSX.Element | null = null;
    if (creating) {
        drawer = (
            <SideDrawer open onClose={() => setCreating(false)} mode={drawerMode} ariaLabel={planLabel} testId="audit-create-drawer"
                header={<div className="text-[13px] font-semibold text-[var(--text-primary)]">{planLabel}</div>}
                footer={(
                    <div className="flex gap-2">
                        <ActionButton variant="primary" disabled={busy || !draft.title.trim()} onClick={submitCreate} data-testid="audit-create-submit">{t('compliance.audit_create', 'Plan audit')}</ActionButton>
                        <ActionButton onClick={() => setCreating(false)}>{t('compliance.audit_cancel', 'Cancel')}</ActionButton>
                    </div>
                )}>
                <AuditPlanFields t={t} draft={draft} setDraft={setDraft} orgUsers={orgUsers} independenceWarning={independenceWarning} />
            </SideDrawer>
        );
    } else if (selected) {
        const a = selected;
        const rows: AuditFindingRow[] = findingsByAudit.get(a.id) || [];
        const fd = findingDrafts[a.id] || EMPTY_FINDING;
        drawer = (
            <SideDrawer open onClose={() => { setSelectedId(null); setConfirmCloseId(null); }} mode={drawerMode} ariaLabel={a.title} testId="audit-drawer"
                header={(
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{a.title}</span>
                        <RegisterStatePill state={a.status} testId="audit-drawer-state">{labelOf(t, AUDIT_STATUS, a.status)}</RegisterStatePill>
                    </div>
                )}
                footer={transition(a, rows)}>
                <DrawerSection label={t('compliance.audit_f_scope', 'Scope')}>
                    <div className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap">{a.scope_note || '—'}</div>
                    <Fact label={t('compliance.audit_f_auditor', 'Auditor')}>{userName(orgUsers, a.auditor_user_id) || '—'}</Fact>
                    <Fact label={t('compliance.audit_planned_on', 'Planned')}>{fmtDate(a.planned_at, resolvedLocale)}</Fact>
                    {a.started_at && <Fact label={t('compliance.audit_started_on', 'Started')}>{fmtDate(a.started_at, resolvedLocale)}</Fact>}
                    {a.closed_at && <Fact label={t('compliance.audit_closed_on', 'Closed')}>{fmtDate(a.closed_at, resolvedLocale)}</Fact>}
                </DrawerSection>
                <DrawerSection label={t('compliance.audit_findings', 'Findings')} hint={rows.length ? String(rows.length) : undefined}>
                    <AuditFindingsList t={t} rows={rows} busy={busy} onRaiseNc={(f) => raiseNc(a, f)} />
                </DrawerSection>
                {a.status !== 'closed' && (
                    <AddFindingSection t={t} fd={fd} busy={busy} onChange={(patch) => setFinding(a.id, patch)} onSubmit={() => submitFinding(a.id)} />
                )}
            </SideDrawer>
        );
    }

    return (
        <RegisterLayout isMobile={isMobile} drawerMode={drawerMode} frameRef={frameRef} testId="audits-tab" drawer={drawer}
            toolbar={(
                <>
                    <Intro>{t('compliance.audit_subtitle', 'Plan and run internal audits (clause 9.2). Record what was examined and what was found — findings with real weight become nonconformities with corrective actions.')}</Intro>
                    {!headerHasCreate && <ActionButton variant="primary" icon={Plus} onClick={() => { setSelectedId(null); setCreating(true); }} data-testid="audit-plan">{planLabel}</ActionButton>}
                </>
            )}>
            <DataTable
                columns={columns}
                rows={list}
                loading={loading}
                isMobile={isMobile}
                rowKey={(a) => a.id}
                ariaLabel={t('compliance.audit_tab', 'Internal audits')}
                testId="audits-table"
                empty={<EmptyState title={t('compliance.audit_empty_title', 'No internal audits yet')} description={t('compliance.audit_empty', 'No internal audits yet. Clause 9.2 expects audits at planned intervals — plan the first one to start the programme.')} />}
                renderCard={(a) => (
                    <AuditCard t={t} a={a} findingCount={(findingsByAudit.get(a.id) || []).length} isSelected={!creating && String(selectedId) === String(a.id)}
                        orgUsers={orgUsers} locale={resolvedLocale}
                        onToggle={() => { setCreating(false); setConfirmCloseId(null); setSelectedId(prev => (String(prev) === String(a.id) ? null : a.id)); }} />
                )}
                renderRow={(a, ctx) => {
                    const n = (findingsByAudit.get(a.id) || []).length;
                    const isSelected = !creating && String(selectedId) === String(a.id);
                    return (
                        <TableRow key={a.id} columns={ctx.columns} accent={toneOf(AUDIT_STATUS, a.status)} selected={isSelected}
                            onClick={() => { setCreating(false); setConfirmCloseId(null); setSelectedId(prev => (String(prev) === String(a.id) ? null : a.id)); }} testId={`audit-row-${a.id}`}>
                            <TableCell column={ctx.columns[0]} className="min-w-0">
                                <div className="font-semibold text-[var(--text-primary)] truncate">{a.title}</div>
                                {a.scope_note && <div className="text-[11px] text-[var(--text-tertiary)] truncate">{a.scope_note}</div>}
                                {/* Auditor and planned date while their own columns are folded. */}
                                <div className="text-[11px] text-[var(--text-secondary)] truncate">
                                    <span className={TABLE_FOLDED_ONLY[900]} data-testid={`audit-folded-${a.id}`}>
                                        {t('compliance.audit_auditor_planned', '{auditor} · planned {date}', { auditor: userName(orgUsers, a.auditor_user_id) || '—', date: fmtDate(a.planned_at, resolvedLocale) })}
                                    </span>
                                </div>
                            </TableCell>
                            <TableCell column={ctx.columns[1]}><RegisterStatePill state={a.status} testId={`audit-state-${a.id}`}>{labelOf(t, AUDIT_STATUS, a.status)}</RegisterStatePill></TableCell>
                            <TableCell column={ctx.columns[2]} className="truncate text-[var(--text-secondary)]">{userName(orgUsers, a.auditor_user_id) || '—'}</TableCell>
                            <TableCell column={ctx.columns[3]} className="text-[var(--text-secondary)] tabular-nums">{fmtDate(a.planned_at, resolvedLocale)}</TableCell>
                            <TableCell column={ctx.columns[4]} className="tabular-nums text-[var(--text-secondary)]">{n}</TableCell>
                        </TableRow>
                    );
                }}
            />
        </RegisterLayout>
    );
}

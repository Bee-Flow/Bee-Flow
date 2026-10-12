import { Plus, Play, CheckCircle2, ArrowRight } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import {
    AUDIT_STATUS, FINDING_SEVERITY, labelOf, toneOf, userName, fmtDate,
    Field, TextInput, TextArea, DateInput, Select, UserSelect, ActionButton, Fact, Intro, RegisterLayout,
} from './auditForms';
import { notRaisedCount } from './isoProcessHelpers';
import useHeaderPrimary from './useHeaderPrimary';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../../shared/DataTable';
import EmptyState from '../../../../shared/EmptyState';
import FindingRow from '../../../../shared/FindingRow';
import SideDrawer, { DrawerSection, DrawerFooter } from '../../../../shared/SideDrawer';
import RegisterStatePill from '../../shared/RegisterStatePill';
import StatusPill from '../../shared/StatusPill';
import useDrawerMode from '../../shared/useDrawerMode';

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
const EMPTY_DRAFT = Object.freeze({ title: '', scope_note: '', auditor_user_id: '', planned_at: '' });
const EMPTY_FINDING = Object.freeze({ severity: 'observation', control_ref: '', clause: '', description: '', evidence_ref: '' });

export default function AuditsTab({ audit, orgUsers, isMobile = false, focusId = null, setHeaderActions = undefined }) {
    const { t, resolvedLocale } = useTranslation();
    const { audits, findings, busy, independenceWarning, createAudit, updateAudit, addFinding, createNc } = audit;
    const loading = audits === null || audits === undefined || findings === null || findings === undefined;
    const list = useMemo(() => (Array.isArray(audits) ? audits : []), [audits]);

    const [selectedId, setSelectedId] = useState(focusId || null);
    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [findingDrafts, setFindingDrafts] = useState({});
    // The audit whose "Close audit?" question is open; another row asks afresh.
    const [confirmCloseId, setConfirmCloseId] = useState(null);
    const [frameRef, drawerMode] = useDrawerMode({ isMobile });
    useEffect(() => { if (focusId) setSelectedId(String(focusId)); }, [focusId]);
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

    const columns = [
        { id: 'title', width: '1fr', label: t('compliance.audit_f_title', 'Audit title') },
        { id: 'status', width: '120px', label: t('compliance.obj_col_status', 'Status') },
        { id: 'auditor', width: '140px', label: t('compliance.audit_f_auditor', 'Auditor'), foldBelow: 900 },
        { id: 'planned', width: '104px', label: t('compliance.audit_f_planned', 'Planned date'), foldBelow: 900 },
        { id: 'findings', width: '84px', label: t('compliance.audit_findings', 'Findings'), align: 'right' },
    ];

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

    const setFinding = (auditId, patch) =>
        setFindingDrafts(d => ({ ...d, [auditId]: { ...(d[auditId] || EMPTY_FINDING), ...patch } }));
    const submitFinding = (auditId) => {
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
    const raiseNc = (a, f) => {
        createNc({
            title: String(f.description).slice(0, 120),
            description: `${t('compliance.audit_nc_from', 'From internal audit')} "${a.title}"${f.control_ref ? ` (${f.control_ref})` : ''}: ${f.description}`,
            source: 'internal_audit',
            severity: f.severity === 'major' ? 'major' : 'minor',
            finding_id: f.id,
        });
    };

    /** The drawer's footer: Start audit, or Close audit behind its question. */
    const transition = (a, rows) => {
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

    let drawer = null;
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
                <Field label={t('compliance.audit_f_title', 'Audit title')}>
                    <TextInput value={draft.title} autoFocus onChange={v => setDraft(d => ({ ...d, title: v }))} data-testid="audit-f-title" />
                </Field>
                <Field label={t('compliance.audit_f_scope', 'Scope')}>
                    <TextArea value={draft.scope_note} placeholder={t('compliance.audit_f_scope_ph', 'Which controls, processes or teams does this audit cover?')} onChange={v => setDraft(d => ({ ...d, scope_note: v }))} />
                </Field>
                <Field label={t('compliance.audit_f_auditor', 'Auditor')}>
                    <UserSelect value={draft.auditor_user_id} orgUsers={orgUsers} noneLabel={t('compliance.audit_auditor_none', 'Select auditor…')} onChange={v => setDraft(d => ({ ...d, auditor_user_id: v }))} data-testid="audit-f-auditor" />
                </Field>
                <Field label={t('compliance.audit_f_planned', 'Planned date')}>
                    <DateInput value={draft.planned_at} onChange={v => setDraft(d => ({ ...d, planned_at: v }))} />
                </Field>
                {independenceWarning && (
                    <FindingRow size="sm" severity="warning" label={t('compliance.audit_independence_title', 'Auditor independence')} message={independenceWarning} testId="audit-independence" />
                )}
            </SideDrawer>
        );
    } else if (selected) {
        const a = selected;
        const rows = findingsByAudit.get(a.id) || [];
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
                    {rows.length === 0 ? (
                        <div className="text-xs text-[var(--text-tertiary)]">{t('compliance.audit_no_findings', 'No findings recorded for this audit.')}</div>
                    ) : rows.map(f => (
                        <div key={f.id} className="flex flex-col gap-1 py-1.5 border-b border-[var(--border-default)] last:border-b-0" data-testid={`audit-finding-${f.id}`}>
                            <div className="flex flex-wrap items-center gap-1.5">
                                <StatusPill tone={toneOf(FINDING_SEVERITY, f.severity)}>{labelOf(t, FINDING_SEVERITY, f.severity)}</StatusPill>
                                {f.control_ref && <span className="font-mono text-[11px] text-[var(--text-secondary)]">{f.control_ref}</span>}
                                {f.clause && <span className="font-mono text-[11px] text-[var(--text-secondary)]">{t('compliance.audit_f_clause', 'Clause')} {f.clause}</span>}
                            </div>
                            <div className="text-xs text-[var(--text-secondary)]">
                                {f.description}
                                {f.evidence_ref && <span className="text-[11px] text-[var(--text-tertiary)]"> · {f.evidence_ref}</span>}
                            </div>
                            {f.nonconformity_id ? (
                                <span className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.audit_nc_raised', 'Raised as NC')} #{f.nonconformity_id}</span>
                            ) : (f.severity !== 'observation' && (
                                <ActionButton size="sm" variant="error" icon={ArrowRight} disabled={busy} onClick={() => raiseNc(a, f)} className="self-start" data-testid={`audit-raise-nc-${f.id}`}>
                                    {t('compliance.audit_raise_nc', 'Raise as nonconformity')}
                                </ActionButton>
                            ))}
                        </div>
                    ))}
                </DrawerSection>
                {a.status !== 'closed' && (
                    <DrawerSection label={t('compliance.audit_add_finding', 'Add finding')}>
                        <div className="grid grid-cols-2 gap-2">
                            <Field label={t('compliance.audit_f_severity', 'Severity')}>
                                <Select value={fd.severity} onChange={v => setFinding(a.id, { severity: v })} data-testid="audit-finding-severity"
                                    options={Object.keys(FINDING_SEVERITY).map(k => ({ value: k, label: labelOf(t, FINDING_SEVERITY, k) }))} />
                            </Field>
                            <Field label={t('compliance.audit_f_control', 'Control ref')}>
                                <TextInput value={fd.control_ref} placeholder="A.5.15" onChange={v => setFinding(a.id, { control_ref: v })} />
                            </Field>
                            <Field label={t('compliance.audit_f_clause', 'Clause')}>
                                <TextInput value={fd.clause} placeholder="9.2" onChange={v => setFinding(a.id, { clause: v })} />
                            </Field>
                            <Field label={t('compliance.audit_f_evidence', 'Evidence ref (optional)')}>
                                <TextInput value={fd.evidence_ref} onChange={v => setFinding(a.id, { evidence_ref: v })} />
                            </Field>
                        </div>
                        <Field label={t('compliance.audit_f_finding', 'What was observed')}>
                            <TextArea value={fd.description} placeholder={t('compliance.audit_f_finding_ph', 'What was examined, what the evidence showed, and where it falls short…')} onChange={v => setFinding(a.id, { description: v })} data-testid="audit-finding-description" />
                        </Field>
                        <ActionButton icon={Plus} disabled={busy || !fd.description.trim()} onClick={() => submitFinding(a.id)} className="self-start" data-testid="audit-finding-submit">
                            {t('compliance.audit_add_finding', 'Add finding')}
                        </ActionButton>
                    </DrawerSection>
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
                renderCard={(a) => {
                    const n = (findingsByAudit.get(a.id) || []).length;
                    const isSelected = !creating && String(selectedId) === String(a.id);
                    return (
                        <div className="w-full min-w-0 flex items-center gap-2" data-testid={`audit-card-${a.id}`} data-selected={isSelected || undefined}>
                            <button
                                type="button"
                                onClick={() => { setCreating(false); setConfirmCloseId(null); setSelectedId(prev => (String(prev) === String(a.id) ? null : a.id)); }}
                                aria-selected={isSelected || undefined}
                                className="flex-1 min-w-0 text-left min-h-[44px] flex flex-col justify-center gap-1"
                            >
                                <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{a.title}</span>
                                {a.scope_note && <span className="text-[11px] text-[var(--text-tertiary)] truncate">{a.scope_note}</span>}
                                <span className="flex items-center gap-2 min-w-0 text-[11px] text-[var(--text-secondary)]">
                                    <RegisterStatePill state={a.status} testId={`audit-card-state-${a.id}`}>{labelOf(t, AUDIT_STATUS, a.status)}</RegisterStatePill>
                                    <span className="truncate">{userName(orgUsers, a.auditor_user_id) || '—'}</span>
                                    <span className="tabular-nums whitespace-nowrap">{fmtDate(a.planned_at, resolvedLocale)}</span>
                                    <span className="tabular-nums">{t('compliance.audit_findings', 'Findings')} {n}</span>
                                </span>
                            </button>
                        </div>
                    );
                }}
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

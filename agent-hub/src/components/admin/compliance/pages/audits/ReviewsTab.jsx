import React, { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import SideDrawer, { DrawerSection } from '../../../../shared/SideDrawer';
import EmptyState from '../../../../shared/EmptyState';
import {
    userName, fmtDate, Field, DateInput, TextArea, UserChecklist, ActionButton, Intro, RegisterLayout,
} from './auditForms';

/**
 * ReviewsTab — management reviews (clause 9.3). The 9.3.2 inputs are
 * auto-collected (`mrInputs`) and shown as the agenda card; recording a
 * review snapshots them with HUMAN minutes. Nothing here generates minutes.
 */
const labelize = (k) => String(k).replace(/_/g, ' ');
export function fmtVal(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (Array.isArray(v)) return v.map(x => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x))).join(', ') || '—';
    if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${labelize(k)}: ${typeof x === 'object' && x !== null ? JSON.stringify(x) : x}`).join(' · ');
    return String(v);
}

function MrInputRows({ inputs, testId }) {
    return (
        <div className="flex flex-col gap-1.5" data-testid={testId}>
            {Object.entries(inputs).map(([k, v]) => (
                <div key={k} className="flex gap-2.5 text-xs items-baseline">
                    <div className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)] min-w-[140px] shrink-0">{labelize(k)}</div>
                    <div className="text-[var(--text-secondary)] [overflow-wrap:anywhere]">{fmtVal(v)}</div>
                </div>
            ))}
        </div>
    );
}

const EMPTY_DRAFT = Object.freeze({ held_at: '', attendees: [], decisions: '' });

export default function ReviewsTab({ audit, orgUsers, isMobile = false, focusId = null }) {
    const { t, resolvedLocale } = useTranslation();
    const { reviews, mrInputs, busy, createReview } = audit;
    const loading = reviews === null || reviews === undefined;
    const list = Array.isArray(reviews) ? reviews : [];
    const hasInputs = mrInputs && typeof mrInputs === 'object' && Object.keys(mrInputs).length > 0;

    const [selectedId, setSelectedId] = useState(focusId || null);
    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    useEffect(() => { if (focusId) setSelectedId(String(focusId)); }, [focusId]);
    const selected = useMemo(() => list.find(r => String(r.id) === String(selectedId)) || null, [list, selectedId]);

    const attendeeNames = (r) => (Array.isArray(r.attendees) ? r.attendees : [])
        .map(a => (a && typeof a === 'object') ? (a.name || a.id) : String(a));

    const submit = () => {
        if (!draft.held_at) return;
        createReview({
            held_at: draft.held_at,
            attendees: draft.attendees.map(id => ({ id, name: userName(orgUsers, id) })),
            decisions: draft.decisions.trim() || undefined,
            inputs: mrInputs || {},
        });
        setDraft(EMPTY_DRAFT);
        setCreating(false);
    };

    const columns = [
        { id: 'held', width: '120px', label: t('compliance.mr_f_held', 'Held on') },
        { id: 'attendees', width: '1fr', label: t('compliance.mr_attendees', 'Attendees') },
        { id: 'decisions', width: '1.4fr', label: t('compliance.mr_decisions', 'Decisions'), foldBelow: 1180 },
    ];

    const drawerMode = isMobile ? 'modal' : 'inline';
    let drawer = null;
    if (creating) {
        drawer = (
            <SideDrawer open onClose={() => setCreating(false)} mode={drawerMode} ariaLabel={t('compliance.mr_record', 'Record review')} testId="review-create-drawer"
                header={<div className="text-[13px] font-semibold text-[var(--text-primary)]">{t('compliance.mr_record', 'Record review')}</div>}
                footer={(
                    <div className="flex flex-col gap-2">
                        <div className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.mr_minutes_note', 'Minutes are written by a person, never generated — the review is only worth what leadership actually decided.')}</div>
                        <div className="flex gap-2">
                            <ActionButton variant="primary" disabled={busy || !draft.held_at} onClick={submit} data-testid="review-create-submit">{t('compliance.mr_create', 'Record minutes')}</ActionButton>
                            <ActionButton onClick={() => setCreating(false)}>{t('compliance.audit_cancel', 'Cancel')}</ActionButton>
                        </div>
                    </div>
                )}>
                <Field label={t('compliance.mr_f_held', 'Held on')}>
                    <DateInput value={draft.held_at} autoFocus onChange={v => setDraft(d => ({ ...d, held_at: v }))} data-testid="review-f-held" />
                </Field>
                <Field label={t('compliance.mr_f_attendees', 'Attendees')}>
                    <UserChecklist value={draft.attendees} orgUsers={orgUsers} onChange={v => setDraft(d => ({ ...d, attendees: v }))} testId="review-f-attendees" />
                </Field>
                <Field label={t('compliance.mr_f_decisions', 'Decisions & actions (minutes)')}>
                    <TextArea rows={5} value={draft.decisions} placeholder={t('compliance.mr_f_decisions_ph', 'What did management decide? Resource changes, risk acceptances, improvement actions…')} onChange={v => setDraft(d => ({ ...d, decisions: v }))} data-testid="review-f-decisions" />
                </Field>
            </SideDrawer>
        );
    } else if (selected) {
        const r = selected;
        const snapshot = r.inputs && typeof r.inputs === 'object' && Object.keys(r.inputs).length > 0;
        drawer = (
            <SideDrawer open onClose={() => setSelectedId(null)} mode={drawerMode} ariaLabel={`${t('compliance.mr_held_on', 'Held')} ${fmtDate(r.held_at, resolvedLocale)}`} testId="review-drawer"
                header={<div className="text-[13px] font-semibold text-[var(--text-primary)]">{t('compliance.mr_held_on', 'Held')} {fmtDate(r.held_at, resolvedLocale)}</div>}>
                <DrawerSection label={t('compliance.mr_attendees', 'Attendees')}>
                    <div className="text-xs text-[var(--text-secondary)]">{attendeeNames(r).join(', ') || '—'}</div>
                </DrawerSection>
                <DrawerSection label={t('compliance.mr_decisions', 'Decisions')}>
                    <div className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap" data-testid="review-decisions">{r.decisions || '—'}</div>
                </DrawerSection>
                {snapshot && (
                    <DrawerSection label={t('compliance.mr_show_inputs', 'Inputs snapshot')}>
                        <MrInputRows inputs={r.inputs} testId="review-snapshot" />
                    </DrawerSection>
                )}
            </SideDrawer>
        );
    }

    return (
        <RegisterLayout isMobile={isMobile} testId="reviews-tab" drawer={drawer}
            toolbar={(
                <>
                    <Intro>{t('compliance.mr_subtitle', 'Management reviews (clause 9.3): leadership looks at the ISMS inputs and decides. The agenda below is collected automatically — the minutes and decisions are yours.')}</Intro>
                    <ActionButton variant="primary" icon={Plus} onClick={() => { setSelectedId(null); setCreating(true); }} data-testid="review-record">{t('compliance.mr_record', 'Record review')}</ActionButton>
                </>
            )}>
            <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3.5 flex flex-col gap-2" data-testid="mr-inputs" style={{ boxShadow: 'var(--shadow-sm)' }}>
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">{t('compliance.mr_inputs_title', 'Review inputs (clause 9.3.2)')}</div>
                <div className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.mr_inputs_hint', 'Auto-collected from live compliance data — bring this agenda to the meeting. Recording a review snapshots these inputs with the minutes.')}</div>
                {hasInputs
                    ? <MrInputRows inputs={mrInputs} />
                    : <div className="text-xs text-[var(--text-tertiary)]">{t('compliance.mr_no_inputs', 'No inputs collected yet — run the compliance checks first so the review has something to look at.')}</div>}
            </section>
            <DataTable
                columns={columns}
                rows={list}
                loading={loading}
                isMobile={isMobile}
                rowKey={(r) => r.id}
                ariaLabel={t('compliance.mr_tab', 'Management reviews')}
                testId="reviews-table"
                empty={<EmptyState title={t('compliance.mr_empty_title', 'No management reviews yet')} description={t('compliance.mr_empty', 'No management reviews recorded yet. Clause 9.3 expects them at planned intervals — most organisations hold at least one per year.')} />}
                renderCard={(r) => (
                    <button
                        type="button"
                        onClick={() => { setCreating(false); setSelectedId(prev => (String(prev) === String(r.id) ? null : r.id)); }}
                        aria-selected={(!creating && String(selectedId) === String(r.id)) || undefined}
                        className="w-full text-left min-h-[44px] flex flex-col justify-center gap-1 min-w-0"
                        data-testid={`review-card-${r.id}`}
                    >
                        <span className="text-xs font-semibold text-[var(--text-primary)] tabular-nums">{fmtDate(r.held_at, resolvedLocale)}</span>
                        <span className="text-[11px] text-[var(--text-secondary)] truncate">{attendeeNames(r).join(', ') || '—'}</span>
                        <span className="text-[11px] text-[var(--text-tertiary)] truncate">{r.decisions || '—'}</span>
                    </button>
                )}
                renderRow={(r, ctx) => (
                    <TableRow key={r.id} columns={ctx.columns} selected={!creating && String(selectedId) === String(r.id)}
                        onClick={() => { setCreating(false); setSelectedId(prev => (String(prev) === String(r.id) ? null : r.id)); }} testId={`review-row-${r.id}`}>
                        <TableCell column={ctx.columns[0]} className="font-semibold text-[var(--text-primary)] tabular-nums">{fmtDate(r.held_at, resolvedLocale)}</TableCell>
                        <TableCell column={ctx.columns[1]} className="truncate text-[var(--text-secondary)]">{attendeeNames(r).join(', ') || '—'}</TableCell>
                        <TableCell column={ctx.columns[2]} className="truncate text-[var(--text-secondary)]">{r.decisions || '—'}</TableCell>
                    </TableRow>
                )}
            />
        </RegisterLayout>
    );
}

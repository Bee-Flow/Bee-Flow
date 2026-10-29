import { Plus, ArrowRight } from 'lucide-react';
import type React from 'react';
import {
    AUDIT_STATUS, FINDING_SEVERITY, labelOf, toneOf, userName, fmtDate,
    Field, TextInput, TextArea, DateInput, Select, UserSelect, ActionButton,
} from './auditForms';
import type { TranslateFn } from '@/hooks/useTranslation';
import FindingRow from '@/components/shared/FindingRow';
import { DrawerSection } from '@/components/shared/SideDrawer';
import RegisterStatePill from '../../shared/RegisterStatePill';
import StatusPill from '../../shared/StatusPill';
import type { OrgUser } from '../accessAuditLabels';
import type { RowLike } from '@/components/shared/DataTable';

// The rows and forms of AuditsTab (internal audits, clause 9.2): the shapes it
// works on, a finding list, the add-finding and plan-audit forms, and the narrow-layout card.

export interface Audit extends RowLike {
    id: number;
    title: string;
    status: string;
    scope_note?: string | null;
    auditor_user_id?: string | null;
    planned_at?: string | null;
    started_at?: string | null;
    closed_at?: string | null;
}

export interface AuditFindingRow extends RowLike {
    id: string | number;
    audit_id: number;
    severity: string;
    control_ref?: string | null;
    clause?: string | null;
    description: string;
    evidence_ref?: string | null;
    nonconformity_id?: string | number | null;
}

export interface FindingDraft {
    severity: string;
    control_ref: string;
    clause: string;
    description: string;
    evidence_ref: string;
}

export interface AuditDraft {
    title: string;
    scope_note: string;
    auditor_user_id: string;
    planned_at: string;
}

interface AuditFindingsListProps {
    t: TranslateFn;
    rows: AuditFindingRow[];
    busy: boolean | undefined;
    onRaiseNc: (f: AuditFindingRow) => void;
}

/** One audit's findings: severity, references, what was observed, and Raise as nonconformity where it weighs enough. */
export function AuditFindingsList({ t, rows, busy, onRaiseNc }: AuditFindingsListProps) {
    return (
        <>
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
                        <ActionButton size="sm" variant="error" icon={ArrowRight} disabled={busy} onClick={() => onRaiseNc(f)} className="self-start" data-testid={`audit-raise-nc-${f.id}`}>
                            {t('compliance.audit_raise_nc', 'Raise as nonconformity')}
                        </ActionButton>
                    ))}
                </div>
            ))}
        </>
    );
}

interface AddFindingSectionProps {
    t: TranslateFn;
    fd: Readonly<FindingDraft>;
    busy: boolean | undefined;
    onChange: (patch: Partial<FindingDraft>) => void;
    onSubmit: () => void;
}

/** The add-finding form of an audit that is not closed. */
export function AddFindingSection({ t, fd, busy, onChange, onSubmit }: AddFindingSectionProps) {
    return (
        <DrawerSection label={t('compliance.audit_add_finding', 'Add finding')}>
            <div className="grid grid-cols-2 gap-2">
                <Field label={t('compliance.audit_f_severity', 'Severity')}>
                    <Select value={fd.severity} onChange={v => onChange({ severity: v })} data-testid="audit-finding-severity"
                        options={Object.keys(FINDING_SEVERITY).map(k => ({ value: k, label: labelOf(t, FINDING_SEVERITY, k) }))} />
                </Field>
                <Field label={t('compliance.audit_f_control', 'Control ref')}>
                    <TextInput value={fd.control_ref} placeholder="A.5.15" onChange={v => onChange({ control_ref: v })} />
                </Field>
                <Field label={t('compliance.audit_f_clause', 'Clause')}>
                    <TextInput value={fd.clause} placeholder="9.2" onChange={v => onChange({ clause: v })} />
                </Field>
                <Field label={t('compliance.audit_f_evidence', 'Evidence ref (optional)')}>
                    <TextInput value={fd.evidence_ref} onChange={v => onChange({ evidence_ref: v })} />
                </Field>
            </div>
            <Field label={t('compliance.audit_f_finding', 'What was observed')}>
                <TextArea value={fd.description} placeholder={t('compliance.audit_f_finding_ph', 'What was examined, what the evidence showed, and where it falls short…')} onChange={v => onChange({ description: v })} data-testid="audit-finding-description" />
            </Field>
            <ActionButton icon={Plus} disabled={busy || !fd.description.trim()} onClick={onSubmit} className="self-start" data-testid="audit-finding-submit">
                {t('compliance.audit_add_finding', 'Add finding')}
            </ActionButton>
        </DrawerSection>
    );
}

interface AuditPlanFieldsProps {
    t: TranslateFn;
    draft: Readonly<AuditDraft>;
    setDraft: React.Dispatch<React.SetStateAction<Readonly<AuditDraft>>>;
    orgUsers: OrgUser[] | null;
    independenceWarning: string | null | undefined;
}

/** The plan-audit form: title, scope, auditor, date, and the independence warning when there is one. */
export function AuditPlanFields({ t, draft, setDraft, orgUsers, independenceWarning }: AuditPlanFieldsProps) {
    return (
        <>
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
        </>
    );
}

interface AuditCardProps {
    t: TranslateFn;
    a: Audit;
    findingCount: number;
    isSelected: boolean;
    orgUsers: OrgUser[] | null;
    locale: string;
    onToggle: () => void;
}

/** An audit as a card (the narrow layout): title, scope, state, auditor, date and the findings count. */
export function AuditCard({ t, a, findingCount, isSelected, orgUsers, locale, onToggle }: AuditCardProps) {
    return (
        <div className="w-full min-w-0 flex items-center gap-2" data-testid={`audit-card-${a.id}`} data-selected={isSelected || undefined}>
            <button
                type="button"
                onClick={onToggle}
                aria-selected={isSelected || undefined}
                className="flex-1 min-w-0 text-left min-h-[44px] flex flex-col justify-center gap-1"
            >
                <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{a.title}</span>
                {a.scope_note && <span className="text-[11px] text-[var(--text-tertiary)] truncate">{a.scope_note}</span>}
                <span className="flex items-center gap-2 min-w-0 text-[11px] text-[var(--text-secondary)]">
                    <RegisterStatePill state={a.status} testId={`audit-card-state-${a.id}`}>{labelOf(t, AUDIT_STATUS, a.status)}</RegisterStatePill>
                    <span className="truncate">{userName(orgUsers, a.auditor_user_id) || '—'}</span>
                    <span className="tabular-nums whitespace-nowrap">{fmtDate(a.planned_at, locale)}</span>
                    <span className="tabular-nums">{t('compliance.audit_findings', 'Findings')} {findingCount}</span>
                </span>
            </button>
        </div>
    );
}

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import { denseInputClass } from '../../../automation/Builder/flow/settings/formStyles';

/**
 * The one decision surface, shared by the Approvals section's detail view and
 * the builder's inline ApprovalActionBar, so the rules cannot fork:
 *
 *   • Reject REQUIRES a reason — "why did this never go out?" is asked weeks
 *     later by someone who was not in the room. (Server-enforced too.)
 *   • Extra questions (the snapshot's fields) are answered HERE, because they
 *     are part of the decision: "approve, and the PO number is 4471".
 *
 * Presentational: the caller supplies onDecide(decision, reason, answers) and
 * owns the API call, so the two mount points can post to their own routes.
 */
/** One option of a select question (a bare string is tolerated at runtime). */
interface ApprovalFieldOption {
    value?: string;
    label?: string;
}

/** One extra question of an approval (the snapshot's form-contract field). */
export interface ApprovalField {
    name: string;
    type?: string;
    label?: string;
    required?: boolean;
    help?: string;
    placeholder?: string;
    options?: ApprovalFieldOption[];
}

/** The approver's answers, by field name. */
type ApprovalAnswers = Record<string, string | boolean>;

interface ApprovalDecisionControlsProps {
    fields?: ApprovalField[] | null;
    onDecide: (decision: string, reason: string | undefined, answers: ApprovalAnswers | undefined) => Promise<void> | void;
    disabled?: boolean;
}

export default function ApprovalDecisionControls({ fields = null, onDecide, disabled = false }: ApprovalDecisionControlsProps) {
    const { t } = useTranslation();
    const [reason, setReason] = useState('');
    const [answers, setAnswers] = useState<ApprovalAnswers>({});
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    const [submitting, setSubmitting] = useState<string | null>(null); // 'approve' | 'reject' | null

    const inputFields = useMemo(
        () => (Array.isArray(fields) ? fields.filter(f => f && f.type !== 'download' && f.type !== 'notebook') : []),
        [fields],
    );
    const canReject = reason.trim().length > 0;

    const setAnswer = (name: string, value: string | boolean) => setAnswers(prev => ({ ...prev, [name]: value }));

    const decide = async (decision: string) => {
        if (disabled || submitting) return;
        if (decision === 'reject' && !canReject) return;
        // Required questions are checked HERE, before the network: a 400 with
        // per-field messages is the server's backstop, not the first feedback
        // an approver sees.
        if (decision === 'approve' && inputFields.length) {
            const missing: Record<string, string> = {};
            for (const f of inputFields) {
                if (!f.required) continue;
                const v = answers[f.name];
                const empty = f.type === 'checkbox' ? v !== true : (v === undefined || v === null || String(v).trim() === '');
                if (empty) missing[f.name] = t('approvals.field_required', '{field} is required.').replace('{field}', f.label || f.name);
            }
            setFieldErrors(missing);
            if (Object.keys(missing).length) return;
        }
        setSubmitting(decision);
        try {
            await onDecide(decision, reason.trim() || undefined, inputFields.length ? answers : undefined);
        } finally {
            setSubmitting(null);
        }
    };

    return (
        <div className="space-y-3">
            {inputFields.length > 0 && (
                <div className="space-y-3">
                    {inputFields.map(f => {
                        const onChange = (v: string | boolean) => {
                            setAnswer(f.name, v);
                            setFieldErrors(prev => { const n = { ...prev }; delete n[f.name]; return n; });
                        };
                        const label = (
                            <>
                                {f.label || f.name}
                                {f.required && <span className="text-red-500 ml-0.5">*</span>}
                            </>
                        );
                        const error = fieldErrors[f.name]
                            ? <span className="block text-[11px] text-red-600 dark:text-red-400 mt-0.5">{fieldErrors[f.name]}</span>
                            : null;
                        // A tickbox reads as a statement you agree with, so it
                        // sits BESIDE its sentence. Stacking it under the label
                        // — which is what every other field type wants — left a
                        // lone empty square floating below the question.
                        if (f.type === 'checkbox') {
                            return (
                                <div key={f.name}>
                                    <label className="flex items-start gap-2.5 cursor-pointer">
                                        <ApprovalFieldInput field={f} value={answers[f.name]} onChange={onChange} />
                                        <span className="text-[12.5px] text-[var(--text-primary)] leading-snug">{label}</span>
                                    </label>
                                    {f.help && <span className="block text-[11px] text-[var(--text-tertiary)] mt-0.5 ml-[26px]">{f.help}</span>}
                                    {error}
                                </div>
                            );
                        }
                        return (
                            <label key={f.name} className="block">
                                <span className="block text-[12px] font-medium text-[var(--text-primary)] mb-1">{label}</span>
                                {f.help && <span className="block text-[11px] text-[var(--text-tertiary)] mb-1">{f.help}</span>}
                                <ApprovalFieldInput field={f} value={answers[f.name]} onChange={onChange} />
                                {error}
                            </label>
                        );
                    })}
                </div>
            )}
            <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder={t('approvals.reason_placeholder', 'Why? Required when you reject.')}
                aria-label={t('approvals.reason_label', 'Reason for your decision')}
                className={denseInputClass('w-full')}
            />
            <div className="flex items-center gap-2 flex-wrap">
                <button
                    type="button"
                    onClick={() => decide('approve')}
                    disabled={disabled || !!submitting}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-[12.5px] font-medium rounded-full bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition"
                >
                    {submitting === 'approve' ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                    {t('approvals.approve', 'Approve')}
                </button>
                <button
                    type="button"
                    onClick={() => decide('reject')}
                    disabled={disabled || !!submitting || !canReject}
                    title={canReject ? undefined : t('approvals.reason_needed', 'Add a reason to reject.')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-[12.5px] font-medium rounded-full border border-red-500/40 text-red-700 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition"
                >
                    {submitting === 'reject' ? <Loader2 size={12} className="animate-spin" /> : <XCircle size={12} />}
                    {t('approvals.reject', 'Reject')}
                </button>
                {!canReject && (
                    <span className="text-[11px] text-[var(--text-tertiary)]">{t('approvals.reason_needed', 'Add a reason to reject.')}</span>
                )}
            </div>
        </div>
    );
}

/**
 * One input per form-contract field type. Deliberately plain controls — the
 * approver is answering a couple of questions, not filling in a form product.
 */
interface ApprovalFieldInputProps {
    field: ApprovalField;
    value: string | boolean | undefined;
    onChange: (value: string | boolean) => void;
}

function ApprovalFieldInput({ field, value, onChange }: ApprovalFieldInputProps) {
    const { t } = useTranslation();
    const cls = denseInputClass('w-full');
    switch (field.type) {
        case 'textarea':
            return <textarea rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder || ''} className={cls} />;
        case 'number':
            return <input type="number" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder || ''} className={cls} />;
        case 'date':
            return <input type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={cls} />;
        case 'email':
            return <input type="email" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder || ''} className={cls} />;
        case 'select':
            return (
                <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} className={cls}>
                    <option value="">{t('studio_misc.approvals.decision.choose', '— choose —')}</option>
                    {(field.options || []).map(o => (
                        <option key={o.value ?? String(o)} value={o.value ?? String(o)}>{o.label ?? o.value ?? String(o)}</option>
                    ))}
                </select>
            );
        case 'checkbox':
            return (
                <input
                    type="checkbox"
                    checked={!!value}
                    onChange={(e) => onChange(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600"
                />
            );
        default: // text and anything unrecognised degrades to a text input
            return <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder || ''} className={cls} />;
    }
}

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/shared/Toast';
import { costLimitToInput, parseCostLimitInput } from '../userManagement/costLimitInput';

interface BudgetEditorProps {
    /** The stored amount in euro; null/undefined = no limit. */
    value: number | null | undefined;
    label: string;
    /** Small text under the editor. */
    hint?: string;
    /** Text after the amount in the view state, e.g. "/mo". */
    suffix?: string;
    /** Show the label as visible text on the left (group settings); otherwise it is only the accessible name. */
    showLabel?: boolean;
    onSave: (value: number | null) => Promise<void>;
}

/** Click-to-edit AI budget: the amount or "No limit", a number input with Check/X when editing. */
export default function BudgetEditor({ value, label, hint, suffix = '', showLabel = false, onSave }: BudgetEditorProps) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState('');
    const [saving, setSaving] = useState(false);
    const noLimit = t('admin_org.cost_limit_placeholder', 'No limit');
    const amount = typeof value === 'number' && value > 0 ? value : null;

    const start = () => { setText(costLimitToInput(value)); setEditing(true); };
    const save = async () => {
        const parsed = parseCostLimitInput(text);
        if (parsed === undefined) {
            toast.error(t('admin_org.cost_limit_invalid', 'Enter a budget above zero, or leave the field empty.'));
            return;
        }
        setSaving(true);
        try {
            await onSave(parsed);
            setEditing(false);
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="flex items-start gap-2">
            {showLabel && <span className="text-xs text-[var(--text-secondary)] w-24 pt-1.5 shrink-0">{label}</span>}
            <div className="flex-1 min-w-0">
                {editing ? (
                    <div className="flex items-center gap-1.5">
                        <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={text}
                            onChange={ev => setText(ev.target.value)}
                            onKeyDown={ev => {
                                if (ev.key === 'Enter') void save();
                                if (ev.key === 'Escape') setEditing(false);
                            }}
                            aria-label={label}
                            placeholder={noLimit}
                            className="w-28 px-2.5 py-1.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-[var(--text-primary)] text-xs outline-none focus:border-blue-500"
                            autoFocus
                        />
                        <button type="button" onClick={() => void save()} disabled={saving} aria-label={t('admin_org.budget_save', 'Save budget')} className="p-1 text-green-500 hover:bg-green-500/10 rounded">
                            <Check className="w-3.5 h-3.5" />
                        </button>
                        <button type="button" onClick={() => setEditing(false)} aria-label={t('admin_org.budget_cancel', 'Cancel')} className="p-1 text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] rounded">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </div>
                ) : (
                    <button
                        type="button"
                        onClick={ev => { ev.stopPropagation(); start(); }}
                        title={label}
                        aria-label={`${label}: ${amount === null ? noLimit : `€${amount.toFixed(2)}${suffix}`}`}
                        className={`text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer text-left ${showLabel ? 'pt-1.5' : ''}`}
                    >
                        {amount === null ? <span className="italic opacity-60">{noLimit}</span> : `€${amount.toFixed(2)}${suffix}`}
                    </button>
                )}
                {hint && <p className="text-[10px] mt-1 text-[var(--text-muted)]">{hint}</p>}
            </div>
        </div>
    );
}

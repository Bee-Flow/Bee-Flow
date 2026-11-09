/** The pieces of the edit form that only read the draft: labelled field wrapper, repeat select, next-run date and time. */
import { Calendar, Clock, Repeat } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React from 'react';
import type { TranslateParams } from '../../hooks/useTranslation';
import { COWORK_REPEAT_OPTIONS } from './coworkSchedule';

export interface EditFormDraft {
    repeatInterval: string;
    date: string;
    time: string;
}

type T = (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string;

interface FieldProps {
    label: string;
    icon?: LucideIcon;
    children: React.ReactNode;
    hint?: string;
    as?: 'label' | 'div';
}

export /**
 * `as="div"` for fields whose control is not a single form element — wrapping
 * the Apps picker in a <label> would make a click anywhere in the row toggle
 * the first checkbox inside its overlay.
 */
function Field({ label, icon: Icon, children, hint, as: Tag = 'label' }: FieldProps) {
    return (
        <Tag className="block">
            <span
                className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide mb-1.5 text-[var(--text-tertiary)]"
            >
                {Icon && <Icon className="w-3.5 h-3.5" />}{label}
            </span>
            {children}
            {hint && (
                <span className="block text-[11px] mt-1 text-[var(--text-tertiary)]">{hint}</span>
            )}
        </Tag>
    );
}

export const inputClass = 'w-full px-3 py-2 rounded-lg border bg-[var(--bg-card)] text-[13px] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]';
export const inputStyle = { borderColor: 'var(--border-subtle)' };

export function CoworkEditFormField2({ t, draft, set }: { t: T; draft: EditFormDraft; set: (patch: Partial<EditFormDraft>) => void; }) {
    return <Field label={t('cowork.edit.repeat', 'Repeat')} icon={Repeat}>
        <select
            value={draft.repeatInterval}
            onChange={e => set({ repeatInterval: e.target.value })}
            aria-label={t('cowork.edit.repeat', 'Repeat')}
            data-testid="cowork-edit-repeat"
            className={inputClass}
            style={inputStyle}
        >
            {COWORK_REPEAT_OPTIONS.map(o => (
                <option key={o.value || 'once'} value={o.value}>{t(o.labelKey, o.label)}</option>
            ))}
        </select>
    </Field>;
}

export function CoworkEditFormSection({ t, draft, set }: { t: T; draft: EditFormDraft; set: (patch: Partial<EditFormDraft>) => void; }) {
    return <div className="grid grid-cols-2 gap-3">
        <Field label={t('cowork.edit.next_run', 'Next run')} icon={Calendar}>
            <input
                type="date"
                value={draft.date}
                onChange={e => set({ date: e.target.value })}
                aria-label={t('cowork.edit.next_run_date_aria', 'Next run date')}
                data-testid="cowork-edit-date"
                className={inputClass}
                style={inputStyle} />
        </Field>
        <Field label={t('cowork.edit.at', 'At')} icon={Clock}>
            <input
                type="time"
                value={draft.time}
                onChange={e => set({ time: e.target.value })}
                aria-label={t('cowork.edit.next_run_time_aria', 'Next run time')}
                data-testid="cowork-edit-time"
                className={inputClass}
                style={inputStyle} />
        </Field>
    </div>;
}


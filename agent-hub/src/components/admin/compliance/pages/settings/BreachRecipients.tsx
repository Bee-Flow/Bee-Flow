import React, { useId, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { INPUT_CLASS, LABEL_CLASS } from '../audits/auditForms';

/**
 * BreachRecipients: the editor of `breach_recipients`, the addresses alerted
 * on anomalous data-access events.
 *
 * The recipients are removable chips; ONE input adds the next one, typed or
 * picked from the organisation's members (a datalist of their e-mail
 * addresses, without the ones already on the list). Enter adds, and so does
 * the small Add button beside it, for a touch screen without an Enter key.
 *
 * The label is a real `<label for>` on the input, not a wrapper around the
 * whole block: a wrapping label would name the first remove button instead.
 */

export interface OrgMember {
    id: string | number;
    displayName?: string | null;
    email?: string | null;
}

export interface BreachRecipientsProps {
    label: string;
    hint?: string | null;
    value: unknown;
    onChange: (next: string[]) => void;
    orgUsers?: OrgMember[] | null;
    testId: string;
}

/** The members a datalist may still suggest: those with an address that is not on the list yet. */
export function memberSuggestions(orgUsers: OrgMember[] | null | undefined, list: string[]): OrgMember[] {
    const taken = new Set(list.map((x) => x.toLowerCase()));
    return (Array.isArray(orgUsers) ? orgUsers : [])
        .filter((u) => typeof u?.email === 'string' && u.email.trim() !== '' && !taken.has(u.email.trim().toLowerCase()));
}

const CHIP_REMOVE = 'h-4 w-4 inline-flex items-center justify-center rounded-full text-[var(--text-tertiary)] hover:text-[var(--error-ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';
const ADD_BUTTON = 'h-7 px-2.5 shrink-0 inline-flex items-center gap-1 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-primary)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]';

export default function BreachRecipients({ label, hint = null, value, onChange, orgUsers = null, testId }: BreachRecipientsProps) {
    const { t } = useTranslation();
    const list = Array.isArray(value) ? value.map((x) => String(x)) : [];
    const [draft, setDraft] = useState('');
    const inputId = useId();
    const hintId = useId();
    const listId = useId();
    const suggestions = memberSuggestions(orgUsers, list);

    const add = () => {
        const s = draft.trim();
        if (!s) return;
        if (!list.some((x) => x.toLowerCase() === s.toLowerCase())) onChange([...list, s]);
        setDraft('');
    };

    return (
        <div className="flex flex-col gap-1 min-w-0" data-testid={`${testId}-field`}>
            <label htmlFor={inputId} className={LABEL_CLASS}>{label}</label>
            <div className="flex flex-col gap-1.5" data-testid={testId}>
                {list.length > 0 && (
                    <ul className="m-0 p-0 list-none flex flex-wrap gap-1.5" aria-label={label}>
                        {list.map((r, i) => (
                            <li
                                key={`${r}-${i}`}
                                className="inline-flex items-center gap-1 max-w-full rounded-full border border-[var(--border-default)] bg-[var(--bg-tertiary)] pl-2.5 pr-1 py-0.5 text-xs text-[var(--text-primary)]"
                            >
                                <span className="min-w-0 truncate" data-testid={`${testId}-item`}>{r}</span>
                                <button
                                    type="button"
                                    onClick={() => onChange(list.filter((_, idx) => idx !== i))}
                                    aria-label={t('compliance.set_recipient_remove', 'Remove {email}', { email: r })}
                                    title={t('compliance.set_recipient_remove', 'Remove {email}', { email: r })}
                                    className={CHIP_REMOVE}
                                    data-testid={`${testId}-remove-${i}`}
                                >
                                    <X size={11} aria-hidden="true" />
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex items-center gap-1.5">
                    <input
                        id={inputId}
                        type="text"
                        inputMode="email"
                        autoComplete="off"
                        list={listId}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
                        placeholder={t('compliance.set_recipient_add_ph', 'Add an e-mail or pick a member')}
                        aria-describedby={hint ? hintId : undefined}
                        className={INPUT_CLASS}
                        data-testid={`${testId}-input`}
                    />
                    <button type="button" onClick={add} disabled={!draft.trim()} className={ADD_BUTTON} data-testid={`${testId}-add`}>
                        <Plus size={12} aria-hidden="true" />
                        {t('compliance.add', 'Add')}
                    </button>
                    <datalist id={listId} data-testid={`${testId}-suggestions`}>
                        {suggestions.map((u) => (
                            <option key={String(u.id)} value={String(u.email).trim()}>{u.displayName || String(u.email)}</option>
                        ))}
                    </datalist>
                </div>
            </div>
            {hint ? <span id={hintId} className="text-[11px] leading-snug text-[var(--text-tertiary)]">{hint}</span> : null}
        </div>
    );
}

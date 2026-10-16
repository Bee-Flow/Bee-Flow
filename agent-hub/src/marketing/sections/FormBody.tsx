import React from 'react';
import FormFieldRow from './FormFieldRow';
import { HONEYPOT_FIELD } from './formBlockModel';
import type { FormField } from './formBlockModel';
import type { useFormSubmission } from './useFormSubmission';

interface Props {
    uid: string;
    title?: string;
    submitLabel?: string;
    fields: FormField[];
    consentText: string;
    preview: boolean;
    form: ReturnType<typeof useFormSubmission>;
}

/** The form itself: fields, consent, the honeypot and the submit button. */
export default function FormBody({ uid, title, submitLabel, fields, consentText, preview, form }: Props) {
    return (
        <form className="cms-form-card" onSubmit={form.submit} noValidate aria-label={title || 'Form'}>
            {fields.map(f => (
                <FormFieldRow key={f.id} field={f} inputId={`${uid}-${f.id}`}
                    value={form.answers[f.id]} error={form.errors[f.id]}
                    onChange={v => form.setAnswer(f.id, v)} />
            ))}
            {consentText ? (
                <div className="cms-form-row cms-form-row--check">
                    <input id={`${uid}-consent`} name="consent" type="checkbox" checked={form.consent}
                        aria-required aria-invalid={form.errors.consent ? true : undefined}
                        onChange={e => form.setConsent(e.target.checked)} />
                    <label htmlFor={`${uid}-consent`}>{consentText} *</label>
                    {form.errors.consent ? <p className="cms-form-error" role="alert">{form.errors.consent}</p> : null}
                </div>
            ) : null}
            {/* Honeypot: off-screen, out of the tab order and hidden from
                assistive tech. A person never fills it; a script does. */}
            <div className="cms-form-hp" aria-hidden="true">
                <label htmlFor={`${uid}-hp`}>Leave this empty</label>
                <input id={`${uid}-hp`} name={HONEYPOT_FIELD} type="text" tabIndex={-1} autoComplete="off"
                    value={form.honeypot} onChange={e => form.setHoneypot(e.target.value)} />
            </div>
            {form.formError ? <p className="cms-form-error" role="alert">{form.formError}</p> : null}
            <button type="submit" className="cms-form-submit" disabled={preview || form.phase === 'sending'}>
                {submitLabel || 'Send'}
            </button>
        </form>
    );
}

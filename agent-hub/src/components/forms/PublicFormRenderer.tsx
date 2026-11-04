import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { messageOf } from '../../utils/caughtError';
import FormField from './fields/FormField';
import { FormRichText } from './fields/FormRichText';
import { valuesWithPrefill } from './prefill';
import { collectErrors, fieldError, groupBlocks, initialValues, submissionValues, visibleNames } from './formRules';
import { FormCustomCss, FormFooter, FormHeader } from './FormChrome';
import { CARD_CLASS, FormStyleContext, useFormLook } from './formLook';
import { FormEndingView } from './FormEndingView';
import type { FormErrorHandler, FormFieldDef, FormValue, FormValues, PublicFormRendererProps, SubmitError } from './PublicFormRenderer.types';

// The importers reach these through this module.
export { FormRichText, initialValues, FormEndingView };
export { FormWaitingView } from './FormWaitingView';

/** The server's per-question messages from a refused submit, by name, or null when it sent none. */
function fieldErrorsOf(err: unknown): Record<string, string> | null {
    const perField = typeof err === 'object' && err !== null && 'fields' in err ? (err as SubmitError).fields : undefined;
    if (!Array.isArray(perField) || !perField.length) return null;
    return Object.fromEntries(perField.map(f => [f.field, f.message]));
}

/**
 * Renders one form-trigger form. Used by the PUBLIC hosted page and by the
 * builder's live preview, so what the author sees while editing is literally
 * the same component the visitor gets.
 *
 * Deliberately NOT App Studio's AppForm: that hangs off useRuntime() (mode,
 * runAction, scope), a node tree and componentRegistry — none of which exist
 * for an anonymous visitor, and componentRegistry pulls in authenticated
 * components. What IS reused directly is themeVars.js and uiBits.jsx (both
 * import nothing but React), so the look stays identical without the coupling.
 *
 * Props:
 *   form      — the server's renderConfig(): { title, description, submitLabel,
 *               successMessage, theme, fields }
 *   onSubmit(values) → Promise; resolves = success, rejects = show the message.
 *               Omitted in preview mode, which makes the form inert.
 *   onUpload(file, field) → Promise<{ fileId, filename, size }>
 *   onSearchApp(field, query) → Promise<{ results, error }> — an `app_pick`
 *               question's search box. The page supplies it because only the
 *               page knows the token, the CSRF and (on a later page) the
 *               session; this component only knows there is a question to
 *               answer. Omitted in preview mode, which leaves the picker
 *               visible but inert — an author looking at their own form should
 *               see the search box, not an empty space where it will be.
 *   preview   — no submission, no network; the author is just looking
 *   showSuccess — whether a resolved submit swaps the form for its
 *               successMessage. TRUE for a single-page form, where this
 *               component owns the ending. FALSE for a multi-page one, where
 *               the automation may still pause for another page and only the page
 *               that is polling knows what comes next.
 */
export default function PublicFormRenderer({ form, onSubmit = null, onUpload = null, onSearchApp = null, preview = false, showSuccess = true, downloadHref = null, onOpenInNotebooks = null, prefill = null }: PublicFormRendererProps) {
    const { t } = useTranslation();
    const fields = useMemo(() => form?.fields || [], [form?.fields]);
    const theme = useMemo(() => form?.theme || {}, [form?.theme]);
    const [values, setValues] = useState<FormValues>(() => valuesWithPrefill(fields, prefill));
    const [errors, setErrors] = useState<Record<string, string | null>>({});
    // A new set of saved answers (picking a scenario) fills the form again.
    const [appliedPrefill, setAppliedPrefill] = useState(prefill);
    if (prefill !== appliedPrefill) {
        setAppliedPrefill(prefill);
        setValues(valuesWithPrefill(fields, prefill));
        setErrors({});
    }
    const [formError, setFormError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    // The honeypot. Never labelled, never in the tab order, never on screen —
    // only a bot that fills every input it finds will touch it.
    const [honeypot, setHoneypot] = useState('');

    // The theme and the style as one variable map, the bf-form classes, and the
    // author's custom CSS scoped to this root (formLook.ts).
    const look = useFormLook(theme, form?.style);
    // Which questions are on screen. A hidden one is not drawn, not checked and
    // not sent; the server decides the same way and re-checks everything.
    const visible = useMemo(() => visibleNames(fields, values), [fields, values]);
    const blocks = useMemo(() => groupBlocks(fields, visible), [fields, visible]);

    // A question that disappears takes its error with it, so it cannot come
    // back from hiding still red.
    useEffect(() => {
        setErrors(prev => {
            const stale = Object.keys(prev).filter(name => prev[name] && !visible.has(name));
            if (!stale.length) return prev;
            const next = { ...prev };
            for (const name of stale) next[name] = null;
            return next;
        });
    }, [visible]);

    const set = (name: string, v: FormValue) => {
        setValues(prev => ({ ...prev, [name]: v }));
        setErrors(prev => (prev[name] ? { ...prev, [name]: null } : prev));
    };

    // On blur only the RULES speak: a visitor tabbing past a required question
    // has not refused to answer it yet. Required is checked on submit.
    const checkRules = (f: FormFieldDef) => {
        const message = fieldError(f, values[f.name], t, { checkRequired: false });
        setErrors(prev => (prev[f.name] === message || (!prev[f.name] && !message) ? prev : { ...prev, [f.name]: message }));
    };

    const submit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (preview || !onSubmit || busy) return;
        // Client-side checks are a courtesy, not a gate — the server re-checks
        // every field against the declaration.
        const found = collectErrors(fields, values, visible, t);
        if (Object.keys(found).length) { setErrors(found); return; }

        setBusy(true);
        setFormError(null);
        try {
            await onSubmit({ ...submissionValues(fields, values, visible), website_url: honeypot });
            if (showSuccess) setDone(true);
        } catch (err) {
            const perField = fieldErrorsOf(err);
            if (perField) setErrors(perField);
            else setFormError(messageOf(err, 'Something went wrong. Please try again.'));
        } finally {
            setBusy(false);
        }
    };

    if (done) return <FormEndingView form={{ ...form, title: form.successMessage, description: '' }} />;

    const renderField = (field: FormFieldDef) => (
        <FormField
            key={field.name}
            field={field}
            value={values[field.name]}
            error={errors[field.name] || null}
            disabled={preview || busy}
            onChange={(v: FormValue) => set(field.name, v)}
            onBlur={() => checkRules(field)}
            onUpload={onUpload}
            onSearchApp={onSearchApp}
            onError={((msg: string) => setErrors(prev => ({ ...prev, [field.name]: msg }))) as FormErrorHandler}
            downloadHref={downloadHref ? downloadHref(field) : null}
            onOpenInNotebooks={onOpenInNotebooks}
        />
    );

    return (
        <FormStyleContext.Provider value={look.style}>
        <form
            style={look.rootStyle}
            data-bf-scope={look.scopeId}
            onSubmit={submit}
            noValidate
            className={`${look.rootClass} flex flex-col`}
        >
            <FormCustomCss css={look.css} />
            <div className={`bf-form__card px-6 py-6 flex flex-col gap-5 ${CARD_CLASS}`}>
                <FormHeader title={form.title} description={form.description} logoUrl={look.style.logoUrl} />

                {blocks.map(block => (block.kind === 'group' ? (
                    // One question per list item: the header names the list, the
                    // items sit under it as ordinary questions.
                    <div
                        key={`group_${block.group}`}
                        role="group"
                        aria-labelledby={block.header?.label ? `ff_${block.header.name}` : undefined}
                        className="flex flex-col gap-4 pl-4 border-l-2 border-[var(--border-default)]"
                        data-testid={`form-group-${block.group}`}
                    >
                        {block.header ? renderField(block.header) : null}
                        {block.items.map(renderField)}
                    </div>
                ) : renderField(block.field)))}

                {/* Honeypot — hidden from people AND from assistive tech, so
                    only an indiscriminate bot fills it in. */}
                <div aria-hidden="true" className="[position:absolute] [left:-9999px] w-[1px] h-[1px] [overflow:hidden]">
                    <label htmlFor="website_url">{t('forms.honeypot_label', 'Leave this field empty')}</label>
                    <input id="website_url" name="website_url" type="text" tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setHoneypot(e.target.value)} />
                </div>

                {formError ? (
                    <p className="bf-form__error text-sm [color:#ef4444]!" role="alert">{formError}</p>
                ) : null}

                {/* The call to action paints with the theme's accent (the primary
                    family when none was chosen); width, shape and text colour
                    are the style's. */}
                <div className="bf-form__actions flex flex-col">
                    <button
                        type="submit"
                        disabled={preview || busy}
                        className="bf-form__submit inline-flex items-center justify-center gap-2 px-4 py-2 text-sm font-medium disabled:opacity-60 [background:var(--app-accent,var(--app-primary))] [color:var(--bf-button-text,var(--app-accent-contrast,var(--app-primary-contrast)))]! [border-radius:var(--bf-button-radius,var(--app-radius))] [align-self:var(--bf-button-align,stretch)]"
                    >
                        {busy ? <Loader2 size={15} className="animate-spin" /> : null}
                        {form.submitLabel}
                    </button>
                </div>
                <FormFooter text={look.style.footerText} />
            </div>
        </form>
        </FormStyleContext.Provider>
    );
}


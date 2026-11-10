import { Loader2, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FocusEvent, FormEvent } from 'react';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { NodeStyle } from '../../inspector/appDefinition';
import { FormContext, registerFormFieldSetter, registerFormReset } from '../formContext';
import type { FormFieldMeta } from '../formContext';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { gridTemplate, spaceSteps } from '../styleResolver';
import type { NodeProps } from './appNode.types';
import { collectValidations, fieldError } from './formRules';

/**
 * App Studio runtime — 'form' (container). Spec: server/appStudio/componentSpecs.js.
 *
 * Owns all field state (inputs register via formContext), runs client-side
 * validation with inline field errors — props.required PLUS every rule the
 * author wrote into the field's `node.validations` — and renders exactly one
 * built-in submit button (+ optional reset). Submitting calls
 * runAction(onSubmit, { formValues, formId, formName }); values are NEVER cleared
 * on failure — the user's input survives a failed automation run.
 *
 * The full values object is published upward via
 * runtime.registerFormValue(formName, values) on mount and on EVERY change
 * (typing, defaults registering, reset) — the run surface stores it under
 * forms[formName] so formulas can read `form.*` (inside the form container)
 * and `forms.<name>.*` (anywhere). formName is props.name (canonicalize fills
 * it) with node.id as the fallback — keep in lockstep with AppRenderer's
 * form-container child scope.
 */

// The field rules (node.validations, the rules props imply): ./formRules.ts.

interface FormProps {
    name?: string;
    resetKey?: unknown;
    submitLabel?: string;
    showReset?: boolean;
    showSubmit?: boolean;
    validateOn?: 'submit' | 'blur' | 'change';
}

/**
 * The shell. `resetKey` (spec: form.resetKey) is a formula whose value keys the
 * form's whole state subtree: when it changes, React remounts the body and
 * every input under it, so fields return to their defaults and each valueFrom
 * is read afresh — including the ones that resolve to nothing, which a push
 * could never clear. A form without a resetKey keys on nothing and behaves
 * exactly as it always has.
 */
export default function AppForm({ node, children }: NodeProps<FormProps>) {
    const { actionState, dataState, scope } = useRuntime();
    const resetKey = node.props?.resetKey;
    let token = 'form';
    if (typeof resetKey === 'string' && resetKey.trim()) {
        const { value } = resolveBinding({ kind: 'formula', expr: resetKey }, { actionState, dataState, scope });
        token = `form:${value == null ? '' : String(value)}`;
    }
    return <FormBody key={token} node={node}>{children}</FormBody>;
}

type FieldErrors = Record<string, string | undefined>;
type SetFieldErrors = (update: (prev: FieldErrors) => FieldErrors) => void;

/**
 * A field rule the server checks (data model validation) answers per field:
 * each sentence goes under its input, like a rule checked here, and clears
 * when that field changes. Adjusted during render when a new answer arrives.
 */
function useServerFieldErrors(serverFieldErrors: FieldErrors | null, setErrors: SetFieldErrors) {
    const [seenServerErrors, setSeenServerErrors] = useState(serverFieldErrors);
    if (serverFieldErrors !== seenServerErrors) {
        setSeenServerErrors(serverFieldErrors);
        if (serverFieldErrors) setErrors((prev) => ({ ...prev, ...serverFieldErrors }));
    }
}

type LiveInputs = { values: Record<string, unknown>; scope: Record<string, unknown>; validations: ReturnType<typeof collectValidations>; t: TranslateFn };

/**
 * Live validation (validateOn): the latest values/scope sit in a ref, read from
 * callbacks that must stay stable, and one field is checked at a time.
 */
function useLiveValidation(inputs: LiveInputs, fieldsRef: { current: Map<string, FormFieldMeta> }, setErrors: SetFieldErrors) {
    const liveRef = useRef(inputs);
    useEffect(() => { liveRef.current = inputs; });
    const validateLive = useCallback((name: string, value: unknown) => {
        const live = liveRef.current;
        const fieldScope = { ...live.scope, form: { ...live.values, [name]: value }, value };
        const message = fieldError(fieldsRef.current.get(name), live.validations.get(name), value, fieldScope, live.t);
        setErrors((prev) => (prev[name] === message ? prev : { ...prev, [name]: message }));
    }, [fieldsRef, setErrors]);
    return { liveRef, validateLive };
}

function FormBody({ node, children }: NodeProps<FormProps>) {
    const { t } = useTranslation();
    const { mode, runAction, actionState, registerFormValue, scope } = useRuntime();
    const { submitLabel = t('studio_apps_runtime.form.submit', 'Submit'), showReset = false, showSubmit = true } = node.props || {};
    const formName = node.props?.name || node.id;
    const [values, setValues] = useState<Record<string, unknown>>({});
    const [errors, setErrors] = useState<Record<string, string | undefined>>({});
    const fieldsRef = useRef(new Map<string, FormFieldMeta>()); // name → { required, label, defaultValue }

    const pending = !!(node.onSubmit && actionState?.[node.onSubmit]?.status === 'running');
    // The spinner was the only thing read off the action's state, so a
    // failed submit just stopped spinning and said nothing.
    const submitError = node.onSubmit ? actionState?.[node.onSubmit]?.error : null;
    useServerFieldErrors(node.onSubmit ? actionState?.[node.onSubmit]?.fieldErrors ?? null : null, setErrors);
    const validations = useMemo(() => collectValidations(node), [node]);

    useEffect(() => {
        if (typeof registerFormValue === 'function') registerFormValue(formName, values);
    }, [registerFormValue, formName, values]);

    const register = useCallback((name: string, meta: FormFieldMeta) => {
        fieldsRef.current.set(name, meta);
        // Seed the default so untouched fields still submit their value.
        setValues((prev) => (Object.prototype.hasOwnProperty.call(prev, name)
            ? prev
            : { ...prev, [name]: meta.defaultValue ?? null }));
    }, []);

    const unregister = useCallback((name: string) => {
        fieldsRef.current.delete(name);
    }, []);

    const validateOn = node.props?.validateOn;
    const { liveRef, validateLive } = useLiveValidation({ values, scope, validations, t }, fieldsRef, setErrors);

    const setValue = useCallback((name: string, value: unknown) => {
        setValues((prev) => ({ ...prev, [name]: value }));
        if (validateOn === 'change') {
            validateLive(name, value);
            return;
        }
        setErrors((prev) => (prev[name] ? { ...prev, [name]: undefined } : prev));
    }, [validateOn, validateLive]);

    // React's onBlur bubbles (focusout): the field is found by the input's name.
    const handleBlur = validateOn === 'blur' ? (e: FocusEvent<HTMLFormElement>) => {
        const name = (e.target as Element).getAttribute('name');
        if (name && fieldsRef.current.has(name)) validateLive(name, liveRef.current.values[name]);
    } : undefined;

    const handleReset = useCallback(() => {
        const next: Record<string, unknown> = {};
        for (const [name, meta] of fieldsRef.current) next[name] = meta.defaultValue ?? null;
        setValues(next);
        setErrors({});
    }, []);

    // The `reset_form` action step reaches this form by NAME through the
    // module-level bus — the same key the runtime files form values under.
    useEffect(() => registerFormReset(formName, handleReset), [formName, handleReset]);
    // …and the `set_form_field` step reaches one field the same way, through setValue
    // (only a field this form has: a step never adds a value the form would not submit).
    useEffect(() => registerFormFieldSetter(formName, (field, value) => {
        if (fieldsRef.current.has(field)) setValue(field, value);
    }), [formName, setValue]);

    const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        if (mode !== 'run' || pending) return;
        const nextErrors: Record<string, string> = {};
        for (const [name, meta] of fieldsRef.current) {
            const v = values[name];
            // `form` is this form's LIVE values (the published forms.<name> copy
            // lags by an effect) and `value` is the field under test.
            const message = fieldError(meta, validations.get(name), v, { ...scope, form: values, value: v }, t);
            if (message) nextErrors[name] = message;
        }
        setErrors(nextErrors);
        if (Object.keys(nextErrors).some((k) => nextErrors[k])) return;
        if (node.onSubmit) {
            // `formId` stays the NODE id (existing consumers read that),
            // `formName` is the key under which this form registers on the
            // reset bus and at registerFormValue — `props.name || node.id`.
            // Those two are rarely equal (canonicalize always fills `props.name`),
            // and `refresh:'resetForm'` had the node id, so the reset never found
            // a form and said nothing about it either.
            runAction(node.onSubmit, { formValues: { ...values }, formId: node.id, formName });
        }
    };

    const ctx = useMemo(
        () => ({ values, setValue, errors, register, unregister, pending }),
        [values, setValue, errors, register, unregister, pending],
    );

    const gap = Number.isFinite(node.style?.gap) ? (node.style as NodeStyle).gap : 3;
    return (
        <FormContext.Provider value={ctx}>
            <form onSubmit={handleSubmit} onBlur={handleBlur} noValidate className="flex flex-col" style={{ gap: spaceSteps(gap) }}>
                <div
                    className="app-grid"
                    style={{ gridTemplateColumns: gridTemplate(), gap: spaceSteps(gap) }}
                >
                    {children}
                </div>
                {/* A form whose fields save on change (a triage bar) has nothing
                    to submit. Rendering the button anyway is the loudest signal
                    a screen was generated rather than designed — and the user
                    clicks it, and nothing happens. */}
                {submitError ? (
                    <p
                        className="text-sm [color:var(--error)]!"
                        role="alert"
                        data-app-submit-error="true"
                    >
                        {submitError}
                    </p>
                ) : null}

                {showSubmit || showReset ? (
                    <div className="flex items-center gap-2">
                        {showSubmit ? (
                            <button
                                type="submit"
                                // `showSubmit` defaults to true while onSubmit is
                                // optional, so an unwired form shipped a fully
                                // enabled button that did nothing at all when
                                // clicked. Saying so beats swallowing the click.
                                disabled={pending || !node.onSubmit}
                                title={node.onSubmit ? undefined : t('studio_apps_runtime.form.no_submit', 'This form has no submit action yet.')}
                                data-app-submit-inert={node.onSubmit ? undefined : 'true'}
                                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-sm font-medium disabled:opacity-60 [background:var(--app-accent,var(--app-primary))] [color:var(--app-accent-contrast,var(--app-primary-contrast))]! [border-radius:var(--app-radius)]"
                            >
                                {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : null}
                                <span>{submitLabel}</span>
                            </button>
                        ) : null}
                        {showReset ? (
                            <button
                                type="button"
                                onClick={handleReset}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm [color:var(--text-secondary)]! [border-radius:var(--app-radius)]"
                            >
                                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                                <span>{t('studio_apps_runtime.form.reset', 'Reset')}</span>
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </form>
        </FormContext.Provider>
    );
}

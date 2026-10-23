import { createContext, useCallback, useContext, useEffect, useState } from 'react';

/** What an input registers: AppForm keeps it per field name for validation. */
export interface FormFieldMeta {
    required: boolean;
    label: string;
    defaultValue: unknown;
    disabled: boolean;
    invalid: boolean;
    invalidMessage: string | null;
}

/** The value AppForm provides. Field values are whatever an input or an action step put there. */
export interface FormContextValue {
    values: Record<string, unknown>;
    setValue: (name: string, value: unknown) => void;
    errors: Record<string, string | undefined>;
    register: (name: string, meta: FormFieldMeta) => void;
    unregister: (name: string) => void;
    pending: boolean;
}

/**
 * App Studio runtime — the form ↔ input contract.
 *
 * AppForm owns all field state and publishes this context; inputs never keep
 * their own submit-relevant state. The context value AppForm provides:
 *
 *   values     — { [name]: value } (defaults seeded on register)
 *   setValue   — (name, value); also clears that field's error
 *   errors     — { [name]: message } from the last failed submit
 *   register   — (name, { required, label, defaultValue, disabled }) on input
 *                mount; seeds the default into values when the name is new
 *   unregister — (name) on unmount (value is kept; only validation forgets it)
 *   pending    — true while the form's onSubmit action is running
 *
 * Inputs go through useFormField() below, which degrades to plain local state
 * when rendered outside a form — the validator rejects that at publish time,
 * but the runtime must never crash over it.
 */

/**
 * What an input registers: AppForm keeps it per field name for validation.
 *
 * @typedef {object} FormFieldMeta
 * @property {boolean} required
 * @property {string} label
 * @property {unknown} defaultValue
 * @property {boolean} disabled
 * @property {boolean} invalid
 * @property {string | null} invalidMessage
 */

/**
 * The value AppForm provides. Field values are whatever an input or an action
 * step put there, so they stay `unknown`.
 *
 * @typedef {object} FormContextValue
 * @property {Record<string, unknown>} values
 * @property {(name: string, value: unknown) => void} setValue
 * @property {Record<string, string | undefined>} errors
 * @property {(name: string, meta: FormFieldMeta) => void} register
 * @property {(name: string) => void} unregister
 * @property {boolean} pending
 */

/** @type {import('react').Context<FormContextValue | null>} */
export const FormContext = createContext<FormContextValue | null>(null);

// ── reset_form bus ──────────────────────────────────────────────────────────
// Module-level registry formName → Set<resetFn>, mirroring AppModal's opener
// bus: the `reset_form` action step must reach a mounted form from OUTSIDE the
// React tree (the action runner). Exists because valueFrom deliberately cannot
// clear a field — pushing '' twice is a no-op by design — so on a single-screen
// app "switch context" had no way to empty a half-typed composer.
const resetters = new Map<string, Set<() => void>>();

/**
 * AppForm calls this on mount; returns the unregister cleanup.
 *
 * @param {string | null | undefined} name
 * @param {() => void} fn
 * @returns {() => void}
 */
export function registerFormReset(name: string, fn: () => void) {
    if (!name || typeof fn !== 'function') return () => {};
    let set = resetters.get(name);
    if (!set) { set = new Set(); resetters.set(name, set); }
    set.add(fn);
    return () => {
        set.delete(fn);
        if (set.size === 0) resetters.delete(name);
    };
}

/**
 * Clear every mounted form registered under this name back to its defaults.
 *
 * @param {string} name
 */
export function resetAppForm(name: string) {
    (resetters.get(name) || []).forEach((fn) => fn());
}

/**
 * "The node around me is switched off."
 *
 * AppRenderer wraps a node whose `enabledWhen` is false in an inert, unfocusable
 * DisabledWrap — but the input inside still mounted and still registered itself
 * as required, so a required field the user could not reach blocked submit with
 * an error they could not clear. The wrapper publishes the state here and the
 * field carries it into its registration, where AppForm skips its rules.
 *
 * @type {import('react').Context<boolean>}
 */
export const FieldDisabledContext = createContext<boolean>(false);

/** @returns {FormContextValue | null} */
export function useFormContext() {
    return useContext(FormContext);
}

/**
 * useFormField({ name, defaultValue, required, label })
 *   → { value, setValue, error, pending }
 *
 * @param {{ name?: string | null, defaultValue?: unknown, required?: boolean, label?: string, invalid?: boolean, invalidMessage?: string | null }} field
 * @returns {{ value: unknown, setValue: (value: unknown) => void, error: string | null, pending: boolean }}
 */
interface UseFormFieldArgs {
    name?: string | null;
    defaultValue?: unknown;
    required?: boolean;
    label?: string;
    invalid?: boolean;
    invalidMessage?: string | null;
}

export function useFormField<V = unknown>({
    name, defaultValue = null, required = false, label = '',
    // "The browser refused what was typed." A number box holding "12e" reports
    // an empty value while still showing the text, so the input knew the field
    // was wrong and the FORM did not — an optional one submitted empty under a
    // visible error. Carried into the registration so AppForm can block it.
    invalid = false, invalidMessage = null,
}: UseFormFieldArgs): { value: V | null; setValue: (value: unknown) => void; error: string | null; pending: boolean; } {
    const form = useContext(FormContext);
    const disabled = useContext(FieldDisabledContext);
    const [local, setLocal] = useState<unknown>(defaultValue);

    useEffect(() => {
        if (!form || !name) return undefined;
        form.register(name, {
            required: !!required, label, defaultValue, disabled: !!disabled,
            invalid: !!invalid, invalidMessage,
        });
        return () => form.unregister(name);
        // register/unregister are stable (useCallback in AppForm).
        // eslint-disable-next-line react-hooks/exhaustive-deps -- defaultValue is schema data that changes only with the node, and inputs pass fresh [] literals
    }, [form, name, required, label, disabled, invalid, invalidMessage]);

    // Stable, like a useState setter: inputs hand it to effects (useValueFrom).
    const formSetValue = (form ? form.setValue : null) as FormContextValue['setValue'];
    const setValue = useCallback((v: unknown) => formSetValue(name as string, v), [formSetValue, name]);

    if (!form || !name) {
        return { value: local as V | null, setValue: setLocal, error: null, pending: false };
    }
    const value = (Object.prototype.hasOwnProperty.call(form.values, name)
        ? form.values[name]
        : defaultValue) as V | null;
    return {
        value,
        setValue,
        error: form.errors[name] || null,
        pending: !!form.pending,
    };
}

export default FormContext;

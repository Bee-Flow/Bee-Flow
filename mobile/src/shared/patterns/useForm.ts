/**
 * Form state for a sheet or screen: values, dirty tracking, validation and a
 * submit with a busy flag and the error it threw.
 *
 * Every sheet form in the app hand-rolled a useState per field, a
 * `disabled={!title.trim()}` and a mutation's isPending. This keeps the same
 * shape in one hook. It is deliberately small: flat values, synchronous
 * validators, and errors shown for a field only once it was edited or a
 * submit was attempted — a form that opens covered in red is scolding.
 */

import { useRef, useState } from 'react';

import type { Validator } from './validators';

export type FormValues = Record<string, unknown>;

export type FormErrors<T extends FormValues> = Partial<Record<keyof T, string>>;

export interface UseFormOptions<T extends FormValues> {
    initial: T;
    /** Per-field validators, run in order; the first message wins. */
    validate?: { [K in keyof T]?: readonly Validator<T[K], T>[] };
    /** The work. A throw is kept as `submitError` rather than rethrown. */
    onSubmit: (values: T) => Promise<unknown> | unknown;
}

/** Props that wire one field into a TextField (or any value/onChange pair). */
export interface FieldBinding<V> {
    value: V;
    onChangeText: (next: V) => void;
    /** Present once the field was edited or a submit was attempted. */
    error: string | undefined;
}

export interface FormState<T extends FormValues> {
    values: T;
    set: <K extends keyof T>(key: K, value: T[K]) => void;
    field: <K extends keyof T>(key: K) => FieldBinding<T[K]>;
    /** Every current message, shown or not. */
    errors: FormErrors<T>;
    valid: boolean;
    /** True when any value differs from the initial one. */
    dirty: boolean;
    submitting: boolean;
    submitError: unknown;
    /** Valid, not already submitting. Use for the submit button's `disabled`. */
    canSubmit: boolean;
    /** Validates, then runs onSubmit. Resolves true when it succeeded. */
    submit: () => Promise<boolean>;
    /** Back to `next` (or the original initial values), clean and untouched. */
    reset: (next?: T) => void;
}

/** The first message each field's validators produce. */
export function validateValues<T extends FormValues>(
    values: T,
    validate: UseFormOptions<T>['validate'],
): FormErrors<T> {
    const errors: FormErrors<T> = {};
    if (!validate) return errors;
    for (const key of Object.keys(validate) as (keyof T)[]) {
        for (const rule of validate[key] ?? []) {
            const message = rule(values[key], values);
            if (message) {
                errors[key] = message;
                break;
            }
        }
    }
    return errors;
}

function differs<T extends FormValues>(a: T, b: T): boolean {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) if (!Object.is(a[key], b[key])) return true;
    return false;
}

export function useForm<T extends FormValues>({ initial, validate, onSubmit }: UseFormOptions<T>): FormState<T> {
    const [baseline, setBaseline] = useState<T>(initial);
    const [values, setValues] = useState<T>(initial);
    const [touched, setTouched] = useState<Partial<Record<keyof T, boolean>>>({});
    const [attempted, setAttempted] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<unknown>(null);
    // A ref, not the state: a double tap lands twice before the re-render that
    // would show `submitting`, and must not submit twice.
    const inFlight = useRef(false);

    const errors = validateValues(values, validate);
    const valid = Object.keys(errors).length === 0;

    const set = <K extends keyof T>(key: K, value: T[K]) => {
        setValues((prev) => ({ ...prev, [key]: value }));
        setTouched((prev) => ({ ...prev, [key]: true }));
    };

    const submit = async (): Promise<boolean> => {
        setAttempted(true);
        if (!valid || inFlight.current) return false;
        inFlight.current = true;
        setSubmitting(true);
        setSubmitError(null);
        try {
            await onSubmit(values);
            return true;
        } catch (error) {
            setSubmitError(error);
            return false;
        } finally {
            inFlight.current = false;
            setSubmitting(false);
        }
    };

    const reset = (next?: T) => {
        const target = next ?? baseline;
        setBaseline(target);
        setValues(target);
        setTouched({});
        setAttempted(false);
        setSubmitError(null);
    };

    return {
        values,
        set,
        field: (key) => ({
            value: values[key],
            onChangeText: (next) => set(key, next),
            error: touched[key] || attempted ? errors[key] : undefined,
        }),
        errors,
        valid,
        dirty: differs(values, baseline),
        submitting,
        submitError,
        canSubmit: valid && !submitting,
        submit,
        reset,
    };
}

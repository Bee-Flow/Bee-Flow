/**
 * Small, composable field validators for useForm.
 *
 * Each takes the message to show, because shared code may not carry copy of
 * its own: the caller passes `t('…', '…')`. A validator answers the message
 * when the value fails and null when it passes.
 */

export type Validator<V, T = Record<string, unknown>> = (value: V, values: T) => string | null;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Not blank. Whitespace alone is blank. */
export function required(message: string): Validator<unknown> {
    return (value) => {
        if (typeof value === 'string') return value.trim() ? null : message;
        return value === null || value === undefined ? message : null;
    };
}

/** At least `min` characters after trimming. An empty value passes; pair with `required`. */
export function minLength(min: number, message: string): Validator<unknown> {
    return (value) => {
        const trimmed = text(value).trim();
        return trimmed && trimmed.length < min ? message : null;
    };
}

/** At most `max` characters after trimming. */
export function maxLength(max: number, message: string): Validator<unknown> {
    return (value) => (text(value).trim().length > max ? message : null);
}

/** Matches `pattern`. An empty value passes; pair with `required`. */
export function matches(pattern: RegExp, message: string): Validator<unknown> {
    return (value) => {
        const trimmed = text(value).trim();
        return trimmed && !pattern.test(trimmed) ? message : null;
    };
}

/** Loose e-mail shape: something@something.tld. The server is the real check. */
export function email(message: string): Validator<unknown> {
    return matches(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, message);
}

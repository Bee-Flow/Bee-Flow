/**
 * Prop readers for an app definition. The definition arrives as JSON with no
 * schema at the type level, so each of these narrows one prop and returns
 * undefined rather than throwing — a single malformed prop must not take the
 * whole app off the screen.
 */

export interface SelectOption {
    value: string;
    label: string;
}

export function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

export function optionList(value: unknown): SelectOption[] {
    if (!Array.isArray(value)) return [];
    const out: SelectOption[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const optionValue = str(record.value);
        if (!optionValue) continue;
        out.push({ value: optionValue, label: str(record.label) ?? optionValue });
    }
    return out;
}

/** `{ kind: 'static', value }` is the only binding resolvable client-side. */
export function staticBinding(value: unknown): string | null {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (record.kind !== 'static') return null;
    const inner = record.value;
    if (inner === null || inner === undefined) return null;
    return typeof inner === 'object' ? null : String(inner);
}

/** input_date accepts `'today'` or a literal ISO date; both submit YYYY-MM-DD. */
export function defaultDate(value: string | undefined): string | null {
    if (!value) return null;
    if (value === 'today') return new Date().toISOString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

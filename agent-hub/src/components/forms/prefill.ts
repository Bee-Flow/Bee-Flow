import { emptyValue, initialValues, isDisplayField } from './formRules';
import type { FormFieldDef, FormValue, FormValues } from './PublicFormRenderer.types';

/** One saved answer as the question holds it, or undefined when it cannot be one. */
function answerFor(field: FormFieldDef, saved: unknown): FormValue | undefined {
    // A file or a picked record is never replayed from saved text.
    if (field.type === 'file' || field.type === 'app_pick') return undefined;
    if (field.type === 'checkbox') return saved === true || saved === 'true' ? true : saved === false || saved === 'false' ? false : undefined;
    if (field.type === 'multiselect') return Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string') : undefined;
    if (typeof saved === 'string') return saved;
    return typeof saved === 'number' && Number.isFinite(saved) ? String(saved) : undefined;
}

/**
 * The form's starting answers, with a saved set laid over them. Only the
 * questions this form declares take part, and only those that collect
 * something: a name the form does not know, or a display-only block, is
 * ignored. Every other question starts empty, so a scenario with fewer
 * answers clears what an earlier pick filled in.
 */
export function valuesWithPrefill(fields: FormFieldDef[] | null | undefined, prefill: Record<string, unknown> | null | undefined): FormValues {
    const values = initialValues(fields);
    if (!prefill) return values;
    for (const f of Array.isArray(fields) ? fields : []) {
        if (isDisplayField(f) || !Object.prototype.hasOwnProperty.call(prefill, f.name)) continue;
        const answer = answerFor(f, prefill[f.name]);
        values[f.name] = answer === undefined ? emptyValue(f) : answer;
    }
    return values;
}

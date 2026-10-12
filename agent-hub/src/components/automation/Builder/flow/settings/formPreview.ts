import { walkPath, previewValue } from '../../../../../utils/bindingHelpers';
import { normaliseOptions } from '../../../../forms/formOptions';

/**
 * What the form's live preview renders, as a pure function of the declaration.
 *
 * The preview is the visitor's view, and the visitor never sees `{{…}}`: the
 * server interpolates at the moment the page is shown. So resolve the same way
 * here, against the builder's sample tree.
 */

type Loose = Record<string, unknown>;

/** Field types that GIVE instead of ask (mirrors DISPLAY_FIELD_TYPES on the server). */
export const DISPLAY_FIELD_TYPES = ['download', 'notebook'];
export const isDisplayField = (f: unknown): boolean => DISPLAY_FIELD_TYPES.includes((f as Loose | null)?.type as string);

/**
 * Resolve `{{path}}` against the builder's sample tree for the preview only.
 * Unresolvable paths are left standing, so a typo stays visible instead of
 * quietly turning into an empty string.
 */
export function fillTemplate(text: unknown, sampleRoot: unknown): string {
    const s = String(text ?? '');
    if (!s || !sampleRoot || !/\{\{[^}]+\}\}/.test(s)) return s;
    return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (full: string, expr: string) => {
        const v = walkPath(expr.trim(), sampleRoot);
        return v === undefined ? full : previewValue(v, 40);
    });
}

export interface BuildPreviewArgs {
    form: Loose | null | undefined;
    theme: unknown;
    isEnding?: boolean;
    allowVariables?: boolean;
    previewSample?: unknown;
}

export function buildPreviewConfig({ form, theme, isEnding = false, allowVariables = false, previewSample = null }: BuildPreviewArgs) {
    const fill = allowVariables ? (s: unknown) => fillTemplate(s, previewSample) : (s: unknown) => (s as string);
    const fields = Array.isArray(form?.fields) ? (form.fields as Loose[]) : [];
    return {
        title: fill(form?.title) || (isEnding ? 'All done' : 'Form'),
        description: fill(form?.description) || '',
        submitLabel: fill(form?.submitLabel) || 'Submit',
        successMessage: fill(form?.successMessage) || 'Thanks!',
        theme,
        fields: fields.filter(f => f?.name).map(f => ({
            ...f,
            label: fill(f.label),
            placeholder: fill(f.placeholder),
            maxSizeMb: f.maxSizeMb || 10,
            options: normaliseOptions(f.options),
            // The real filename and size come from the ledger at serve time, so
            // the preview stands in for them.
            ...(isDisplayField(f) ? { filename: 'document.pdf', size: 182_000 } : {}),
        })),
    };
}

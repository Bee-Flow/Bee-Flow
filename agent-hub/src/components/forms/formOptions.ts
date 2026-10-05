/**
 * A select question's options as the form renders them: `{ value, label }`.
 *
 * The form builder stores what the author typed, one string per option; older
 * and server-built declarations carry objects. Every renderer reads them
 * through this, so "Test this form" (which hands over the raw declaration)
 * shows the same choices as the editor preview and the public page.
 */
export interface FormOption { value: string; label: string }

export function normaliseOptions(options: unknown): FormOption[] {
    if (!Array.isArray(options)) return [];
    return options
        .map((o): FormOption | null => {
            if (typeof o === 'string') return { value: o, label: o };
            if (o && typeof o === 'object' && (o as { value?: unknown }).value) {
                const { value, label } = o as { value: unknown; label?: unknown };
                return { value: String(value), label: label ? String(label) : String(value) };
            }
            return null;
        })
        .filter((o): o is FormOption => o !== null);
}

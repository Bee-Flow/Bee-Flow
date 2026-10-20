/**
 * A select question's options as the form renders them: `{ value, label }`.
 *
 * The form builder stores what the author typed, one string per option; older
 * and server-built declarations carry objects (`{ value, label?, hint? }`). Every renderer reads them
 * through this, so "Test this form" (which hands over the raw declaration)
 * shows the same choices as the editor preview and the public page.
 */
export interface FormOption { value: string; label: string; hint?: string }

export function normaliseOptions(options: unknown): FormOption[] {
    if (!Array.isArray(options)) return [];
    return options
        .map((o): FormOption | null => {
            if (typeof o === 'string') return { value: o, label: o };
            if (o && typeof o === 'object' && (o as { value?: unknown }).value) {
                const { value, label, hint } = o as { value: unknown; label?: unknown; hint?: unknown };
                return {
                    value: String(value),
                    label: label ? String(label) : String(value),
                    // A short line under the choice; only kept when it is text.
                    ...(typeof hint === 'string' && hint ? { hint } : {}),
                };
            }
            return null;
        })
        .filter((o): o is FormOption => o !== null);
}

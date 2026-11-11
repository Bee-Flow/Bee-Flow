import { resolveBinding } from '../../resolveBinding';
import type { BrowserStepModule } from '../browserSteps';

/** A text as copied: a string as is, a number or yes/no as written, a list or record as JSON, nothing as ''. */
export function clipboardText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try { return JSON.stringify(value) ?? ''; } catch { return String(value); }
}

/**
 * copy_to_clipboard (server/appStudio/componentSpecs/steps/copy_to_clipboard.js).
 * A browser that refuses (no secure page, no permission) fails the step with a
 * message, and the sequence ends there.
 */
const entry: BrowserStepModule = {
    kind: 'copy_to_clipboard',
    run: async ({ ctx, liveBag }, step, st) => {
        const { value } = resolveBinding(step.text as Parameters<typeof resolveBinding>[0], liveBag(st));
        const failed = () => new Error(ctx.tr('studio_apps_ui_steps.runtime.copy_failed', 'The text could not be copied to the clipboard.'));
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
        if (!clipboard || typeof clipboard.writeText !== 'function') throw failed();
        try {
            await clipboard.writeText(clipboardText(value));
        } catch {
            throw failed();
        }
    },
};

export default entry;

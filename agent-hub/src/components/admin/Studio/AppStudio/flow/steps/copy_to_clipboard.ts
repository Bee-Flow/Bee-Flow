import { ClipboardCopy } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `copy_to_clipboard` step (server/appStudio/componentSpecs/steps/copy_to_clipboard.js).
 * Its fields are drawn from the spec by StepSettings.
 */
const entry: StepKindModule = {
    kind: 'copy_to_clipboard',
    meta: {
        label: 'Copy to clipboard',
        labelKey: 'studio_apps_ui_steps.catalog.copy_to_clipboard_label',
        group: 'On screen',
        icon: ClipboardCopy,
        blurb: 'Copy a text, such as a reference or a link, to the person’s clipboard.',
        blurbKey: 'studio_apps_ui_steps.catalog.copy_to_clipboard_blurb',
    },
    newStep: () => ({ kind: 'copy_to_clipboard', text: { kind: 'static', value: '' } }),
};

export default entry;

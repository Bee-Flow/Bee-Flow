import { Focus } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `focus` step (server/appStudio/componentSpecs/steps/focus.js).
 * Its fields are drawn from the spec by StepSettings.
 */
const entry: StepKindModule = {
    kind: 'focus',
    meta: {
        label: 'Put the cursor in a field',
        labelKey: 'studio_apps_ui_steps.catalog.focus_label',
        group: 'On screen',
        icon: Focus,
        blurb: 'Move the keyboard focus to a component, so the person can type straight on.',
        blurbKey: 'studio_apps_ui_steps.catalog.focus_blurb',
    },
    newStep: () => ({ kind: 'focus', nodeId: '' }),
};

export default entry;

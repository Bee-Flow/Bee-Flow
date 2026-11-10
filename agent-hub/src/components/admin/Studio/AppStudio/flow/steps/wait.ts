import { Hourglass } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `wait` step (server/appStudio/componentSpecs/steps/wait.js).
 * Its fields are drawn from the spec by StepSettings.
 */
const entry: StepKindModule = {
    kind: 'wait',
    meta: {
        label: 'Wait a moment',
        labelKey: 'studio_apps_ui_steps.catalog.wait_label',
        group: 'Flow',
        icon: Hourglass,
        blurb: 'Pause for a few seconds before the next step (at most 30).',
        blurbKey: 'studio_apps_ui_steps.catalog.wait_blurb',
    },
    newStep: () => ({ kind: 'wait', seconds: 1 }),
};

export default entry;

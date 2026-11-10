import { SkipForward } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `continue` step (server/appStudio/componentSpecs/steps/continue.js):
 * skips the rest of the current round of the nearest loop or while. It has no fields.
 */
const entry: StepKindModule = {
    kind: 'continue',
    meta: {
        label: 'Skip to the next round',
        labelKey: 'studio_apps_flow_control.catalog.continue_label',
        group: 'Flow',
        icon: SkipForward,
        blurb: 'Skip the rest of this round of the loop.',
        blurbKey: 'studio_apps_flow_control.catalog.continue_blurb',
    },
    newStep: () => ({ kind: 'continue' }),
};

export default entry;

import { ArrowLeft } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `back` step (server/appStudio/componentSpecs/steps/back.js).
 * Its fields are drawn from the spec by StepSettings.
 */
const entry: StepKindModule = {
    kind: 'back',
    meta: {
        label: 'Go back',
        labelKey: 'studio_apps_ui_steps.catalog.back_label',
        group: 'On screen',
        icon: ArrowLeft,
        blurb: 'Return to the screen the person came from.',
        blurbKey: 'studio_apps_ui_steps.catalog.back_blurb',
    },
    newStep: () => ({ kind: 'back' }),
};

export default entry;

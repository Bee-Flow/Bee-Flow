import { CircleStop } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `break` step (server/appStudio/componentSpecs/steps/break.js):
 * leaves the nearest loop or while. It has no fields.
 */
const entry: StepKindModule = {
    kind: 'break',
    meta: {
        label: 'Leave the loop',
        labelKey: 'studio_apps_flow_control.catalog.break_label',
        group: 'Flow',
        icon: CircleStop,
        blurb: 'Stop repeating and go on with the step after the loop.',
        blurbKey: 'studio_apps_flow_control.catalog.break_blurb',
    },
    newStep: () => ({ kind: 'break' }),
};

export default entry;

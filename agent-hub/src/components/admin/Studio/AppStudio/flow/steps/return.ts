import { CornerDownLeft } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `return` step (server/appStudio/componentSpecs/steps/return.js):
 * ends the action it sits in. The value is optional, so a fresh step carries none.
 */
const entry: StepKindModule = {
    kind: 'return',
    meta: {
        label: 'Stop here',
        labelKey: 'studio_apps_flow_control.catalog.return_label',
        group: 'Flow',
        icon: CornerDownLeft,
        blurb: 'End the action now, optionally handing back a value.',
        blurbKey: 'studio_apps_flow_control.catalog.return_blurb',
    },
    newStep: () => ({ kind: 'return' }),
};

export default entry;

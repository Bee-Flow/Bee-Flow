import { ShieldCheck } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `try` step (server/appStudio/componentSpecs/steps/try.js):
 * runs steps and catches a failure. A fresh one carries an empty `catch`, so it handles
 * a failure from the start (leaving `catch` out would let the failure end the action); `finally`
 * appears on the step once something is dropped into its branch.
 */
const entry: StepKindModule = {
    kind: 'try',
    meta: {
        label: 'Try',
        labelKey: 'studio_apps_flow_control.catalog.try_label',
        group: 'Flow',
        icon: ShieldCheck,
        blurb: 'Run steps and decide what happens when one of them fails.',
        blurbKey: 'studio_apps_flow_control.catalog.try_blurb',
        container: true,
    },
    newStep: () => ({ kind: 'try', steps: [], catch: [] }),
};

export default entry;

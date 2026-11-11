import { Split } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `parallel` step (server/appStudio/componentSpecs/steps/parallel.js):
 * runs its branches side by side. A fresh one carries two empty branches, drawn on the canvas like
 * the cases of a switch; branches are added and removed in the step's settings.
 */
const entry: StepKindModule = {
    kind: 'parallel',
    meta: {
        label: 'Run side by side',
        labelKey: 'studio_apps_flow_parallel.catalog.parallel_label',
        group: 'Flow',
        icon: Split,
        blurb: 'Run several groups of steps at the same time and go on when all are done.',
        blurbKey: 'studio_apps_flow_parallel.catalog.parallel_blurb',
        container: true,
    },
    newStep: () => ({ kind: 'parallel', branches: [{ steps: [] }, { steps: [] }] }),
};

export default entry;

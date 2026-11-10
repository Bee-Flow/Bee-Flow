import { Repeat2 } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `while` step (server/appStudio/componentSpecs/steps/while.js):
 * repeats its steps while a formula holds. The steps are dropped into its body on the canvas.
 */
const entry: StepKindModule = {
    kind: 'while',
    meta: {
        label: 'Repeat while',
        labelKey: 'studio_apps_flow_control.catalog.while_label',
        group: 'Flow',
        icon: Repeat2,
        blurb: 'Run these steps again and again while a condition holds.',
        blurbKey: 'studio_apps_flow_control.catalog.while_blurb',
        container: true,
    },
    newStep: () => ({ kind: 'while', expr: '', steps: [] }),
};

export default entry;

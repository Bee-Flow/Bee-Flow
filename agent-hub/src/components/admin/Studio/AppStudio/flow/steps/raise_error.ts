import { AlertTriangle } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `raise_error` step (server/appStudio/componentSpecs/steps/raise_error.js):
 * fails the action with the author's message. The message starts as an empty text.
 */
const entry: StepKindModule = {
    kind: 'raise_error',
    meta: {
        label: 'Stop with an error',
        labelKey: 'studio_apps_flow_control.catalog.raise_error_label',
        group: 'Flow',
        icon: AlertTriangle,
        blurb: 'Fail the action on purpose, with your own message.',
        blurbKey: 'studio_apps_flow_control.catalog.raise_error_blurb',
    },
    newStep: () => ({ kind: 'raise_error', message: { kind: 'static', value: '' } }),
};

export default entry;

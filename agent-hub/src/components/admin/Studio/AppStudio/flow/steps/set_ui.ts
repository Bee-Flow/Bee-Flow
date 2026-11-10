import { PanelsTopLeft } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `set_ui` step (server/appStudio/componentSpecs/steps/set_ui.js).
 * Its fields are drawn from the spec by StepSettings.
 */
const entry: StepKindModule = {
    kind: 'set_ui',
    meta: {
        label: 'Switch a tab or dialog',
        labelKey: 'studio_apps_ui_steps.catalog.set_ui_label',
        group: 'On screen',
        icon: PanelsTopLeft,
        blurb: 'Choose the open tab, open or close a dialog, or set the selected rows of a grid.',
        blurbKey: 'studio_apps_ui_steps.catalog.set_ui_blurb',
    },
    newStep: () => ({ kind: 'set_ui', nodeId: '', state: 'activeTab', value: { kind: 'static', value: '' } }),
};

export default entry;

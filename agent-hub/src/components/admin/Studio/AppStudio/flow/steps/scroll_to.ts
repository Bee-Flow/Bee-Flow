import { ArrowDownToLine } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `scroll_to` step (server/appStudio/componentSpecs/steps/scroll_to.js).
 * Its fields are drawn from the spec by StepSettings.
 */
const entry: StepKindModule = {
    kind: 'scroll_to',
    meta: {
        label: 'Scroll to',
        labelKey: 'studio_apps_ui_steps.catalog.scroll_to_label',
        group: 'On screen',
        icon: ArrowDownToLine,
        blurb: 'Bring a component into view, or go back to the top of the screen.',
        blurbKey: 'studio_apps_ui_steps.catalog.scroll_to_blurb',
    },
    newStep: () => ({ kind: 'scroll_to', nodeId: 'top' }),
};

export default entry;

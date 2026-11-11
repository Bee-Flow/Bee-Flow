import { Hourglass } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `wait` step (server/appStudio/componentSpecs/steps/wait.js).
 * Its fields are drawn from the spec by StepSettings. A wait of more than 30 seconds, or until a
 * moment, needs an action that runs on the server.
 */
const NS = 'studio_apps_h2.wait';

const entry: StepKindModule = {
    kind: 'wait',
    meta: {
        label: 'Wait a moment',
        labelKey: 'studio_apps_ui_steps.catalog.wait_label',
        group: 'Flow',
        icon: Hourglass,
        blurb: 'Pause before the next step: a few seconds in the browser, or hours and days when the action runs on the server.',
        blurbKey: `${NS}.blurb`,
    },
    newStep: () => ({ kind: 'wait', seconds: 1 }),
    fields: {
        seconds: { hint: [`${NS}.hint_seconds`, 'In the browser at most 30. When the action runs on the server, longer waits put the run on hold.'] },
        until: {
            label: [`${NS}.field_until`, 'Wait until'],
            hint: [`${NS}.hint_until`, 'A date and time instead of seconds. Only when the action runs on the server.'],
        },
    },
};

export default entry;

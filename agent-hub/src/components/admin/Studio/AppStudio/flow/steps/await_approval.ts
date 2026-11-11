import { Hourglass } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * Step kind `await_approval` (server/appStudio/componentSpecs/steps/await_approval.js): asks for
 * an approval with the fields of "Ask for approval" and waits for the decision. The settings are
 * those of request_approval, drawn from the spec; only the action's "run on the server" option
 * lets it wait (the validator says so).
 */
const NS = 'studio_apps_h2.await_approval';

const awaitApproval: StepKindModule = {
    kind: 'await_approval',
    meta: {
        label: 'Ask and wait for approval', labelKey: `${NS}.label`, group: 'Data', icon: Hourglass,
        blurb: 'Ask for an approval and go on with the decision. Needs an action that runs on the server.',
        blurbKey: `${NS}.blurb`,
        server: true,
    },
    newStep: () => ({ kind: 'await_approval', prompt: { kind: 'static', value: '' }, resultVar: 'approval' }),
    fields: {
        timeoutHours: {
            label: [`${NS}.field_timeout`, 'Close the request after (hours)'],
            hint: [`${NS}.hint_timeout`, 'Then the step goes on with decision "expired". Empty: wait until someone decides.'],
        },
        resultVar: { hint: [`${NS}.hint_result_var`, 'Gets the decision: vars.<name>.decision is approved, rejected, expired or cancelled; vars.<name>.answers holds the answers.'] },
    },
};

export default awaitApproval;

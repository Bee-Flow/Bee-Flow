// @typecheck strict
'use strict';

// Steps shown one at a time with Back and Next (schema 3, package LK21b). Child i is the body
// of steps[i], like a tab panel of tabs. Inside a form, Next first runs the form's own rules on
// the fields of the step on screen; the form's submit button sends the whole form at the end.
// The step on screen is readable as ui.tabs.<wizard id>.active (the id of its child), the way
// a tabs group publishes its active tab.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base layout types only; a wizard stays in the browser.' },
    parts: ['root', 'steps', 'step', 'marker', 'title', 'panel', 'actions', 'back', 'next'],
    label: 'Wizard', category: 'Layout',
    description: 'Steps shown one at a time with Back and Next. Child number i is the body of step number i. '
        + 'Put the wizard inside a form: Next checks the fields of the step on screen with the form\'s rules (required, validations) before it moves on, '
        + 'and the form\'s own submit button sends every step\'s values at the end. '
        + 'ui.tabs.<wizard id>.active holds the id of the child on screen.',
    container: true,
    slotContainer: true,
    props: {
        steps: {
            type: 'list', maxItems: 12, default: [{ title: 'Step 1' }, { title: 'Step 2' }],
            itemShape: {
                title: { type: 'string', required: true, maxLen: 80 },
                description: { type: 'string', maxLen: 200 },
            },
        },
        backLabel: { type: 'string', maxLen: 40, default: null, description: 'The text of the Back button. Back when empty.' },
        nextLabel: { type: 'string', maxLen: 40, default: null, description: 'The text of the Next button. Next when empty.' },
        validateSteps: { type: 'boolean', default: true, description: 'false lets Next move on without checking the fields of the step.' },
    },
    styleKnobs: ['span', 'gap', 'padding'],
    defaultStyle: { span: 12, gap: 3, padding: 0 },
};

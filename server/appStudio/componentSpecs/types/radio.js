// @typecheck strict
'use strict';

const { LIMITS } = require('../limits');
const { VALUE_FROM } = require('../styleKnobs');

// A radio group (schema 3): one of a few visible options. Modelled on input_select, so it
// submits the chosen option's value as a string through the same form path.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base inputs only; a radio group stays in the browser.' },
    parts: ['root', 'label', 'group', 'option', 'control', 'text', 'error'],
    label: 'Radio group', category: 'Input', isInput: true,
    description: 'A group of radio buttons. Submits the chosen option value.',
    events: ['onChange'],
    props: {
        name: { type: 'string', required: true, maxLen: 60, default: 'choice' },
        label: { type: 'string', required: true, maxLen: 120, default: 'Choice' },
        options: {
            type: 'list', maxItems: LIMITS.MAX_SELECT_OPTIONS, default: [],
            itemShape: { value: { type: 'string', required: true, maxLen: 200 }, label: { type: 'string', maxLen: 200 } },
        },
        required: { type: 'boolean', default: false },
        defaultValue: { type: 'string', maxLen: 200, default: null },
        valueFrom: VALUE_FROM,
    },
    styleKnobs: ['span'],
    defaultStyle: { span: 6 },
};

'use strict';

const { VALUE_FROM } = require('../styleKnobs');

// An on/off input (schema 3). Modelled on input_checkbox: it submits a boolean through the
// same form path, and a required switch must be on, like a required checkbox.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base inputs only; a switch stays in the browser.' },
    parts: ['root', 'label', 'control', 'thumb', 'error'],
    label: 'Switch', category: 'Input', isInput: true,
    description: 'An on/off switch. Submits true or false.',
    events: ['onChange'],
    props: {
        name: { type: 'string', required: true, maxLen: 60, default: 'enabled' },
        label: { type: 'string', required: true, maxLen: 200, default: 'Enabled' },
        defaultChecked: { type: 'boolean', default: false },
        required: { type: 'boolean', default: false },
        valueFrom: VALUE_FROM,
    },
    styleKnobs: ['span'],
    defaultStyle: { span: 12 },
};

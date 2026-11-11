'use strict';

const { VALUE_FROM } = require('../styleKnobs');

// A range slider (schema 3). Modelled on input_number: it submits a number, bounded by min and max.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base inputs only; a slider stays in the browser.' },
    parts: ['root', 'label', 'control', 'value', 'error'],
    label: 'Slider', category: 'Input', isInput: true,
    description: 'A slider between a minimum and a maximum. Submits a number.',
    events: ['onChange'],
    props: {
        name: { type: 'string', required: true, maxLen: 60, default: 'level' },
        label: { type: 'string', required: true, maxLen: 120, default: 'Level' },
        min: { type: 'number', default: 0 },
        max: { type: 'number', default: 100 },
        step: { type: 'number', default: 1 },
        required: { type: 'boolean', default: false },
        defaultValue: { type: 'number', default: null },
        valueFrom: VALUE_FROM,
    },
    styleKnobs: ['span'],
    defaultStyle: { span: 6 },
};

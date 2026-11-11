// @typecheck strict
'use strict';

const { VALUE_FROM } = require('../styleKnobs');

// A star rating (schema 3). Submits a whole number from 1 to `max`; no value until one is chosen.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base inputs only; a rating stays in the browser.' },
    parts: ['root', 'label', 'control', 'star', 'error'],
    label: 'Rating', category: 'Input', isInput: true,
    description: 'A star rating. Submits a whole number from 1 to the number of stars.',
    events: ['onChange'],
    props: {
        name: { type: 'string', required: true, maxLen: 60, default: 'rating' },
        label: { type: 'string', required: true, maxLen: 120, default: 'Rating' },
        max: { type: 'int', min: 2, max: 10, default: 5 },
        required: { type: 'boolean', default: false },
        defaultValue: { type: 'number', default: null },
        valueFrom: VALUE_FROM,
    },
    styleKnobs: ['span'],
    defaultStyle: { span: 6 },
};

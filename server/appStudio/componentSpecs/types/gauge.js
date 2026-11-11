// @typecheck strict
'use strict';

const { COLOR_ROLES } = require('../styleKnobs');

// A half-circle meter for one value between min and max (schema 3, package LK21b). The
// thresholds colour the arc by the range the value falls in; without them it takes the
// primary colour. Modelled on progress, which draws a value against a ceiling.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base display types only; a gauge stays in the browser.' },
    parts: ['root', 'meter', 'track', 'fill', 'value', 'label', 'range'],
    label: 'Gauge', category: 'Data',
    description: 'A half-circle meter for one value between min and max. '
        + 'value is a binding (a number, e.g. an aggregate). thresholds colour the arc: each entry starts at `from`, the highest one the value reaches wins. '
        + 'Values outside min..max are drawn at the end of the arc and written as they are.',
    props: {
        value: { type: 'binding', default: { kind: 'static', value: 0 } },
        label: { type: 'string', maxLen: 120, default: null },
        min: { type: 'number', default: 0 },
        max: { type: 'number', default: 100 },
        unit: { type: 'string', maxLen: 20, default: null, description: 'Written after the value, e.g. % or kWh.' },
        thresholds: {
            type: 'list', maxItems: 6, default: [],
            itemShape: {
                from: { type: 'number', required: true },
                tone: { type: 'enum', values: COLOR_ROLES, default: 'primary' },
                label: { type: 'string', maxLen: 40 },
            },
        },
        showRange: { type: 'boolean', default: true, description: 'Writes min and max under the ends of the arc.' },
    },
    styleKnobs: ['span', 'size'],
    defaultStyle: { span: 4 },
};

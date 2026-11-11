'use strict';

// A round picture of a person or thing (schema 3), with the initials of `name` when there is
// no picture. The source follows the image type: an https URL or asset:<id>, or a binding.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base display types only; an avatar stays in the browser.' },
    parts: ['root', 'image', 'initials'],
    label: 'Avatar', category: 'Content',
    description: 'A round picture with initials as fallback.',
    props: {
        src: { type: 'url', default: null },
        srcFrom: {
            type: 'binding', default: null,
            description: 'Shows the picture a binding resolves to (an https URL or asset:<id>); src stays the fallback.',
        },
        name: { type: 'string', maxLen: 120, default: null, description: 'The name the initials come from. Also the accessible name.' },
        nameFrom: {
            type: 'binding', default: null,
            description: 'Takes the name from a binding (for example a column); name stays the fallback.',
        },
        size: { type: 'enum', values: ['sm', 'md', 'lg'], default: 'md' },
    },
    styleKnobs: ['span', 'align'],
    defaultStyle: { span: 2 },
};

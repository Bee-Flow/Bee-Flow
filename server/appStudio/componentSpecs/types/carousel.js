// @typecheck strict
'use strict';

// Slides shown one at a time (schema 3). Every child is one slide: an ordinary node
// (usually a container). No autoplay: the viewer moves with the buttons or the dots.
module.exports = {
    since: 3,
    mobile: { reason: 'The phone draws the base layout types only; a carousel stays in the browser.' },
    parts: ['root', 'viewport', 'slide', 'previous', 'next', 'dots', 'dot'],
    label: 'Carousel', category: 'Layout',
    description: 'Slides shown one at a time. Every child is one slide.',
    container: true,
    slotContainer: true,
    props: {
        loop: { type: 'boolean', default: false, description: 'true wraps from the last slide to the first, and back.' },
        showDots: { type: 'boolean', default: true },
    },
    styleKnobs: ['span', 'gap', 'padding'],
    defaultStyle: { span: 12, gap: 3, padding: 0 },
};

// @typecheck strict
/**
 * Text knobs: the typeface, size, line spacing, letter spacing and case of a component's text.
 *
 * Granted with `color`, so the text-bearing types that already hold it (heading, text, stat,
 * markdown) earn the group without a per-type list edit. Every first value is the identity: it
 * is what the component does without the knob, and it is never written out unless a definition
 * sets it. The web draws the group in runtime/styleKnobs/text.ts.
 */

'use strict';

module.exports = {
    since: 3,
    grantedBy: 'color',
    knobs: {
        font: {
            type: 'enum', values: ['body', 'heading', 'mono'], default: 'body', since: 3,
            description: 'Typeface role of the text: body, heading or mono. heading follows the app heading font when the design sets one, otherwise it equals body. Use mono for codes, ids and amounts that should line up.',
        },
        textSize: {
            type: 'enum', values: ['auto', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl'], default: 'auto', since: 3,
            description: 'Exact text size from xs to 4xl, md is body size. auto keeps the size the component picks itself. A component that fixes the size of an inner part (a stat value) keeps that size, so use size on a stat instead.',
        },
        lineHeight: {
            type: 'enum', values: ['auto', 'tight', 'normal', 'relaxed'], default: 'auto', since: 3,
            description: 'Space between lines of text: tight, normal or relaxed. auto keeps the component default. Tight suits big headings, relaxed suits long paragraphs.',
        },
        tracking: {
            type: 'enum', values: ['auto', 'tight', 'normal', 'wide'], default: 'auto', since: 3,
            description: 'Space between letters: tight, normal or wide. auto keeps the component default. Wide together with transform uppercase makes a small label above a title.',
        },
        transform: {
            type: 'enum', values: ['none', 'uppercase'], default: 'none', since: 3,
            description: 'Letter case: none keeps what was typed, uppercase shows capitals. Keep uppercase for short labels, it is hard to read in long text.',
        },
    },
};

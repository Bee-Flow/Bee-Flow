// @typecheck strict
/**
 * App Studio style knob group "hover": a preset reaction when the pointer rests on a
 * component (package LK23).
 *
 * Granted by rule to every type whose style list has `span` and drawn by classes on the
 * node's grid cell (runtime/styleKnobs/hover.ts + hover.css), so no component file changes.
 * The classes are inert in the editor canvas (data-app-edit) and under the OS reduced-motion
 * setting. The knob is optional and absent by default; 'none' is the identity.
 */

'use strict';

module.exports = {
    since: 3,
    grantedBy: 'span',
    knobs: {
        hover: {
            type: 'enum', values: ['none', 'lift', 'tint', 'outline', 'grow'], default: 'none', since: 3,
            description: 'Reaction to the pointer: none, lift, tint, outline or grow.'
                + ' lift raises it a little with a shadow, tint washes it with the primary colour, outline rings it in the primary colour, grow scales it up by 2 percent.'
                + ' Use it on a block that is clickable (a card that opens a record, a stat that links on) so it reads as one, not on every block.'
                + ' It does nothing on touch screens, in the editor canvas or when the viewer asks for reduced motion, so never make it the only sign that something can be clicked.',
        },
    },
};

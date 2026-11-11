// @typecheck strict
/**
 * App Studio style knob group "backdrop": a picture behind a component (package LK23).
 *
 * The picture is an asset of the app (`asset:<id>`, the value type of valueTypes.js), drawn
 * by a layer under the node's content (runtime/styleKnobs/backdrop.ts and the
 * BackgroundImageLayer in runtime/assets/), so no component file changes. A public page
 * serves the asset because its reference stands literally in the public definition.
 *
 * Withheld from the types whose component draws a framed box of its own at its root (the
 * same list as the "box" group): the picture would sit hidden behind that fill.
 * Every knob is optional and absent by default.
 */

'use strict';

const WITHHELD = ['button', 'callout', 'ai_chat', 'approval_list', 'browser_view', 'pdf_compare', 'connector_status'];

const WHERE = ` Not on ${WITHHELD.slice(0, -1).join(', ')} or ${WITHHELD[WITHHELD.length - 1]}, which frame their own box.`;

module.exports = {
    since: 3,
    grantedBy: 'span',
    withheldFrom: WITHHELD,
    knobs: {
        backgroundImage: {
            type: 'asset', default: null, since: 3,
            description: 'A picture behind the component: asset:<id> of an uploaded image, or null.'
                + ' Upload the image to the app first and use its asset id; a web address is not accepted. The picture sits under the content and follows the corners of the box.'
                + ' Text over a picture is hard to read: set backgroundOverlay (dim for light text, light for dark text) and give the text the matching color, or keep the text off the picture.' + WHERE,
        },
        backgroundFit: {
            type: 'enum', values: ['cover', 'contain', 'tile'], default: 'cover', since: 3,
            description: 'How the picture fills the box: cover, contain or tile.'
                + ' cover fills the box and crops the edges, contain shows the whole picture with room around it, tile repeats it at its own size (patterns, textures). Only has an effect together with backgroundImage.' + WHERE,
        },
        backgroundOverlay: {
            type: 'enum', values: ['none', 'dim', 'light'], default: 'none', since: 3,
            description: 'A veil over the picture for readable content: none, dim or light.'
                + ' dim darkens the picture (for white text), light brightens it (for dark text). The validator warns about a picture without a veil under a component that shows text. Only has an effect together with backgroundImage.' + WHERE,
        },
    },
};

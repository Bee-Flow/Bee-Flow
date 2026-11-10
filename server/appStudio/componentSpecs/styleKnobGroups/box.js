// @typecheck strict
/**
 * App Studio style knob group "box": margins, elevation, opacity, border and fill of a
 * component's box (package LK2).
 *
 * Granted by rule to every type whose style list has `span`, and painted on the node's
 * GRID CELL (runtime/styleKnobs/box.ts), so no component file changes. The cell is
 * already the visible box of card, container, pane, form and record_detail (their
 * background, border and radius knobs paint there too), so on those types these knobs
 * refine the same box: backgroundColor wins over `background`, and a border knob of this
 * group replaces `border`.
 *
 * Withheld from the types whose component draws a framed box of its own at its root
 * (fill, border and corners on its own element): a cell-level box would sit around that
 * one as a second box. Read from the components:
 *   button            the <button> paints its variant fill, border and corners
 *   callout           a tinted box with an accent edge and corners
 *   ai_chat           a bordered card on --bg-card
 *   approval_list     a rounded, bordered frame
 *   browser_view      a bordered frame with a header bar
 *   pdf_compare       a bordered shell
 *   connector_status  a rounded, bordered card in every state
 *
 * Every knob is optional and absent by default. The first value of an enum, opacity 100
 * and a margin of 0 draw nothing, so a style that sets them looks as if it did not.
 */

'use strict';

// styleKnobs.COLOR_ROLES, written out: styleKnobs.js loads this file while it is itself
// loading, so requiring it here would read an unfinished module (the group test pins the two).
const COLOR_ROLES = ['primary', 'neutral', 'success', 'warning', 'danger', 'info'];

const WITHHELD = ['button', 'callout', 'ai_chat', 'approval_list', 'browser_view', 'pdf_compare', 'connector_status'];

const WHERE = ` Not on ${WITHHELD.slice(0, -1).join(', ')} or ${WITHHELD[WITHHELD.length - 1]}, which frame their own box.`;

module.exports = {
    since: 3,
    grantedBy: 'span',
    withheldFrom: WITHHELD,
    knobs: {
        marginTop: {
            type: 'int', min: 0, max: 8, step: 1, default: 0, since: 3,
            description: 'Extra space above the component, in spacing steps.'
                + ' 0..8 steps of 4px times the theme density, added outside the box. Use it to set a block apart from the one above it instead of adding a spacer.' + WHERE,
        },
        marginBottom: {
            type: 'int', min: 0, max: 8, step: 1, default: 0, since: 3,
            description: 'Extra space below the component, in spacing steps.'
                + ' 0..8 steps of 4px times the theme density, added outside the box.' + WHERE,
        },
        shadow: {
            type: 'enum', values: ['none', 'sm', 'md', 'lg'], default: 'none', since: 3,
            description: 'Elevation of the component box: none, sm, md or lg.'
                + ' Uses the theme elevation tokens, which become outline rings in high contrast, so a raised box stays visible in every theme.'
                + ' Give the box a surface too (backgroundColor, or background "surface" on a card) or the shadow outlines bare content.' + WHERE,
        },
        opacity: {
            type: 'int', min: 10, max: 100, step: 5, default: 100, since: 3,
            description: 'How opaque the component is, from 10 to 100 percent.'
                + ' 100 changes nothing. Use it to quiet a secondary block, not to hide one (use visibility for that); text below about 60 gets hard to read.' + WHERE,
        },
        borderWidth: {
            type: 'int', min: 1, max: 4, step: 1, default: 1, since: 3,
            description: 'Border thickness in pixels, 1 to 4.'
                + ' Setting any of borderWidth, borderSides or borderColor draws a solid border on the box and replaces the border knob where the type has one.'
                + ' Without borderColor the border takes the theme border colour, without borderSides it goes all round.' + WHERE,
        },
        borderSides: {
            type: 'enum', values: ['all', 'top', 'right', 'bottom', 'left', 'x', 'y'], default: 'all', since: 3,
            description: 'Which sides get the border: all, top, right, bottom, left, x or y.'
                + ' x is left and right, y is top and bottom. One side with borderWidth 3 and a role colour makes an accent bar.' + WHERE,
        },
        borderColor: {
            type: 'colorOrRole', roles: COLOR_ROLES, default: null, since: 3,
            description: 'Border colour: a role or a #rrggbb colour.'
                + ' A role follows the theme in light, dark and high contrast, a hex colour stays exactly as written in every theme. Draws a border by itself (1px, all sides).' + WHERE,
        },
        backgroundColor: {
            type: 'colorOrRole', roles: COLOR_ROLES, default: null, since: 3,
            description: 'Fill of the component box: a role or a #rrggbb colour.'
                + ' Wins over the background knob where the type has one. A role paints a soft wash of that colour over the card surface, so text stays readable in light, dark and high contrast.'
                + ' A hex colour paints exactly that colour in every theme: the validator warns when the text on it would be hard to read, and a role is the safer choice.'
                + ' A card, stat or page_header with a look other than its default paints that look\'s own surface inside the box, so pick the look or this fill, not both. Most types have no padding knob, so text sits tight against the fill: put it in a card or container for an inset.' + WHERE,
        },
    },
};

// @typecheck strict
'use strict';

/** Conditional style on a component (componentSpecs/styleRuleShape.js, canonicalize/styleWhen.mts). */
module.exports = {
    since: 3,
    shape: '[{ when: "<formula>", style: { <knob>: <value> } }] (≤6)',
    description: 'Style that applies while a formula is true, on top of the style. '
        + 'A list of at most 6 rules { when: "<formula>", style: { … } }, checked in order: every rule whose formula is true lays its knobs over the component\'s style, and a later match wins. '
        + 'The formula sees the same scope as visibleWhen (vars, form, records, currentUser, and item/index inside a repeater). '
        + 'A rule may only set look knobs the component\'s type already has: color, background, border, radius, weight, the box knobs (shadow, opacity, borderWidth, borderSides, borderColor, backgroundColor) and the text knobs (font, textSize, lineHeight, tracking, transform). '
        + 'Layout knobs (span, size, height, width, placement, margins) are never conditional. '
        + 'A formula that fails leaves the base style. Example: [{ when: "vars.total > vars.budget", style: { color: "danger", weight: "bold" } }]. '
        + 'For a table or data_grid cell use the column\'s cellStyle instead. Set it with app_update_component { id, styleWhen: [...] }; null removes it. Ignored on the phone.',
};

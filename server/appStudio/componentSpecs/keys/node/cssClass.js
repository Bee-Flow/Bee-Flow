// @typecheck strict
'use strict';

/** A class name of the author's own on a component, for the app's stylesheet (appCss.mts). */
module.exports = {
    since: 3,
    shape: 'string: a lower-case letter, then letters, digits or dashes (≤40)',
    description: 'A class name of your own on this component, for design.customCss. '
        + 'The component\'s cell gets the class u-<name>: cssClass "hero" is styled with .u-hero { … } in design.customCss, and several components may share one name. '
        + 'It does nothing without a rule in design.customCss, and it is ignored on the phone. Use it when a rule should hit a few chosen components; one component alone is also reachable as [data-node-id="<id>"]. Pass null to remove it.',
};

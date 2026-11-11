// @typecheck strict
'use strict';

/** A short text shown on hover and keyboard focus of any component (schema 3, package LK21b). */
module.exports = {
    since: 3,
    shape: 'string ≤200, plain text',
    description: 'Short text shown on pointer hover and keyboard focus of the component. '
        + 'Plain text only, at most 200 characters; screen readers announce it as the description of the control inside. '
        + 'Use it to explain an abbreviation or what a button does, not for content people must read. Ignored on the phone. Pass null to remove it.',
};

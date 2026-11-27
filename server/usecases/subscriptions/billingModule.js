// @typecheck strict
/**
 * The Stripe and trial services of the subscription routes, looked up by name.
 *
 * Both belong to the module "billing_stripe". Plans, subscriptions and the
 * licence are core; without that module an installation takes no payments (no
 * checkout, no portal, no seat sync, no webhooks). A route that cannot work
 * without Stripe refuses with 409 module_absent instead of pretending a change
 * happened; a caller that already answers "Stripe is not enabled" passes that
 * answer as `absent`, so an installation without the module reads like one
 * where Stripe is switched off.
 */

'use strict';

const { optionalFeatureModule } = require('../../core/featureModules');
const { HttpError } = require('../../core/http/errors');

const ABSENT_TEXT = 'Payments are not available here: the Stripe billing module is not installed.';

/**
 * @template {'services/stripeService' | 'services/trialService'} K
 * @param {K} name
 * @param {() => Error} [absent] the error to throw when the module is absent (default: 409 module_absent)
 */
function billingModule(name, absent) {
    const mod = optionalFeatureModule(name);
    if (mod) return mod;
    throw absent ? absent() : new HttpError(409, 'module_absent', ABSENT_TEXT);
}

module.exports = { billingModule };

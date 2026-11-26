// @typecheck strict
/**
 * core/featureModules.js: the optional lookup next to the throwing one.
 * (boot/featureModules.test.js holds the registrations against the names the tree asks for.)
 *
 * Run: cd server && node --test core/featureModules.test.js
 */

'use strict';

const registry = require('./featureModules');
const { optionalLookupContract } = require('../testUtils/optionalLookup.testkit');

/** A name outside FeatureModuleMap, so the typed lookups take it as any. */
const NAME = /** @type {any} */ ('_probe/optional');

optionalLookupContract({
    kind: 'featureModules',
    name: NAME,
    register: (value) => registry.registerFeatureModules({ [NAME]: () => value }),
    required: (name) => registry.featureModule(/** @type {any} */ (name)),
    optional: (name) => registry.optionalFeatureModule(/** @type {any} */ (name)),
    clear: (name) => registry._clearFeatureModulesForTests(name),
});

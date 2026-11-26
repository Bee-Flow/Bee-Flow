// @typecheck strict
/**
 * The shared contract of the optional lookups (optionalFeatureModule,
 * optionalIntegrationClient, optionalRunnerPort): registered -> the value the
 * throwing lookup returns; absent -> null; declared by a failed module -> a
 * ModuleFailedError, never null. Each registry's test runs these cases with
 * its own functions.
 */

'use strict';

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert');

const moduleState = require('../modules/firstParty/moduleState');

/**
 * @typedef {{
 *   kind: 'featureModules' | 'integrationClients' | 'runnerPorts',
 *   name: string,
 *   register: (value: object) => void,
 *   required: (name: string) => unknown,
 *   optional: (name: string) => unknown,
 *   clear: (name: string) => void,
 * }} OptionalLookupSubject
 */

/** @param {OptionalLookupSubject} s */
function optionalLookupContract(s) {
    describe(`optional ${s.kind} lookup`, () => cases(s));
}

/** @param {OptionalLookupSubject} s */
function cases(s) {
    afterEach(() => {
        s.clear(s.name);
        moduleState._resetModuleStateForTests();
    });

    test('a registered name returns what the throwing lookup returns', () => {
        s.register({ ping: () => 'pong' });
        assert.strictEqual(s.optional(s.name), s.required(s.name));
        // Registered wins even when the declared provider is marked failed.
        moduleState.declareProvides('probeModule', { [s.kind]: [s.name] });
        moduleState.setModuleState('probeModule', 'failed', 'x');
        assert.strictEqual(s.optional(s.name), s.required(s.name));
    });

    test('an unknown or absent name is null, the throwing lookup still throws', () => {
        assert.strictEqual(s.optional(s.name), null);
        assert.throws(() => s.required(s.name), /is not registered/);
        moduleState.declareProvides('probeModule', { [s.kind]: [s.name] });
        assert.strictEqual(s.optional(s.name), null);
        moduleState.setModuleState('probeModule', 'loaded');
        assert.strictEqual(s.optional(s.name), null);
    });

    test('a name whose declared provider failed throws MODULE_FAILED', () => {
        moduleState.declareProvides('probeModule', { [s.kind]: [s.name] });
        moduleState.setModuleState('probeModule', 'failed', 'broken manifest');
        assert.throws(() => s.optional(s.name), { code: 'MODULE_FAILED', moduleId: 'probeModule', detail: 'broken manifest' });
        assert.throws(() => s.required(s.name), /is not registered/);
        moduleState._resetModuleStateForTests();
        assert.strictEqual(s.optional(s.name), null);
    });
}

module.exports = { optionalLookupContract };

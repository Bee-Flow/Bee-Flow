/**
 * Unit — testUtils/featureDouble: a double registered by name answers the lookup, and restore()
 * puts back what was there (a getter, or nothing).
 * Run: node --test testUtils/featureDouble.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { stubFeatureModule } = require('./featureDouble');
const { optionalFeatureModule, registerFeatureModules, _featureModuleGetter, _clearFeatureModulesForTests } = require('../core/featureModules');

test('the double answers the lookup by name; restore() puts the previous getter back', () => {
    const real = () => ({ real: true });
    registerFeatureModules({ 'testUtils/__double__': real });
    const double = { real: false };
    const restore = stubFeatureModule('testUtils/__double__', double);
    try {
        assert.strictEqual(optionalFeatureModule('testUtils/__double__'), double);
    } finally {
        restore();
        restore();
    }
    assert.strictEqual(_featureModuleGetter('testUtils/__double__'), real, 'idempotent, and the real getter is back');
    _clearFeatureModulesForTests('testUtils/__double__');
});

test('a name nothing registered is unregistered again on restore', () => {
    const restore = stubFeatureModule('testUtils/__nothing__', { x: 1 });
    assert.deepStrictEqual(optionalFeatureModule('testUtils/__nothing__'), { x: 1 });
    restore();
    assert.strictEqual(_featureModuleGetter('testUtils/__nothing__'), undefined);
});

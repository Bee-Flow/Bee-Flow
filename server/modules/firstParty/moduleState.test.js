// @typecheck strict
/**
 * modules/firstParty/moduleState.js: declarations, states, and the failed-provider check.
 *
 * Run: cd server && node --test modules/firstParty/moduleState.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const state = require('./moduleState');

test.beforeEach(() => state._resetModuleStateForTests());

test('a module nobody declared or set is absent and provides nothing', () => {
    assert.strictEqual(state.moduleStateOf('nope'), 'absent');
    assert.strictEqual(state.providerOf('featureModules', 'x/y'), null);
    assert.doesNotThrow(() => state.assertProviderNotFailed('featureModules', 'x/y'));
});

test('a declared module is the provider of its names, per kind', () => {
    state.declareProvides('mailbox', { featureModules: ['services/email/draft'], runnerPorts: ['mail'] });
    assert.strictEqual(state.providerOf('featureModules', 'services/email/draft'), 'mailbox');
    assert.strictEqual(state.providerOf('runnerPorts', 'mail'), 'mailbox');
    assert.strictEqual(state.providerOf('integrationClients', 'mail'), null);
    assert.strictEqual(state.moduleStateOf('mailbox'), 'absent');
});

test('declaring again replaces the earlier names; another module may not take a name', () => {
    state.declareProvides('a', { integrationClients: ['one', 'two'] });
    state.declareProvides('a', { integrationClients: ['two'] });
    assert.strictEqual(state.providerOf('integrationClients', 'one'), null);
    assert.strictEqual(state.providerOf('integrationClients', 'two'), 'a');
    assert.throws(() => state.declareProvides('b', { integrationClients: ['two'] }), /declared by "a" and "b"/);
    assert.strictEqual(state.providerOf('integrationClients', 'two'), 'a');
});

test('loaded and failed are recorded; a bad state or id is refused', () => {
    state.setModuleState('a', 'loaded');
    assert.strictEqual(state.moduleStateOf('a'), 'loaded');
    state.setModuleState('a', 'failed', 'boom');
    assert.strictEqual(state.moduleStateOf('a'), 'failed');
    assert.throws(() => state.setModuleState('a', /** @type {any} */ ('absent')), TypeError);
    assert.throws(() => state.setModuleState('', 'loaded'), TypeError);
    assert.throws(() => state.providerOf(/** @type {any} */ ('nope'), 'x'), TypeError);
});

test('assertProviderNotFailed throws MODULE_FAILED only for a failed provider', () => {
    state.declareProvides('a', { runnerPorts: ['p'] });
    assert.doesNotThrow(() => state.assertProviderNotFailed('runnerPorts', 'p'));
    state.setModuleState('a', 'loaded');
    assert.doesNotThrow(() => state.assertProviderNotFailed('runnerPorts', 'p'));
    state.setModuleState('a', 'failed', 'syntax error in index.js');
    assert.throws(() => state.assertProviderNotFailed('runnerPorts', 'p'), (err) => {
        assert.ok(err instanceof state.ModuleFailedError);
        assert.strictEqual(err.code, 'MODULE_FAILED');
        assert.strictEqual(err.moduleId, 'a');
        assert.strictEqual(err.detail, 'syntax error in index.js');
        assert.match(err.message, /module "a" failed to load, so runnerPorts "p" is unavailable/);
        return true;
    });
    assert.doesNotThrow(() => state.assertProviderNotFailed('runnerPorts', 'other'));
    assert.doesNotThrow(() => state.assertProviderNotFailed('featureModules', 'p'));
});

test('the reset forgets declarations and states', () => {
    state.declareProvides('a', { featureModules: ['f'] });
    state.setModuleState('a', 'failed');
    state._resetModuleStateForTests();
    assert.strictEqual(state.moduleStateOf('a'), 'absent');
    assert.strictEqual(state.providerOf('featureModules', 'f'), null);
    assert.doesNotThrow(() => state.assertProviderNotFailed('featureModules', 'f'));
});

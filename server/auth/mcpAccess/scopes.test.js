'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SERVERS, LEGACY_SCOPES, normalizeScopes, scopeAllowsTool, filterToolsByScope } = require('./scopes');

test('the four servers', () => {
    assert.deepEqual([...SERVERS], ['integrations', 'automations', 'studio', 'cms']);
});

test('legacy scopes: every server at write, cms without publish', () => {
    for (const s of SERVERS) assert.equal(LEGACY_SCOPES[s].level, 'write', s);
    assert.equal(LEGACY_SCOPES.cms.publish, false);
    assert.equal(scopeAllowsTool(LEGACY_SCOPES, 'cms', 'cms_publish', { publish: true }), false);
    assert.equal(scopeAllowsTool(LEGACY_SCOPES, 'cms', 'cms_update_page', {}), true);
    assert.throws(() => { LEGACY_SCOPES.cms.publish = true; }, TypeError);
});

test('normalizeScopes returns the canonical form', () => {
    const out = normalizeScopes({
        integrations: { level: 'read', tools: [' nextcloud_search ', 'nextcloud_search', 'mail_list'] },
        cms: { level: 'write' },
        studio: { level: 'write', tools: [] },
    });
    assert.deepEqual(out, {
        integrations: { level: 'read', tools: ['nextcloud_search', 'mail_list'] },
        cms: { level: 'write', publish: false },
        studio: { level: 'write' },
    });
    assert.equal(normalizeScopes({ cms: { level: 'write', publish: true } }).cms.publish, true);
});

test('normalizeScopes refuses bad input with a 400', () => {
    const bad = [
        null, undefined, 'read', [], {}, // not an object / empty
        { nope: { level: 'read' } }, // unknown server
        { studio: 'read' }, { studio: null }, // not an object
        { studio: {} }, { studio: { level: 'admin' } }, // level
        { studio: { level: 'read', publish: true } }, // publish is cms only
        { studio: { level: 'read', extra: 1 } }, // unknown key
        { studio: { level: 'read', tools: 'x' } }, { studio: { level: 'read', tools: [1] } },
        { studio: { level: 'read', tools: [''] } }, { studio: { level: 'read', tools: ['x'.repeat(129)] } },
        { cms: { level: 'write', publish: 'yes' } },
        { cms: { level: 'read', publish: true } },
    ];
    for (const input of bad) {
        assert.throws(() => normalizeScopes(input), (e) => e.status === 400 && e.code === 'invalid_scopes', JSON.stringify(input));
    }
});

test('a server absent from the scopes is denied', () => {
    const scopes = { studio: { level: 'write' } };
    assert.equal(scopeAllowsTool(scopes, 'automations', 'x', { readOnly: true }), false);
    assert.equal(scopeAllowsTool(scopes, 'studio', 'x', {}), true);
    assert.equal(scopeAllowsTool(null, 'studio', 'x', {}), false);
    assert.equal(scopeAllowsTool(undefined, 'studio', 'x', {}), false);
});

test('level read allows only read-only tools; write allows both', () => {
    const read = { integrations: { level: 'read' } };
    const write = { integrations: { level: 'write' } };
    assert.equal(scopeAllowsTool(read, 'integrations', 't', { readOnly: true }), true);
    assert.equal(scopeAllowsTool(read, 'integrations', 't', { readOnly: false }), false);
    assert.equal(scopeAllowsTool(read, 'integrations', 't', {}), false, 'unclassified counts as write');
    assert.equal(scopeAllowsTool(write, 'integrations', 't', { readOnly: false }), true);
    assert.equal(scopeAllowsTool(write, 'integrations', 't', { readOnly: true }), true);
});

test('an unknown level fails closed', () => {
    assert.equal(scopeAllowsTool({ studio: { level: 'admin' } }, 'studio', 't', { readOnly: true }), false);
    assert.equal(scopeAllowsTool({ studio: {} }, 'studio', 't', { readOnly: true }), false);
});

test('a tools list narrows the server to those names', () => {
    const scopes = { integrations: { level: 'write', tools: ['a', 'b'] } };
    assert.equal(scopeAllowsTool(scopes, 'integrations', 'a', {}), true);
    assert.equal(scopeAllowsTool(scopes, 'integrations', 'c', {}), false);
});

test('publish tools need cms.publish === true', () => {
    const without = { cms: { level: 'write', publish: false } };
    const missing = { cms: { level: 'write' } };
    const withPublish = { cms: { level: 'write', publish: true } };
    assert.equal(scopeAllowsTool(without, 'cms', 'cms_publish', { publish: true }), false);
    assert.equal(scopeAllowsTool(missing, 'cms', 'cms_publish', { publish: true }), false);
    assert.equal(scopeAllowsTool(withPublish, 'cms', 'cms_publish', { publish: true }), true);
    assert.equal(scopeAllowsTool(withPublish, 'cms', 'cms_update_page', {}), true);
    // A read token never publishes, whatever the flag says.
    assert.equal(scopeAllowsTool({ cms: { level: 'read', publish: true } }, 'cms', 'cms_publish', { publish: true, readOnly: false }), false);
});

test('filterToolsByScope keeps what the scopes allow, using the annotations by default', () => {
    const tools = [
        { name: 'list_things', annotations: { readOnlyHint: true } },
        { name: 'change_thing', annotations: { readOnlyHint: false } },
        { name: 'unclassified' },
    ];
    assert.deepEqual(filterToolsByScope({ studio: { level: 'read' } }, 'studio', tools).map((t) => t.name), ['list_things']);
    assert.deepEqual(filterToolsByScope({ studio: { level: 'write' } }, 'studio', tools).map((t) => t.name),
        ['list_things', 'change_thing', 'unclassified']);
    assert.deepEqual(filterToolsByScope({ studio: { level: 'write', tools: ['change_thing'] } }, 'studio', tools).map((t) => t.name), ['change_thing']);
    assert.deepEqual(filterToolsByScope({ automations: { level: 'write' } }, 'studio', tools), []);
});

test('filterToolsByScope takes custom classifiers (publish tools)', () => {
    const tools = [{ name: 'cms_get' }, { name: 'cms_publish' }];
    const classify = { isReadOnly: (t) => t.name === 'cms_get', isPublish: (t) => t.name === 'cms_publish' };
    assert.deepEqual(filterToolsByScope({ cms: { level: 'write', publish: false } }, 'cms', tools, classify).map((t) => t.name), ['cms_get']);
    assert.deepEqual(filterToolsByScope({ cms: { level: 'write', publish: true } }, 'cms', tools, classify).map((t) => t.name), ['cms_get', 'cms_publish']);
    assert.deepEqual(filterToolsByScope({ cms: { level: 'read' } }, 'cms', tools, classify).map((t) => t.name), ['cms_get']);
});

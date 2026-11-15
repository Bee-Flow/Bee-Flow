/**
 * modelVision.mts: the strict "can this model see an image" for automations,
 * read off the adapters' own catalogs; anything unknown is no.
 *
 * Run: cd server && node --test core/llm/modelVision.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const { modelAcceptsImages } = require('./modelVision.mts');
const { getAdapter, baseAdapter } = require('../providers');

const served = (providerType, url = '') => ({ getProviderForModel: async () => ({ providerType, url }), getAdapter, baseAdapter });

test('a model the adapter catalog marks as seeing is accepted, per provider', async () => {
    assert.strictEqual(await modelAcceptsImages('claude-sonnet-4-5', served('claude')), true);
    assert.strictEqual(await modelAcceptsImages('gpt-4o', served('openai')), true);
    assert.strictEqual(await modelAcceptsImages('mistral-medium-2508', served('mistral')), true);
    assert.strictEqual(await modelAcceptsImages('gemini-2.5-flash', served('google')), true);
});

test('a model without vision is refused', async () => {
    assert.strictEqual(await modelAcceptsImages('o3-mini', served('openai')), false);
    assert.strictEqual(await modelAcceptsImages('eugpt-auto', served('eugpt')), false);
});

test('unknown is no: no model, the generic adapter, or a failed lookup', async () => {
    assert.strictEqual(await modelAcceptsImages('', served('claude')), false);
    assert.strictEqual(await modelAcceptsImages('anything', served('totally-unknown-type')), false);
    const broken = { getProviderForModel: async () => { throw new Error('no provider'); }, getAdapter, baseAdapter };
    assert.strictEqual(await modelAcceptsImages('claude-sonnet-4-5', broken), false);
});

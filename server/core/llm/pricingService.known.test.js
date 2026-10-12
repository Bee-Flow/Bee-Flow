/**
 * DB-free tests — pricingService.listKnownPricing, the donor list for the estimate of an
 * unknown model. Without a fetched community file only the repo snapshots are there.
 *
 * Run: cd server && node --test core/llm/pricingService.known.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { listKnownPricing } = require('./pricingService');

test('lists the repo snapshots, each tagged with the provider that sells it', () => {
    const list = listKnownPricing();
    assert.ok(list.length > 0);
    const openai = list.filter((e) => e.vendor === 'openai');
    const claude = list.filter((e) => e.vendor === 'claude');
    assert.ok(openai.length > 0 && claude.length > 0);
    for (const e of list) {
        assert.strictEqual(typeof e.id, 'string');
        assert.ok(Number.isFinite(e.input) && Number.isFinite(e.output), e.id);
        assert.strictEqual(e.currency, 'USD');
        assert.strictEqual(e.source, 'repo');
    }
    assert.strictEqual(new Set(list.map((e) => e.id)).size, list.length, 'one entry per id');
});

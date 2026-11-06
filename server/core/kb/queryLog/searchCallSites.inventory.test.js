'use strict';

/**
 * Every call of a knowledge search function must be in searchCallSites.inventory.json, with the
 * query-log channel it logs under or `not-logged:<reason>`. A new search route fails here until
 * it says what happens to its log; a deleted call fails here until its entry goes too.
 *
 * Run: cd server && node --test core/kb/queryLog/searchCallSites.inventory.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { scanSearchCallSites } = require('./searchCallSites.scan.mts');
const { CHANNELS } = require('./vocab.mts');
const inventory = require('./searchCallSites.inventory.json');

const SERVER_ROOT = path.resolve(__dirname, '../../..');
// Package 2 (the channel hooks) flips this to true: every entry with a channel must then be hooked.
const REQUIRE_HOOKED = false;

const keyOf = (e) => `${e.file}::${e.fn}`;
const isNotLogged = (c) => typeof c === 'string' && c.startsWith('not-logged:');

test('every call site of a knowledge search function is in the inventory', () => {
    const listed = new Set(inventory.entries.map(keyOf));
    const missing = scanSearchCallSites(SERVER_ROOT).filter((k) => !listed.has(k));
    assert.deepEqual(missing, [], `unlisted search call sites (add them to searchCallSites.inventory.json): ${missing.join(', ')}`);
});

test('no inventory entry is stale', () => {
    const live = new Set(scanSearchCallSites(SERVER_ROOT));
    const stale = inventory.entries.map(keyOf).filter((k) => !live.has(k));
    assert.deepEqual(stale, [], `stale inventory entries (the call is gone): ${stale.join(', ')}`);
});

test('entries are unique, point at real files and use the closed channel vocabulary', () => {
    const seen = new Set();
    for (const e of inventory.entries) {
        const k = keyOf(e);
        assert.ok(!seen.has(k), `duplicate entry ${k}`);
        seen.add(k);
        assert.ok(fs.existsSync(path.join(SERVER_ROOT, e.file)), `${e.file} does not exist`);
        if (isNotLogged(e.channel)) {
            assert.ok(e.channel.length > 'not-logged:'.length + 8, `${k}: a not-logged entry needs a reason`);
        } else {
            assert.ok(CHANNELS.includes(e.channel), `${k}: unknown channel ${e.channel}`);
        }
        for (const c of e.alsoChannels || []) assert.ok(CHANNELS.includes(c), `${k}: unknown channel ${c}`);
        assert.equal(typeof e.hooked, 'boolean', `${k}: hooked must be a boolean`);
    }
});

test('every channel of the vocabulary has at least one call site', () => {
    const used = new Set();
    for (const e of inventory.entries) {
        if (!isNotLogged(e.channel)) used.add(e.channel);
        for (const c of e.alsoChannels || []) used.add(c);
    }
    const unused = CHANNELS.filter((c) => !used.has(c));
    assert.deepEqual(unused, [], `channels without a call site: ${unused.join(', ')}`);
});

test('once the hooks are in, every logged entry is hooked', { skip: !REQUIRE_HOOKED }, () => {
    const open = inventory.entries.filter((e) => !isNotLogged(e.channel) && !e.hooked).map(keyOf);
    assert.deepEqual(open, [], `search call sites without a log hook: ${open.join(', ')}`);
});

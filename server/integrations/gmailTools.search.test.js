'use strict';

/**
 * gmail_search against a fake Google client: metadata fetched ten at a time
 * as a partial response, and a message that could not be read is counted,
 * not silently dropped. Values fictional.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const seen = { active: 0, max: 0, args: [] };
const fake = {
    users: { messages: {
        list: async () => ({ data: { messages: Array.from({ length: 25 }, (_, i) => ({ id: `m${i}` })), resultSizeEstimate: 25 } }),
        get: async (args) => {
            seen.args.push(args);
            seen.active += 1;
            seen.max = Math.max(seen.max, seen.active);
            await new Promise(r => setTimeout(r, 2));
            seen.active -= 1;
            if (args.id === 'm7') throw new Error('rate limit');
            return { data: { id: args.id, snippet: 's', payload: { headers: [{ name: 'Subject', value: `S ${args.id}` }] } } };
        },
    } },
};
const { searchMessages } = require('./gmailTools');

test('search: ten at a time, partial responses, and an unreadable message is counted', async () => {
    const out = await searchMessages(fake, { query: 'factuur', maxResults: 25 });
    assert.equal(out.results.length, 24);
    assert.equal(out.unreadable, 1);
    assert.ok(seen.max <= 10, `at most ten at a time (saw ${seen.max})`);
    assert.equal(seen.args[0].fields, 'id,snippet,payload/headers');
    assert.equal(out.results[0].subject, 'S m0');
});

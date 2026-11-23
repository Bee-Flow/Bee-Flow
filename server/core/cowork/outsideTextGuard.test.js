/**
 * Outside text in a Cowork run that follows no plan (./outsideTextGuard.mts): once the run read a mail or the open web,
 * a call that sends to other people is held; drafts and the owner's own apps stay open. The lookups are handed in.
 *
 * Run: cd server && node --test core/cowork/outsideTextGuard.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { holdCall, createOutsideTextMark, readsOutsideText, OUTSIDE_TEXT_REFUSAL } = require('./outsideTextGuard.mts');
const { outsideTextRefusal, createRunActivity, summariseActivity } = require('./runActivity.mts');

const TOOLS = {
    outlook_search: ['outlook', 'reads'], outlook_create_draft: ['outlook', 'writes'], outlook_compose: ['outlook', 'sends'],
    drive_search: ['google-drive', 'reads'], drive_upload: ['google-drive', 'writes'], read_url: [null, 'reads'],
    nextcloud_talk_send_message: ['nextcloud-talk', 'sends'],
};
const lookups = {
    appOf: (n) => (TOOLS[n] ? TOOLS[n][0] : null),
    effectOf: (n) => (TOOLS[n] ? TOOLS[n][1] : 'writes'),
    isOpenWebRead: (n) => n === 'read_url',
};

test('a mailbox read and an open-web read are outside text; the owner\'s own files are not', () => {
    assert.deepStrictEqual(['outlook_search', 'read_url', 'drive_search', 'outlook_create_draft'].map((n) => readsOutsideText(n, lookups)), [true, true, false, false]);
});

test('before outside text, sending is open; after it, a send is held and a draft or a write is not', () => {
    const mark = createOutsideTextMark();
    assert.strictEqual(holdCall(mark, 'outlook_compose', lookups), null, 'nothing outside read yet');
    assert.strictEqual(holdCall(mark, 'drive_search', lookups), null);
    assert.strictEqual(mark.seen, false);
    assert.strictEqual(holdCall(mark, 'outlook_search', lookups), null, 'the read itself runs');
    assert.strictEqual(mark.seen, true);
    assert.strictEqual(holdCall(mark, 'outlook_compose', lookups), OUTSIDE_TEXT_REFUSAL);
    assert.strictEqual(holdCall(mark, 'nextcloud_talk_send_message', lookups), OUTSIDE_TEXT_REFUSAL);
    assert.strictEqual(holdCall(mark, 'outlook_create_draft', lookups), null, 'a draft for the owner stays possible');
    assert.strictEqual(holdCall(mark, 'drive_upload', lookups), null);
});

test('a web page read marks the run as much as a mail does', () => {
    const mark = createOutsideTextMark();
    holdCall(mark, 'read_url', lookups);
    assert.strictEqual(holdCall(mark, 'outlook_compose', lookups), OUTSIDE_TEXT_REFUSAL);
});

test('on a Cowork run\'s context: held for an ordinary run, never for a run a new mail started, never outside Cowork', () => {
    const ctx = createRunActivity({ appOf: () => null });
    outsideTextRefusal(ctx, 'read_url');
    assert.strictEqual(ctx.outsideText.seen, true);
    assert.ok(outsideTextRefusal(ctx, 'gmail_send_email') !== undefined);
    const mailRun = createRunActivity({ appOf: () => null });
    outsideTextRefusal(mailRun, 'read_url', { mailRun: true });
    assert.strictEqual(mailRun.outsideText.seen, false, 'a mail run has its own allow-list');
    assert.strictEqual(outsideTextRefusal(undefined, 'read_url'), null);
    assert.strictEqual(outsideTextRefusal({ kind: 'chat' }, 'read_url'), null);
});

test('the run\'s history says it read outside text, and only then', () => {
    const quiet = createRunActivity({ appOf: () => null });
    assert.strictEqual('readOutsideText' in summariseActivity(quiet, new Map()), false);
    const read = createRunActivity({ appOf: () => null });
    read.outsideText.seen = true;
    assert.strictEqual(summariseActivity(read, new Map()).readOutsideText, true);
});

test('after outside text, the open web and a tool nobody classified are held too: they could carry what the run read away', () => {
    const classified = { ...lookups, isClassified: (n) => n in TOOLS || n === 'cowork_request_review' };
    const mark = createOutsideTextMark();
    assert.strictEqual(holdCall(mark, 'read_url', classified), null, 'the first web read runs, and marks the run');
    assert.strictEqual(mark.seen, true);
    assert.strictEqual(holdCall(mark, 'read_url', classified), OUTSIDE_TEXT_REFUSAL, 'a second address is picked by a run that read outside text');
    assert.strictEqual(holdCall(mark, 'mcp__slack__post_message', classified), OUTSIDE_TEXT_REFUSAL, 'an MCP tool of unknown effect');
    assert.strictEqual(holdCall(mark, 'custom_crm_push', classified), OUTSIDE_TEXT_REFUSAL, 'a custom integration of unknown effect');
    assert.strictEqual(holdCall(mark, 'cowork_request_review', classified), null, 'asking the owner stays possible');
    assert.strictEqual(holdCall(mark, 'outlook_create_draft', classified), null, 'a draft for the owner stays possible');
});

test('with the real side-effect map: once marked, http_request, read_url, web_search and a public link are held', () => {
    const real = require('./outsideTextGuard.mts').defaultLookups();
    const mark = { seen: true };
    for (const n of ['http_request', 'read_url', 'web_search', 'nextcloud_direct_link', 'mcp__slack__post_message', 'gmail_compose']) {
        assert.strictEqual(holdCall(mark, n, real), OUTSIDE_TEXT_REFUSAL, n);
    }
    assert.strictEqual(holdCall(mark, 'cowork_request_review', real), null);
});

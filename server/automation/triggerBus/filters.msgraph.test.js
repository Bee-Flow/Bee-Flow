// @typecheck
/**
 * msgraph mail.new: `mailbox` picks the inbox, it is not a payload match,
 * except that an event only ever starts the automation that watches ITS
 * mailbox. The own inbox's webhook notification is fanned out to every msgraph
 * mail.new row of that user, and must never start a shared-mailbox automation.
 *
 * Run: cd server && node --test automation/triggerBus/filters.msgraph.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { pickMatcher, matchMsGraphMailFilter } = require('./filters');
const { applyDslFilter } = require('../triggers/dslFilters');

const own = { changeType: 'created', resourceData: { id: 'M1' }, mailbox: 'me' };
const shared = { changeType: 'created', resourceData: { id: 'M2' }, mailbox: 'team@contoso.com' };

test('mail.new has its own matcher; the other Microsoft events keep the generic one', () => {
    assert.strictEqual(pickMatcher('msgraph', 'mail.new'), matchMsGraphMailFilter);
    assert.notStrictEqual(pickMatcher('msgraph', 'mail.flagged'), matchMsGraphMailFilter);
});

test('an own-inbox event starts only own-inbox rows, a shared one only that mailbox\'s rows', () => {
    assert.strictEqual(matchMsGraphMailFilter(own, null), true);
    assert.strictEqual(matchMsGraphMailFilter(own, { mailbox: 'me' }), true);
    assert.strictEqual(matchMsGraphMailFilter(own, { mailbox: 'team@contoso.com' }), false);
    assert.strictEqual(matchMsGraphMailFilter(shared, { mailbox: 'Team@Contoso.com' }), true);
    assert.strictEqual(matchMsGraphMailFilter(shared, { mailbox: 'other@contoso.com' }), false);
    assert.strictEqual(matchMsGraphMailFilter(own, { mailbox: null }), true, 'null means the own inbox');
    assert.strictEqual(matchMsGraphMailFilter(shared, { mailbox: null }), false);
    // A pushed notification from before this change carries no mailbox: the own inbox.
    assert.strictEqual(matchMsGraphMailFilter({ changeType: 'created' }, null), true);
});

test('the other filter keys keep their exact-match meaning; a broken address never matches', () => {
    assert.strictEqual(matchMsGraphMailFilter(shared, { mailbox: 'team@contoso.com', changeType: 'created' }), true);
    assert.strictEqual(matchMsGraphMailFilter(shared, { mailbox: 'team@contoso.com', changeType: 'updated' }), false);
    assert.strictEqual(matchMsGraphMailFilter(shared, { mailbox: 'team' }), false);
});

test('the rich filter DSL still wraps it; an any/none entry without a mailbox does not re-check it', () => {
    assert.strictEqual(applyDslFilter(shared, { mailbox: 'team@contoso.com', expr: 'trigger.resourceData.id == "M2"' }, matchMsGraphMailFilter), true);
    assert.strictEqual(applyDslFilter(shared, { mailbox: 'team@contoso.com', expr: 'trigger.resourceData.id == "M9"' }, matchMsGraphMailFilter), false);
    assert.strictEqual(applyDslFilter(shared, { mailbox: 'team@contoso.com', any: [{ changeType: 'created' }] }, matchMsGraphMailFilter), true);
    assert.strictEqual(applyDslFilter(own, { mailbox: 'team@contoso.com', any: [{ changeType: 'created' }] }, matchMsGraphMailFilter), false);
});

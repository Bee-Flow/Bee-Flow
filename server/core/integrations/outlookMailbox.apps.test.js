// @typecheck strict
/**
 * The App Studio half of outlookMailbox.test.js: the mailbox connector
 * (appStudio/mailboxConnector.js, the apps module's) words a refusal exactly as the shared rule does.
 *
 * Run: cd server && node --test core/integrations/outlookMailbox.apps.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { sharedMailboxDeniedText } = require('./outlookMailbox.mts');
const { classifyMailboxError } = require('../../appStudio/mailboxConnector');

test('the wording is the App Studio connector\'s, word for word', () => {
    const fromConnector = classifyMailboxError({ status: 403 }, { mode: 'shared', address: 'team@contoso.com' });
    assert.strictEqual(fromConnector.message, sharedMailboxDeniedText('team@contoso.com'));
    assert.strictEqual(fromConnector.code, 'shared_mailbox_denied');
});

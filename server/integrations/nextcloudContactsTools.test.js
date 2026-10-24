// @typecheck
'use strict';

/**
 * nextcloud_contacts_list / _search over a CardDAV multistatus whose
 * address-data carries numeric character references (&#13; for CR), as
 * Nextcloud sends it.
 *
 * Run: cd server && node --test integrations/nextcloudContactsTools.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ncClient = require('./nextcloudClient');
const { executeNextcloudContactsTool } = require('./nextcloudContactsTools');

const BASE = 'https://nc.test';

function vcard(uid, fn, email) {
    return [
        'BEGIN:VCARD&#13;', 'VERSION:3.0&#13;', `UID:${uid}&#13;`, `FN:${fn}&#13;`,
        `N:Doe;Jane;;;&#13;`, `EMAIL;TYPE=INTERNET:${email}&#13;`, 'END:VCARD&#13;',
    ].join('\n');
}

const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:response><d:href>/remote.php/dav/addressbooks/users/u1/contacts/</d:href>
    <d:propstat><d:prop><d:getetag>"b"</d:getetag><card:address-data></card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/remote.php/dav/addressbooks/users/u1/contacts/abc.vcf</d:href>
    <d:propstat><d:prop><d:getetag>"e1"</d:getetag><card:address-data>${vcard('abc', 'Jane &amp; Co', 'jane@example.test')}</card:address-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
</d:multistatus>`;

async function run(tool, args) {
    const orig = ncClient.resolveAuth;
    ncClient.resolveAuth = async () => ({
        baseUrl: BASE, uid: 'u1', authError: 'AUTH',
        fetch: async () => ({ status: 207, ok: true, text: async () => MULTISTATUS }),
    });
    try {
        return await executeNextcloudContactsTool(tool, args, 'u1', {});
    } finally {
        ncClient.resolveAuth = orig;
    }
}

test('contacts_list parses address-data with &#13; and skips the collection row', async () => {
    const out = await run('nextcloud_contacts_list', {});
    assert.equal(out.count, 1);
    assert.equal(out.contacts[0].uid, 'abc');
    assert.equal(out.contacts[0].fullName, 'Jane & Co');
    assert.deepEqual(out.contacts[0].emails, ['jane@example.test']);
});

test('contacts_search finds a contact by e-mail', async () => {
    const out = await run('nextcloud_contacts_search', { query: 'jane@example', addressbook: 'contacts' });
    assert.equal(out.count, 1);
    assert.equal(out.contacts[0].uid, 'abc');
});

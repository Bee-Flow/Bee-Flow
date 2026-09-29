'use strict';

/**
 * The passive Nextcloud bell.
 *
 * Two behaviours are worth pinning, because getting either wrong turns a
 * diagnosable failure into a silent one:
 *
 *   • v3 → v2 fallback happens ONLY on 404/405 (this instance is below
 *     Nextcloud 30 and has no v3 route). A 403 means "you are not a Nextcloud
 *     admin", and retrying that on v2 just says the same thing twice while
 *     hiding the real reason behind the second error;
 *   • the deep link is smuggled into a rich-object parameter, because v3
 *     admin_notifications has no `link` field. Without the placeholder in the
 *     message string Nextcloud renders neither, and the notification arrives
 *     with nothing to click — which is the whole point of this channel.
 *
 * Run: cd server && node --test --test-force-exit integrations/nextcloudAdminNotify.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { sendAdminNotification, MAX_SUBJECT } = require('./nextcloudAdminNotify');

function recorder(responses) {
    const calls = [];
    const ncFetch = async (url, opts) => {
        calls.push({ url, opts });
        const r = responses[calls.length - 1] ?? { status: 200 };
        if (r.throws) throw new Error(r.throws);
        return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => null };
    };
    return { ncFetch, calls };
}

const BASE = { baseUrl: 'https://cloud.example', ncUid: 'ada', subject: 'Approval needed: Invoices', message: 'Pay it?' };

test('v3 carries the deep link as a rich object, since v3 has no link field', async () => {
    const { ncFetch, calls } = recorder([{ status: 200 }]);
    const res = await sendAdminNotification({ ...BASE, ncFetch, link: 'https://app.example/app/studio/approvals/apr_1' });
    assert.equal(res.ok, true);
    assert.equal(res.apiVersion, 'v3');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/apps\/notifications\/api\/v3\/admin_notifications\/ada/);
    assert.equal(calls[0].opts.headers['OCS-APIRequest'], 'true');

    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.subject, 'Approval needed: Invoices');
    // The placeholder must appear in the string it belongs to or Nextcloud
    // renders the raw text and drops the parameter entirely.
    assert.match(body.message, /\{open\}/);
    assert.equal(body.messageParameters.open.type, 'highlight');
    assert.equal(body.messageParameters.open.link, 'https://app.example/app/studio/approvals/apr_1');
    // Never an `actions` array: no external service can put buttons here.
    assert.equal(body.actions, undefined);
});

test('a 404 on v3 falls back to v2 form-encoded, link in the text', async () => {
    const { ncFetch, calls } = recorder([{ status: 404 }, { status: 200 }]);
    const res = await sendAdminNotification({ ...BASE, ncFetch, link: 'https://app.example/x' });
    assert.equal(res.ok, true);
    assert.equal(res.apiVersion, 'v2');
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/api\/v2\/admin_notifications\/ada/);
    assert.equal(calls[1].opts.headers['Content-Type'], 'application/x-www-form-urlencoded');
    const form = new URLSearchParams(calls[1].opts.body);
    assert.equal(form.get('shortMessage'), 'Approval needed: Invoices');
    assert.match(form.get('longMessage'), /https:\/\/app\.example\/x/);
});

test('a 403 is NOT retried on v2 — it means "not a Nextcloud admin"', async () => {
    const { ncFetch, calls } = recorder([{ status: 403 }]);
    const res = await sendAdminNotification({ ...BASE, ncFetch });
    assert.equal(res.ok, false);
    assert.equal(calls.length, 1, 'a second call would bury the real reason under a duplicate');
    assert.match(res.error, /admin/);
});

test('the subject is clamped to what Nextcloud accepts', async () => {
    const { ncFetch, calls } = recorder([{ status: 200 }]);
    await sendAdminNotification({ ...BASE, ncFetch, subject: 'x'.repeat(400) });
    const body = JSON.parse(calls[0].opts.body);
    assert.ok(body.subject.length <= MAX_SUBJECT, `subject was ${body.subject.length}`);
});

test('no identity and no subject are refused before any request', async () => {
    const { ncFetch, calls } = recorder([{ status: 200 }]);
    assert.equal((await sendAdminNotification({ ...BASE, ncFetch: null })).ok, false);
    assert.equal((await sendAdminNotification({ ...BASE, ncFetch, ncUid: null })).ok, false);
    assert.equal((await sendAdminNotification({ ...BASE, ncFetch, subject: '   ' })).ok, false);
    assert.equal(calls.length, 0);
});

test('a network failure is an answer, not a throw', async () => {
    const { ncFetch } = recorder([{ throws: 'ECONNREFUSED' }]);
    const res = await sendAdminNotification({ ...BASE, ncFetch });
    assert.equal(res.ok, false);
    assert.match(res.error, /ECONNREFUSED/);
});

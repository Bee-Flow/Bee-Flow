'use strict';

/**
 * Live mail with a fake executeTool: the calls the server makes, and what of
 * a message survives (a template, a pseudonym, flags; never an address, a
 * name, a domain or a snippet).
 *
 * Run: cd server && node --test automation/patterns/sources/mailLive.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const {
    collectGmail, collectOutlook, collectNextcloudMail, makeDomainPseudonymiser,
    mailTemplate, domainOf, registrable, bulkSender, pickMailboxes,
} = require('./mailLive');

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 3, 18, 0);
const iso = (d) => new Date(NOW - d * DAY).toISOString();

/** A fake executor answering per tool name (a function or a fixed value) and recording calls. */
function fakeExec(answers) {
    const calls = [];
    const exec = async (name, args) => {
        calls.push({ name, args });
        const a = answers[name];
        return typeof a === 'function' ? a(args) : a;
    };
    return { exec, calls };
}

const ctxWith = (exec, extra = {}) => ({
    now: NOW, since: NOW - 90 * DAY, windowDays: 90, executeTool: exec, pseudoDomain: makeDomainPseudonymiser(), ...extra,
});

const RAW = ['jan.devries', 'acme-supplies', 'Jan de Vries', 'secret snippet', 'm-123'];
function assertNoRaw(events) {
    const text = JSON.stringify(events);
    for (const raw of RAW) assert.ok(!text.includes(raw), `leaked ${raw}: ${text}`);
    assert.ok(!text.includes('@'), 'no address');
}

test('gmail: inbound and sent queries chosen by the server, capped', async () => {
    const { exec, calls } = fakeExec({
        gmail_search: ({ query }) => ({
            results: query.startsWith('in:sent')
                ? [{ id: 'm-123', to: 'Jan de Vries <jan.devries@acme-supplies.nl>', subject: 'Weekly report week 41', date: new Date(NOW - 2 * DAY).toUTCString(), snippet: 'secret snippet' }]
                : [
                    { id: 'm-123', from: 'Jan de Vries <jan.devries@acme-supplies.nl>', subject: 'RE: Invoice INV-2026-0042', date: new Date(NOW - DAY).toUTCString(), snippet: 'secret snippet', isBulk: false },
                    { id: 'm-124', from: 'News <noreply@mail.acme-supplies.nl>', subject: 'Our newsletter', date: new Date(NOW - DAY).toUTCString(), isBulk: true },
                    { id: 'm-125', from: 'x@y.nl', subject: 'Too old', date: new Date(NOW - 200 * DAY).toUTCString() },
                ],
        }),
    });
    const events = await collectGmail(ctxWith(exec));
    assert.deepStrictEqual(calls.map((c) => c.args), [
        { query: 'newer_than:90d -in:sent -in:drafts -in:chats -category:promotions -category:social', maxResults: 200 },
        { query: 'in:sent newer_than:90d', maxResults: 200 },
    ]);
    assert.strictEqual(events.length, 3, 'the old one is outside the window');
    const [inv, news, sent] = events;
    assert.deepStrictEqual([inv.verb, inv.direction, inv.template, inv.bulk, inv.domainPseudo], ['mail.received', 'in', 'Invoice <id>', false, 'd1']);
    assert.deepStrictEqual([news.bulk, news.domainPseudo], [true, 'd1'], 'subdomain shares the pseudonym');
    assert.deepStrictEqual([sent.verb, sent.direction, sent.template, sent.domainPseudo], ['mail.sent', 'out', 'Weekly report <date>', 'd1']);
    assert.ok(!('bulk' in sent), 'bulk is an inbound verdict');
    assertNoRaw(events);
});

test('outlook: inbox and sentitems since the window start, paged', async () => {
    const { exec, calls } = fakeExec({
        outlook_list_recent: ({ folder }) => ({
            results: [{ id: 'm-123', from: folder === 'inbox' ? 'Jan de Vries <jan.devries@acme-supplies.nl>' : '', to: folder === 'sentitems' ? 'jan.devries@acme-supplies.nl, b@other.org' : '', subject: '(no subject)', date: iso(3), snippet: 'secret snippet', hasAttachments: true }],
        }),
    });
    const events = await collectOutlook(ctxWith(exec));
    assert.deepStrictEqual(calls.map((c) => c.args), [
        { folder: 'inbox', since: iso(90), maxResults: 200, maxPages: 4 },
        { folder: 'sentitems', since: iso(90), maxResults: 200, maxPages: 4 },
    ]);
    assert.deepStrictEqual(events.map((e) => [e.direction, e.template, e.hasAttachment, e.domainPseudo]), [
        ['in', null, true, 'd1'],
        ['out', null, true, 'd1'],
    ]);
    assertNoRaw(events);
});

test('nextcloud mail: accounts, inbox + sent mailbox, window filter, junk dropped', async () => {
    const sec = (d) => Math.floor((NOW - d * DAY) / 1000);
    const { exec, calls } = fakeExec({
        nextcloud_mail_list_accounts: { accounts: [{ id: 7, email: 'me@own.nl' }] },
        nextcloud_mail_list_mailboxes: {
            mailboxes: [
                { id: 1, name: 'INBOX', specialRole: 'inbox' },
                { id: 2, name: 'Drafts', specialRole: 'drafts' },
                { id: 3, name: 'Verzonden items', specialRole: null },
            ],
        },
        nextcloud_mail_search: ({ mailboxId }) => ({
            messages: mailboxId === 1
                ? [
                    { id: 1, from: 'jan.devries@acme-supplies.nl', subject: 'Factuur 4711 van acme-supplies.nl', dateInt: sec(5), hasAttachments: true, flags: {} },
                    { id: 2, from: 'spam@x.nl', subject: 'Win', dateInt: sec(5), flags: { $junk: true } },
                    { id: 3, from: 'a@b.nl', subject: 'Old', dateInt: sec(100), flags: {} },
                ]
                : [{ id: 4, to: 'jan.devries@acme-supplies.nl', subject: 'Offerte', dateInt: sec(4), flags: {} }],
        }),
    });
    const events = await collectNextcloudMail(ctxWith(exec));
    assert.deepStrictEqual(calls.map((c) => [c.name, c.args]), [
        ['nextcloud_mail_list_accounts', {}],
        ['nextcloud_mail_list_mailboxes', { accountId: 7 }],
        ['nextcloud_mail_search', { mailboxId: 1, limit: 100 }],
        ['nextcloud_mail_search', { mailboxId: 3, limit: 100 }],
    ]);
    assert.deepStrictEqual(events.map((e) => [e.app, e.direction, e.template, e.domainPseudo]), [
        ['nextcloud_mail', 'in', 'Factuur <n> van <domain:d1>', 'd1'],
        ['nextcloud_mail', 'out', 'Offerte', 'd1'],
    ]);
    assertNoRaw(events);
});

test('a connector error object stops the source with a code', async () => {
    const { exec } = fakeExec({ nextcloud_mail_list_accounts: { error: 'Nextcloud authentication failed (401)' } });
    await assert.rejects(collectNextcloudMail(ctxWith(exec)), (err) => err.code === 'auth');
    const { exec: exec2 } = fakeExec({ gmail_search: { error: 'Quota exceeded' } });
    await assert.rejects(collectGmail(ctxWith(exec2)), (err) => err.code === 'error');
});

test('an aborted signal stops before the next call', async () => {
    const ac = new AbortController();
    const { exec, calls } = fakeExec({ gmail_search: () => { ac.abort(); return { results: [] }; } });
    await assert.rejects(collectGmail(ctxWith(exec, { signal: ac.signal })), (err) => err.code === 'aborted');
    assert.strictEqual(calls.length, 1);
});

test('domain helpers', () => {
    assert.strictEqual(registrable('Mail.Acme.COM'), 'acme.com');
    assert.strictEqual(registrable('billing.acme.co.uk'), 'acme.co.uk');
    assert.strictEqual(domainOf('"Jan" <jan@sub.acme.nl>, other@x.org'), 'acme.nl');
    assert.strictEqual(domainOf('no address'), null);
    assert.strictEqual(bulkSender('News <no-reply@acme.nl>'), true);
    assert.strictEqual(bulkSender('notifications+abc@service.io'), true);
    assert.strictEqual(bulkSender('invoices@acme.nl'), false);
    const p = makeDomainPseudonymiser();
    assert.deepStrictEqual([p('acme.nl'), p('other.org'), p('www.acme.nl')], ['d1', 'd2', 'd1']);
    assert.strictEqual(makeDomainPseudonymiser()('other.org'), 'd1', 'a new scan starts over');
});

test('mailTemplate pseudonymises spelled-out domains but keeps file names', () => {
    const p = makeDomainPseudonymiser();
    assert.strictEqual(mailTemplate('Invoice from shop.acme.com attached: invoice.pdf', p), 'Invoice from <domain:d1> attached: invoice.pdf');
    assert.strictEqual(mailTemplate('Contact jan@acme.com', p), 'Contact <email>');
    assert.strictEqual(mailTemplate('  ', p), null);
});

test('pickMailboxes: role first, then the usual names', () => {
    assert.deepStrictEqual(pickMailboxes([{ id: 5, name: 'Sent', specialRole: 'sent' }, { id: 4, name: 'INBOX' }]), [
        { id: 4, direction: 'in' }, { id: 5, direction: 'out' },
    ]);
    assert.deepStrictEqual(pickMailboxes([{ id: 9, name: 'Archive' }]), []);
    assert.deepStrictEqual(pickMailboxes(null), []);
});
